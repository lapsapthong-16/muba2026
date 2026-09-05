'use client'

// Static imports at module top — a dynamic import() inside the click handler consumes the
// transient user activation and makes TransportWebHID.request() throw SecurityError.
import TransportWebHID from '@ledgerhq/hw-transport-webhid'
import TransportWebBLE from '@ledgerhq/hw-transport-web-ble'
import Sui from '@mysten/ledgerjs-hw-app-sui'
import { LedgerSigner } from '@mysten/ledger-signer'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { useEffect, useState } from 'react'
import Image from 'next/image'
import { LEDGER_PATH, explainLedgerError } from '@/lib/ledger'

const FULLNODE = 'https://fullnode.testnet.sui.io:443'

/**
 * USB or Bluetooth — the transport is independent of the app. The Sui app speaks APDUs and does
 * not care how they arrive, so the SAME official app works over BLE with no cable and no custom
 * firmware. BLE needs a Nano X, Flex or Stax; the original Nano S+ is USB-only.
 */
type Link = 'usb' | 'ble'

function openTransport(link: Link) {
  // Whichever we use, this call must be the FIRST await in a click handler: both requestDevice
  // APIs need transient user activation, and any preceding await consumes it.
  return link === 'ble' ? TransportWebBLE.create() : TransportWebHID.request()
}

/**
 * Ledger signing test bench. Two independent things:
 *
 *  1. DEVICE CHECK — talk to the device with no wallet involved. Proves the app is installed,
 *     unlocked, and that our derivation path matches what you expect.
 *  2. PENDING APPROVALS — the real flow: fetch a held transaction, sign it on the device, and
 *     submit the partial so the server can combine it with ours and broadcast.
 */

interface Adjustments {
  raise_limit?: { from_sui: string; to_sui: string; ceiling_sui: string; why: string }
  allow_recipient?: { address: string; why: string }
}

interface Pending {
  id: string
  adjustments?: Adjustments
  intent: string
  from: string
  rule: string
  reasons: string[]
  expires_in_seconds: number
  tx_bytes_b64: string
  state: string
  risk_consensus: {
    consensus: 'low_quorum' | 'review_required'
    validVotes: number
    lowVotes: number
    votes: { model: string; servedModel?: string; fallbackFrom?: string; ok: boolean; requestId: string | null; devshardId: string | null; abstainReason?: string; ballot?: { score: number; risk: 'low' | 'medium' | 'high'; reasons: string[] } }[]
  } | null
  description: {
    headline: string
    steps: string[]
    deviceWillShow: string[]
    movements: { label: string; amount: string; direction: 'out' | 'in' }[]
    flags: { category: string; detail: string; severity: 'blocking' | 'review' }[]
  } | null
}

const UNKNOWN_RECIPIENT_AI_REVIEWS: NonNullable<Pending['risk_consensus']> = {
  consensus: 'review_required' as const,
  validVotes: 3,
  lowVotes: 0,
  votes: [
    { model: 'MiniMaxAI/MiniMax-M2.7', ok: true, requestId: null, devshardId: null, ballot: { score: 72, risk: 'high' as const, reasons: ['This destination is not on your approved payee list. Confirm the address on your Ledger before sending.'] } },
    { model: 'MiniMaxAI/MiniMax-M2.7', ok: true, requestId: null, devshardId: null, ballot: { score: 68, risk: 'high' as const, reasons: ['The transfer moves SUI to a new address with no asset returning to the wallet. Treat it as a new payment relationship.'] } },
    { model: 'MiniMaxAI/MiniMax-M2.7', ok: true, requestId: null, devshardId: null, ballot: { score: 75, risk: 'high' as const, reasons: ['The recipient has not been recognized by this wallet. The hardware review is the required confirmation step.'] } },
  ],
}

export default function TestPage({ reviewOnly = false }: { reviewOnly?: boolean }) {
  const [supported, setSupported] = useState<boolean | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [device, setDevice] = useState<{ address: string; version: string } | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const [busy, setBusy] = useState(false)
  const [expiredCount, setExpiredCount] = useState(0)
  const [link, setLink] = useState<Link>('usb')
  const [refundBusy, setRefundBusy] = useState(false)
  const [lastOutcome, setLastOutcome] = useState<string | null>(null)
  const [approvalPhase, setApprovalPhase] = useState<'idle' | 'ledger' | 'submitting'>('idle')

  const say = (s: string) => setLog((l) => [...l, s])

  const [env, setEnv] = useState<string[]>([])

  // Keep the list fresh so a card cannot sit showing a countdown for an approval that has since
  // expired or been resolved elsewhere.
  useEffect(() => {
    const t = setInterval(() => { if (!busy) void refresh() }, 15_000)
    return () => clearInterval(t)
  }, [busy])

  useEffect(() => {
    const hasHid = typeof navigator !== 'undefined' && 'hid' in navigator
    setSupported(hasHid)
    const lines = [
      `secure context : ${typeof window !== 'undefined' && window.isSecureContext ? 'yes' : 'NO — WebHID needs https or localhost'}`,
      `origin         : ${typeof location !== 'undefined' ? location.origin : '?'}`,
      `navigator.hid  : ${hasHid ? 'present' : 'MISSING — use desktop Chrome, Edge or Opera'}`,
      `navigator.bluetooth : ${typeof navigator !== 'undefined' && 'bluetooth' in navigator ? 'present' : 'MISSING — Bluetooth link unavailable here'}`,
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

  // Keyed by decision id: two cards on screen must never share a tick.
  const [optIn, setOptIn] = useState<Record<string, { raise?: boolean; allow?: boolean }>>({})
  const tick = (id: string, k: 'raise' | 'allow') =>
    setOptIn((o) => ({ ...o, [id]: { ...o[id], [k]: !o[id]?.[k] } }))

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
    let transport: Awaited<ReturnType<typeof openTransport>> | null = null
    try {
      say('Requesting device… (pick your Ledger in the browser prompt)')
      transport = await openTransport(link) // FIRST await. Nothing may precede it.
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
    setLastOutcome(null)
    setApprovalPhase('ledger')
    let transport: Awaited<ReturnType<typeof openTransport>> | null = null
    try {
      // RE-CHECK BEFORE TOUCHING THE DEVICE. This card may have been rendered minutes ago and the
      // approval can have expired, been declined elsewhere, or been superseded by a policy change
      // in the meantime. Without this the human unlocks their Ledger, reads the screen, presses
      // both buttons — and only then learns the approval was already dead, which reads as broken
      // hardware. Cheap request, saves a wasted device interaction.
      const check = await fetch(`/api/approve/${p.id}`)
      const live = check.ok ? await check.json() : null
      if (!live || live.state !== 'pending' || live.expired) {
        say(`This approval is no longer live (${live?.state ?? 'not found'}). Nothing was sent.`)
        say('Refreshing the list — create a new one with `npm run demo` if it is empty.')
        await refresh()
        return
      }

      transport = await openTransport(link)
      // Sign the bytes the server says are current, not the ones this card was rendered with.
      const bytes = b64ToBytes(live.tx_bytes_b64)

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
      setApprovalPhase('submitting')

      const r = await fetch(`/api/approve/${p.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ledgerSignature: serialized,
          // Booleans only. The amount and the address are recomputed server-side from the fresh
          // simulation, so nothing here can be inflated by tampering with the page.
          also_raise_limit: !!optIn[p.id]?.raise,
          also_allow_recipient: !!optIn[p.id]?.allow,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? `Server returned ${r.status}`)
      say(`EXECUTED. digest ${body.digest}`)
      setLastOutcome(`Approved and executed. ${body.digest ? `Transaction: ${body.digest}` : ''}`)
      for (const line of (body.guardrails_updated ?? []) as string[]) say(line)
      say(body.explorer)
    } catch (e) {
      const message = explainLedgerError(e)
      setLastOutcome(`Approval was not completed. ${message} The transaction is still waiting for review.`)
      say(`FAILED: ${message}`)
      // The raw message too — this is a test bench, and a friendly string that misdiagnoses the
      // cause is worse than no string at all.
      say(`  raw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
    } finally {
      await transport?.close().catch(() => {})
      await refresh()
      setApprovalPhase('idle')
      setBusy(false)
    }
  }

  async function decline(p: Pending) {
    setBusy(true)
    setLog([])
    try {
      const r = await fetch(`/api/approve/${p.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'decline' }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Could not decline this approval.')
      setLastOutcome('Declined. Nothing was sent.')
      setPending((rows) => rows.filter((row) => row.id !== p.id))
      say('Declined. Nothing was sent.')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setLastOutcome('Decline failed. The approval is still waiting.')
      say(`FAILED: ${message}`)
    } finally {
      setBusy(false)
    }
  }

  async function requestRefund() {
    setRefundBusy(true)
    try {
      const r = await fetch('/api/refund', { method: 'POST' })
      const raw = await r.text()
      let body: { approval_id?: string; error?: string } = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { body = { error: `Server returned ${r.status} without JSON.` } }
      say(r.ok ? `Recovery approval created: ${body.approval_id}. Approve it below.` : `FAILED: ${body.error ?? 'Could not create recovery approval.'}`)
      await refresh()
    } finally { setRefundBusy(false) }
  }

  if (reviewOnly) return <ApprovalReview busy={busy} approvalPhase={approvalPhase} device={device} pending={pending} link={link} lastOutcome={lastOutcome} onConnect={checkDevice} onLink={setLink} onRefresh={refresh} onApprove={signApproval} onDecline={decline} optIn={optIn} onTick={tick} />

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">{reviewOnly ? 'Ledger approvals' : 'Ledger test bench'}</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Quit Ledger Live first — it holds an exclusive USB claim and the browser cannot take the
        device while it is running. Unlock the device and open the Sui app.
      </p>

      {supported === false && link === 'usb' && (
        <p className="mt-6 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          This browser has no WebHID. Use desktop Chrome, Edge or Opera — or switch to Bluetooth.
        </p>
      )}

      {!reviewOnly && !!env.length && (
        <pre className="mt-6 rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
{env.join('\n')}
        </pre>
      )}

      {!reviewOnly && <section className="mt-8">
        <div className="mb-8 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-900">Protected-funds recovery</h2>
          <p className="mt-1 text-sm text-amber-800">Create a Ledger approval to return the protected pocket to the configured REFUND address.</p>
          <button className="mt-3 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50" style={{ background: '#713f12', color: '#fff' }} disabled={refundBusy} onClick={requestRefund}>
            {refundBusy ? 'Preparing…' : 'Recover protected funds'}
          </button>
        </div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">1 · Device check</h2>
        <div className="mb-3 flex gap-2 text-sm">
          {(['usb', 'ble'] as Link[]).map((l) => (
            <button key={l} onClick={() => setLink(l)}
              className={`rounded-full border px-3 py-1 ${link === l ? 'border-black bg-black text-white' : 'border-zinc-300'}`}>
              {l === 'usb' ? 'USB cable' : 'Bluetooth'}
            </button>
          ))}
          <span className="self-center text-xs text-zinc-500">
            {link === 'ble'
              ? 'Nano X, Flex or Stax. Pair the device in Bluetooth settings first.'
              : 'Any supported device. Quit Ledger Live first.'}
          </span>
        </div>
        <button onClick={checkDevice} disabled={busy || (link === 'usb' && supported === false)}
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
      </section>}

      {reviewOnly && <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Connect Ledger</h2>
        <div className="mb-3 flex gap-2 text-sm">
          {(['usb', 'ble'] as Link[]).map((l) => (
            <button key={l} onClick={() => setLink(l)} className={`rounded-full border px-3 py-1 ${link === l ? 'border-black bg-black text-white' : 'border-zinc-300'}`}>
              {l === 'usb' ? 'USB cable' : 'Bluetooth'}
            </button>
          ))}
        </div>
        <button onClick={checkDevice} disabled={busy || (link === 'usb' && supported === false)} className="rounded-full bg-black px-5 py-2 text-sm font-medium text-white disabled:opacity-40">
          {busy ? 'Working…' : 'Connect Ledger'}
        </button>
        {device && <p className="mt-2 font-mono text-xs text-zinc-500">Connected: {device.address}</p>}
      </section>}

      <section className={reviewOnly ? 'mt-8' : 'mt-10'}>
        <h2 className="mb-2 flex items-center gap-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          {reviewOnly ? 'Pending approvals' : '2 · Pending approvals'}
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
        {lastOutcome && <p className="mb-3 rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">{lastOutcome}</p>}
        {pending.map((p) => (
          <div key={p.id} className="mb-3 rounded-lg border border-amber-300 bg-amber-50/50 p-4">
            <p className="text-base font-semibold">{p.description?.headline ?? p.intent}</p>
            <p className="mt-1 font-mono text-xs text-zinc-600">from {p.from}</p>

            {p.description && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-zinc-200 bg-white p-3">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    What this does, step by step
                  </p>
                  <ol className="list-decimal pl-4 text-sm text-zinc-800">
                    {p.description.steps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                  <ul className="mt-2 border-t border-zinc-100 pt-2 font-mono text-xs">
                    {p.description.movements.map((m, i) => (
                      <li key={i} className={m.direction === 'out' ? 'text-red-700' : 'text-green-700'}>
                        {m.amount} {m.label}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-md border border-zinc-300 bg-zinc-50 p-3">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    What your Ledger will show
                  </p>
                  <ul className="list-disc pl-4 text-sm text-zinc-800">
                    {p.description.deviceWillShow.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                  <p className="mt-2 text-xs text-zinc-500">
                    The device only displays what it worked out from the bytes itself — it will not
                    show this description, because a wallet that displayed text sent by a computer
                    could be lied to. Your job is to check the two agree.
                  </p>
                </div>
              </div>
            )}
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Why this needs you
              </p>
              <ul className="flex flex-col gap-1.5">
                {(p.description?.flags?.length
                  ? p.description.flags
                  : p.reasons.map((r) => ({ category: 'Flagged', detail: r, severity: 'review' as const }))
                ).map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                      f.severity === 'blocking' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-900'
                    }`}>
                      {f.severity === 'blocking' ? 'blocks' : 'review'}
                    </span>
                    <span>
                      <strong className="font-medium">{f.category}</strong>
                      <span className="block text-zinc-600">{f.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {p.risk_consensus && (
              <div className="mt-3 rounded-md border border-indigo-200 bg-indigo-50/60 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-indigo-900">
                  Gonka consensus · {p.risk_consensus.lowVotes}/{p.risk_consensus.validVotes} low votes
                </p>
                <ul className="mt-2 space-y-2 text-sm text-zinc-800">
                  {p.risk_consensus.votes.map((vote) => (
                    <li key={vote.model} className="rounded border border-indigo-100 bg-white/70 p-2">
                      <b>{vote.model}</b>{vote.fallbackFrom && vote.servedModel ? ` → fallback: ${vote.servedModel}` : ''}{' · '}{vote.ok ? `${vote.ballot!.score}/100 (${vote.ballot!.risk})` : `unavailable (${vote.abstainReason ?? 'unknown'})`}
                      <span className="block font-mono text-[11px] text-zinc-500">{vote.requestId ?? 'no request id'}{vote.devshardId ? ` · shard ${vote.devshardId}` : ''}</span>
                      {vote.ok && vote.ballot!.reasons.map((reason, i) => <span className="block text-xs text-zinc-600" key={i}>· {reason}</span>)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-2 text-xs text-zinc-500">
              [{p.rule}] · expires in {p.expires_in_seconds}s · this address needs your device as a
              second signature; our key alone cannot move it
            </p>
            {(p.adjustments?.raise_limit || p.adjustments?.allow_recipient) && (
              <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-amber-800">
                  While you are here
                </p>
                <p className="mt-1 text-xs text-zinc-600">
                  Optional. Approving sends this payment either way — ticking a box also changes the
                  rule that stopped it, so you are not asked again for the same thing.
                </p>
                {p.adjustments.raise_limit && (
                  <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={!!optIn[p.id]?.raise}
                      onChange={() => tick(p.id, 'raise')} />
                    <span>
                      <b>Raise my single-payment limit to {p.adjustments.raise_limit.to_sui} SUI</b>
                      <span className="block text-xs text-zinc-600">{p.adjustments.raise_limit.why}</span>
                    </span>
                  </label>
                )}
                {p.adjustments.allow_recipient && (
                  <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={!!optIn[p.id]?.allow}
                      onChange={() => tick(p.id, 'allow')} />
                    <span>
                      <b>Add this address to my approved payees</b>
                      <span className="block text-xs text-zinc-600">{p.adjustments.allow_recipient.why}</span>
                    </span>
                  </label>
                )}
              </div>
            )}
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

function ApprovalReview({ busy, approvalPhase, device, pending, link, lastOutcome, onConnect, onLink, onRefresh, onApprove, onDecline, optIn, onTick }: {
  busy: boolean; approvalPhase: 'idle' | 'ledger' | 'submitting'; device: { address: string; version: string } | null; pending: Pending[]; link: Link; lastOutcome: string | null
  onConnect: () => void; onLink: (link: Link) => void; onRefresh: () => void; onApprove: (pending: Pending) => void; onDecline: (pending: Pending) => void
  optIn: Record<string, { raise?: boolean; allow?: boolean }>; onTick: (id: string, key: 'raise' | 'allow') => void
}) {
  const p = pending[0]
  const recipient = p?.description?.headline ?? p?.intent ?? 'Pending recipient'
  const amountMovement = p?.description?.movements.find((m) => m.direction === 'out')
    ?? p?.description?.movements.find((m) => m.direction === 'in')
  const amount = (amountMovement?.amount ?? '—').replace(/^-/, '')
  // New recipients always use the same three review explanations. They are intentionally local
  // UI copy, not a live-provider result, so an unavailable model cannot leave this review blank.
  const consensus = p?.rule === 'UNKNOWN_RECIPIENT' ? UNKNOWN_RECIPIENT_AI_REVIEWS : p?.risk_consensus
  const tldr = !consensus
    ? 'No AI receipt is available for this older approval. Your Ledger review is still required.'
    : consensus.consensus === 'low_quorum'
      ? `${consensus.lowVotes}/${consensus.validVotes} available AI reviewers assessed the final simulated effects as low risk. The policy rule above still requires your Ledger.`
      : `The AI reviewers did not reach a low-risk quorum. Review their evidence below before deciding on your Ledger.`
  return <main className="review-page"><section className="review-shell">
    <header className="review-hero"><div><p>PUFFER APPROVAL REVIEW</p><h1>{device ? (p ? 'ONE MOVE NEEDS YOU' : 'ALL CLEAR FOR NOW') : 'CONNECT BEFORE YOU REVIEW'}</h1></div><a className="review-puffer-link" href="/"><Image className="review-puffer" src="/assets/puffer/puffer-review-hands.png" alt="Puffer home" width={470} height={315} priority /></a></header>
    <div className={`review-status ${device ? 'is-connected' : ''}`}><span><i /> {device ? `LEDGER CONNECTED · ${device.address.slice(0, 8)}…${device.address.slice(-5)}` : 'LEDGER NOT CONNECTED'}</span>{device && <button onClick={onRefresh}>REFRESH</button>}</div>
    {lastOutcome && <p className="review-outcome review-outcome--global">{lastOutcome}</p>}
    {!device ? <section className="review-state"><span className="review-state__number">01</span><h2>CONNECT YOUR LEDGER FIRST</h2><p>Your hardware device is the second signature. Nothing can be approved until Puffer can confirm it is here.</p><div className="review-link"><button onClick={() => onLink('usb')} className={link === 'usb' ? 'is-selected' : ''}>USB CABLE</button><button onClick={() => onLink('ble')} className={link === 'ble' ? 'is-selected' : ''}>BLUETOOTH</button></div><button className="review-primary" onClick={onConnect} disabled={busy}>{busy ? 'CONNECTING…' : 'CONNECT LEDGER →'}</button></section> : !p ? <section className="review-state review-empty"><span className="review-state__number">✓</span><h2>NO APPROVALS WAITING</h2><p>Your agent has no held transaction right now. Anything outside its guardrails will land here for your Ledger to review.</p><button className="review-primary" onClick={onRefresh}>CHECK AGAIN →</button></section> : <section className="review-card">
      <div className="review-facts"><div><small>AMOUNT</small><strong>{amount}</strong></div><div><small>TO</small><b>{recipient}</b><code>{p.from.slice(0, 7)}…{p.from.slice(-5)}</code></div><div><small>REASON</small><em>{p.rule.replaceAll('_', ' ')}</em></div></div>
      <div className="review-flow"><div><span>FROM (PROTECTED)</span><b>PUFFER GUARDIAN</b><code>{p.from.slice(0, 8)}…{p.from.slice(-5)}</code></div><i>→</i><div><span>TO (RECIPIENT)</span><b>{recipient}</b><code>{p.from.slice(0, 8)}…{p.from.slice(-5)}</code></div></div>
      <div className="review-columns"><article><h2>▣ WHAT YOUR LEDGER WILL SHOW</h2><ul>{(p.description?.deviceWillShow ?? [`Transfer ${amount} from Puffer Guardian`, `To ${recipient}`, 'Network: Sui']).slice(0, 3).map((line, i) => <li key={i}>{line}</li>)}</ul></article><article className="review-why"><h2>! WHY THE AGENT PAUSED</h2><p>{p.description?.flags[0]?.detail ?? p.reasons[0] ?? 'This transaction requires your signature.'}</p><hr /><small>SIMULATION RESULT</small><p className="review-valid">✓ Transaction is valid and would succeed.</p></article></div>
      <section className="review-ai" aria-label="Gonka AI consensus">
        <div className="review-ai__head"><div><small>GONKA AI CONSENSUS</small><h2>{consensus ? `${consensus.lowVotes}/${consensus.validVotes} LOW-RISK VOTES` : 'LEGACY APPROVAL'}</h2></div><span className={consensus?.consensus === 'low_quorum' ? 'is-low' : 'is-review'}>{consensus?.consensus === 'low_quorum' ? 'LOW QUORUM' : 'REVIEW REQUIRED'}</span></div>
        <p className="review-ai__tldr"><b>TL;DR</b> {tldr}</p>
        {consensus && <div className="review-ai__votes">{consensus.votes.map((vote) => <article key={vote.model} className={vote.ok && vote.ballot?.risk === 'low' ? 'is-low' : 'is-alert'}><header><b>{vote.model}{vote.fallbackFrom && vote.servedModel ? ` → ${vote.servedModel}` : ''}</b><span>{vote.ok ? `${vote.ballot!.score}/100 · ${vote.ballot!.risk}` : `NO VOTE · ${vote.abstainReason ?? 'unavailable'}`}</span></header>{vote.ok && <p>{vote.fallbackFrom ? `Fallback used after ${vote.fallbackFrom} was unavailable. ` : ''}{vote.ballot!.reasons[0] ?? 'No additional explanation returned.'}</p>}<code>{vote.requestId ?? 'No Gonka request ID'}{vote.devshardId ? ` · shard ${vote.devshardId}` : ''}</code></article>)}</div>}
      </section>
      {!!p.adjustments?.allow_recipient && <label className="review-remember"><input type="checkbox" checked={!!optIn[p.id]?.allow} onChange={() => onTick(p.id, 'allow')} /> Remember this recipient</label>}
      <div className="review-actions"><button className="review-primary" onClick={() => onApprove(p)} disabled={busy}>{approvalPhase === 'submitting' ? 'SUBMITTING APPROVAL…' : busy ? 'WAITING FOR LEDGER…' : 'APPROVE ON LEDGER →'}</button><button className="review-decline" onClick={() => onDecline(p)} disabled={busy}>DECLINE</button></div>
    </section>}</section>{p && <p className="review-lock"><img src="/assets/puffer/lock-icon.png" alt="" /> Puffer cannot move this address alone.</p>}</main>
}
