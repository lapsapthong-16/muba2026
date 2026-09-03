'use client'

// Static imports at module top — a dynamic import() inside the click handler consumes the
// transient user activation and makes TransportWebHID.request() throw SecurityError.
import TransportWebHID from '@ledgerhq/hw-transport-webhid'
import Sui from '@mysten/ledgerjs-hw-app-sui'
import { LedgerSigner } from '@mysten/ledger-signer'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { useEffect, useState } from 'react'
import { LEDGER_PATH, explainLedgerError } from '@/lib/ledger'

const FULLNODE = 'https://fullnode.testnet.sui.io:443'

/**
 * Ledger signing test bench. Two independent things:
 *
 *  1. DEVICE CHECK — talk to the device with no wallet involved. Proves the app is installed,
 *     unlocked, and that our derivation path matches what you expect.
 *  2. PENDING APPROVALS — the real flow: fetch a held transaction, sign it on the device, and
 *     submit the partial so the server can combine it with ours and broadcast.
 */

interface Pending {
  id: string
  intent: string
  from: string
  rule: string
  reasons: string[]
  expires_in_seconds: number
  tx_bytes_b64: string
  state: string
}

export default function TestPage() {
  const [supported, setSupported] = useState<boolean | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [device, setDevice] = useState<{ address: string; version: string } | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const [busy, setBusy] = useState(false)
  const [expiredCount, setExpiredCount] = useState(0)

  const say = (s: string) => setLog((l) => [...l, s])

  const [env, setEnv] = useState<string[]>([])

  useEffect(() => {
    const hasHid = typeof navigator !== 'undefined' && 'hid' in navigator
    setSupported(hasHid)
    const lines = [
      `secure context : ${typeof window !== 'undefined' && window.isSecureContext ? 'yes' : 'NO — WebHID needs https or localhost'}`,
      `origin         : ${typeof location !== 'undefined' ? location.origin : '?'}`,
      `navigator.hid  : ${hasHid ? 'present' : 'MISSING — use desktop Chrome, Edge or Opera'}`,
    ]
    setEnv(lines)
    if (hasHid) {
      // Devices this origin has ALREADY been granted. If a Ledger shows here but the picker is
      // empty, the device is being held by something else — nearly always Ledger Live.
      ;(navigator as unknown as { hid: { getDevices(): Promise<{ productName: string }[]> } }).hid
        .getDevices()
        .then((ds) =>
          setEnv((e) => [...e, `paired already : ${ds.length ? ds.map((d) => d.productName).join(', ') : 'none yet (normal on first run)'}`])
        )
        .catch(() => {})
    }
    void refresh()
  }, [])

  async function refresh() {
    const r = await fetch('/api/setup/state')
    if (!r.ok) return say('No session — open your setup link first.')
    const s = await r.json()
    setExpiredCount(s.expired_count ?? 0)
    const ids: string[] = s.pending_ids ?? []
    const rows = await Promise.all(
      ids.map(async (id) => {
        const rr = await fetch(`/api/approve/${id}`)
        return rr.ok ? ((await rr.json()) as Pending) : null
      })
    )
    setPending(rows.filter((x): x is Pending => !!x && x.state === 'pending'))
  }

  /** 1. Device check — no wallet, no transaction. Just: is the thing reachable? */
  async function checkDevice() {
    setBusy(true)
    setLog([])
    let transport: Awaited<ReturnType<typeof TransportWebHID.request>> | null = null
    try {
      say('Requesting device… (pick your Ledger in the browser prompt)')
      transport = await TransportWebHID.request() // FIRST await. Nothing may precede it.
      const app = new Sui(transport)
      const v = await app.getVersion()
      say(`Sui app version ${v.major}.${v.minor}.${v.patch}`)
      say(`Deriving ${LEDGER_PATH} — confirm the address on your device…`)
      const { publicKey, address } = await app.getPublicKey(LEDGER_PATH, true)
      const addr = hex(address)
      say(`Device address: ${addr}`)
      say(`Public key (${publicKey.length} bytes): ${hex(publicKey).slice(0, 22)}…`)
      setDevice({ address: addr, version: `${v.major}.${v.minor}.${v.patch}` })
      say('Device OK.')
    } catch (e) {
      say(`FAILED: ${explainLedgerError(e)}`)
      // The raw message too — this is a test bench, and a friendly string that misdiagnoses the
      // cause is worse than no string at all.
      say(`  raw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
    } finally {
      await transport?.close().catch(() => {})
      setBusy(false)
    }
  }

  /** 2. Sign a real pending approval and submit the partial. */
  async function signApproval(p: Pending) {
    setBusy(true)
    setLog([])
    let transport: Awaited<ReturnType<typeof TransportWebHID.request>> | null = null
    try {
      transport = await TransportWebHID.request()
      const bytes = b64ToBytes(p.tx_bytes_b64)

      // Use the OFFICIAL signer rather than driving the app class by hand. It does three things
      // that are easy to get wrong and silently fatal:
      //   1. messageWithIntent('TransactionData', bytes) — the device signs the INTENT-PREFIXED
      //      message, not the raw transaction. Passing raw bytes produces a signature that does
      //      not verify AND makes the on-device parser misread the leading bytes as the intent
      //      header, so it garbles the parse and falls back to blind signing.
      //   2. Resolves the input objects' BCS so the device can render amounts instead of a hash.
      //   3. toSerializedSignature, giving the flag‖sig‖pubkey form the multisig combiner needs.
      const client = new SuiGrpcClient({ network: 'testnet', baseUrl: FULLNODE })
      const signer = await LedgerSigner.fromDerivationPath(LEDGER_PATH, new Sui(transport), client)

      const onDevice = signer.getPublicKey().toSuiAddress()
      say(`Device key: ${onDevice}`)
      say(`Sending ${bytes.length} bytes. Read the screen and approve.`)

      const { signature: serialized } = await signer.signTransaction(bytes)
      say(`Signed. Partial is ${serialized.length} chars.`)
      say('Submitting the partial signature…')

      const r = await fetch(`/api/approve/${p.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ledgerSignature: serialized }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? `Server returned ${r.status}`)
      say(`EXECUTED. digest ${body.digest}`)
      say(body.explorer)
      await refresh()
    } catch (e) {
      say(`FAILED: ${explainLedgerError(e)}`)
      // The raw message too — this is a test bench, and a friendly string that misdiagnoses the
      // cause is worse than no string at all.
      say(`  raw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
    } finally {
      await transport?.close().catch(() => {})
      setBusy(false)
    }
  }

  async function decline(p: Pending) {
    await fetch(`/api/approve/${p.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'decline' }),
    })
    say('Declined. Nothing was sent.')
    await refresh()
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Ledger test bench</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Quit Ledger Live first — it holds an exclusive USB claim and the browser cannot take the
        device while it is running. Unlock the device and open the Sui app.
      </p>

      {supported === false && (
        <p className="mt-6 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          This browser has no WebHID. Use desktop Chrome, Edge or Opera.
        </p>
      )}

      {!!env.length && (
        <pre className="mt-6 rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
{env.join('\n')}
        </pre>
      )}

      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">1 · Device check</h2>
        <button onClick={checkDevice} disabled={busy || supported === false}
          className="rounded-full bg-black px-5 py-2 text-sm font-medium text-white disabled:opacity-40">
          {busy ? 'Working…' : 'Check my Ledger'}
        </button>
        {device && (
          <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-1 font-mono text-xs">
            <dt className="text-zinc-500">app version</dt><dd>{device.version}</dd>
            <dt className="text-zinc-500">address</dt><dd className="break-all">{device.address}</dd>
            <dt className="text-zinc-500">path</dt><dd>{LEDGER_PATH}</dd>
          </dl>
        )}
      </section>

      <section className="mt-10">
        <h2 className="mb-2 flex items-center gap-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          2 · Pending approvals
          <button onClick={refresh} className="rounded border border-zinc-300 px-2 py-0.5 text-xs normal-case tracking-normal">
            refresh
          </button>
        </h2>
        {!pending.length && (
          <div className="text-sm text-zinc-500">
            <p>None waiting. Have the agent attempt something over your limit, then refresh.</p>
            {expiredCount > 0 && (
              <p className="mt-2 rounded-md bg-amber-50 p-3 text-amber-900">
                {expiredCount} approval{expiredCount > 1 ? 's' : ''} expired before being signed.
                Approvals are only valid for 30 minutes — create a fresh one with{' '}
                <code className="font-mono">npm run demo</code> and approve it while it is still live.
                This is not a device problem.
              </p>
            )}
          </div>
        )}
        {pending.map((p) => (
          <div key={p.id} className="mb-3 rounded-lg border border-amber-300 bg-amber-50/50 p-4">
            <p className="font-medium">{p.intent}</p>
            <p className="mt-1 font-mono text-xs text-zinc-600">from {p.from}</p>
            <ul className="mt-2 list-disc pl-5 text-sm text-zinc-800">
              {p.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
            <p className="mt-2 text-xs text-zinc-500">
              [{p.rule}] · expires in {p.expires_in_seconds}s · this address needs your device as a
              second signature; our key alone cannot move it
            </p>
            <div className="mt-3 flex gap-2">
              <button onClick={() => signApproval(p)} disabled={busy}
                className="rounded-full bg-black px-4 py-1.5 text-sm text-white disabled:opacity-40">
                Approve on Ledger
              </button>
              <button onClick={() => decline(p)} disabled={busy}
                className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm disabled:opacity-40">
                Decline
              </button>
            </div>
          </div>
        ))}
      </section>

      {!!log.length && (
        <pre className="mt-8 overflow-x-auto whitespace-pre-wrap rounded-lg bg-zinc-900 p-4 font-mono text-xs text-zinc-100">
{log.join('\n')}
        </pre>
      )}
    </main>
  )
}

const hex = (b: Uint8Array) => '0x' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
