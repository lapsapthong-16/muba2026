'use client'

// STATIC imports, at module top, deliberately.
//
// navigator.hid.requestDevice() requires TRANSIENT USER ACTIVATION, and ANY preceding await in the
// click handler consumes it — including a dynamic import(). On a cold module cache, which is
// exactly the first time anyone clicks this button, awaiting the import inside the handler throws
// SecurityError: "Must be handling a user gesture". So the modules load with the page, and
// TransportWebHID.request() is the FIRST await in the handler below.
import TransportWebHID from '@ledgerhq/hw-transport-webhid'
import Sui from '@mysten/ledgerjs-hw-app-sui'
import { useEffect, useState } from 'react'
import { LEDGER_PATH, explainLedgerError } from '@/lib/ledger'

type State =
  | { s: 'idle' }
  | { s: 'connecting'; note: string }
  | { s: 'confirm'; address: string }
  | { s: 'done'; h: string; m: string }
  | { s: 'error'; message: string }

export default function LedgerConnect({ onEnrolled }: { onEnrolled?: () => void }) {
  const [supported, setSupported] = useState<boolean | null>(null)
  const [state, setState] = useState<State>({ s: 'idle' })

  // Feature-detect in an effect: navigator.hid is undefined during SSR, and rendering the button
  // in a browser that cannot use it is worse than not offering it.
  useEffect(() => {
    setSupported(typeof navigator !== 'undefined' && 'hid' in navigator)
  }, [])

  async function connect() {
    setState({ s: 'connecting', note: 'Select your device in the browser prompt…' })
    let transport: Awaited<ReturnType<typeof TransportWebHID.request>> | null = null
    try {
      // FIRST await. Nothing may precede it — not a fetch, not an import, not a setState flush.
      transport = await TransportWebHID.request()

      const app = new Sui(transport)
      setState({ s: 'connecting', note: 'Confirm the address on your Ledger…' })

      // displayOnDevice = true: the human physically confirms the address on the hardware screen,
      // which is what makes this proof of possession rather than a value we simply read.
      const { publicKey, address } = await app.getPublicKey(LEDGER_PATH, true)

      const suiPublicKey = toSuiPublicKeyB64(publicKey)
      const deviceAddress = normalise(address)
      setState({ s: 'confirm', address: deviceAddress })

      const res = await fetch('/api/setup/ledger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suiPublicKey, deviceAddress, derivationPath: LEDGER_PATH }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `Server returned ${res.status}`)
      setState({ s: 'done', h: body.spending_address, m: body.protected_address })
      onEnrolled?.()
    } catch (e) {
      setState({ s: 'error', message: explainLedgerError(e) })
    } finally {
      await transport?.close().catch(() => {})
    }
  }

  if (supported === null) return null
  if (!supported) {
    return (
      <p className="setup-ledger-note setup-ledger-note--warning">
        This browser cannot talk to a Ledger. Open this page in desktop Chrome, Edge or Opera —
        Safari and Firefox do not implement WebHID.
      </p>
    )
  }

  return (
    <div className="setup-ledger-connect">
      {state.s === 'done' ? (
        <div className="setup-ledger-done">
          <p>✓ LEDGER CONNECTED</p>
          <dl>
            <dt>Spending (1-of-2)</dt><dd className="break-all">{state.h}</dd>
            <dt>Protected (2-of-2)</dt><dd className="break-all">{state.m}</dd>
          </dl>
          <p>
            Your agent spends from the first address on its own. Anything flagged has to move from
            the second, which needs your device.
          </p>
        </div>
      ) : (
        <>
          <button
            onClick={connect}
            disabled={state.s === 'connecting'}
            className="setup-ledger-button"
          >
            {state.s === 'connecting' ? 'Waiting for your Ledger…' : 'Connect Ledger'}
          </button>
          {state.s === 'connecting' && <p className="setup-ledger-note">{state.note}</p>}
          {state.s === 'confirm' && (
            <p className="setup-device-address">Device address: {state.address}</p>
          )}
          {state.s === 'error' && <p className="setup-ledger-note setup-ledger-note--error">{state.message}</p>}
          <p className="setup-ledger-help">
            Unlock the device and open the Sui app first. Your Ledger holds a key this server has
            never seen — it is the second signature on anything the risk check flags.
          </p>
        </>
      )}
    </div>
  )
}

/** The device returns a raw 32-byte Ed25519 key; Sui's serialised form prefixes the scheme flag 0x00. */
function toSuiPublicKeyB64(publicKey: Uint8Array | string): string {
  const raw = typeof publicKey === 'string' ? hexToBytes(publicKey) : publicKey
  const key = raw.length === 33 ? raw.slice(1) : raw // some firmwares already include the flag
  const out = new Uint8Array(33)
  out[0] = 0x00
  out.set(key, 1)
  return btoa(String.fromCharCode(...out))
}

function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith('0x') ? h.slice(2) : h
  return new Uint8Array(s.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [])
}

function normalise(a: string | Uint8Array): string {
  if (typeof a !== 'string') return '0x' + Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('')
  return a.startsWith('0x') ? a : '0x' + a
}
