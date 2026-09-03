'use client'

import { useEffect, useState } from 'react'

interface Recipient { address: string; label: string }

export default function Guardrails() {
  const [perTx, setPerTx] = useState(1)
  const [weekly, setWeekly] = useState(10)
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [draft, setDraft] = useState({ address: '', label: '' })
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    ;(async () => {
      const r = await fetch('/api/setup/state')
      if (!r.ok) return setError('Open your setup link first.')
      const s = await r.json()
      setReady(!!s.ledger_address)
      if (s.policy) {
        const cap = s.policy.caps[0]
        setPerTx(Number(cap.perTxLimit) / 1e9)
        setWeekly(Number(cap.weeklyLimit) / 1e9)
        setRecipients(s.policy.allowedRecipients ?? [])
      }
    })()
  }, [])

  async function save() {
    setError(null)
    const r = await fetch('/api/setup/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ perTxSui: perTx, weeklySui: weekly, allowedRecipients: recipients }),
    })
    const b = await r.json()
    if (!r.ok) return setError(b.error ?? 'Could not save.')
    setSaved(`Saved. Version ${b.policy_version}.`)
    setTimeout(() => setSaved(null), 4000)
  }

  const overWeekly = perTx > weekly

  return (
    <main className="mx-auto max-w-2xl px-6 py-14 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Guardrails</h1>
      <p className="mt-2 mb-8 text-sm text-zinc-600">
        These bind your agent. Anything that trips them stops and waits for your Ledger — and the
        weekly cap is a hard ceiling that a hardware approval cannot widen.
      </p>

      {!ready && <p className="mb-6 rounded-md bg-amber-50 p-3 text-sm text-amber-900">Connect your Ledger on the setup page first.</p>}

      <fieldset className="mb-8" disabled={!ready}>
        <label className="block text-sm font-medium">Single payment limit</label>
        <p className="mb-2 text-xs text-zinc-500">Anything larger needs your approval on the device.</p>
        <div className="flex items-center gap-2">
          <input type="number" min={0} step={0.1} value={perTx} onChange={(e) => setPerTx(+e.target.value)}
            className="w-32 rounded border border-zinc-300 px-2 py-1 font-mono text-sm" />
          <span className="text-sm text-zinc-600">SUI</span>
        </div>
        <p className="mt-1 font-mono text-xs text-zinc-400">{BigInt(Math.round(perTx * 1e9)).toString()} MIST</p>

        <label className="mt-6 block text-sm font-medium">Weekly cap</label>
        <p className="mb-2 text-xs text-zinc-500">
          A rolling 7-day ceiling. Reaching it stops the agent outright rather than escalating.
        </p>
        <div className="flex items-center gap-2">
          <input type="number" min={0} step={1} value={weekly} onChange={(e) => setWeekly(+e.target.value)}
            className="w-32 rounded border border-zinc-300 px-2 py-1 font-mono text-sm" />
          <span className="text-sm text-zinc-600">SUI</span>
        </div>
        <p className="mt-1 font-mono text-xs text-zinc-400">{BigInt(Math.round(weekly * 1e9)).toString()} MIST</p>
        {overWeekly && (
          <p className="mt-2 text-xs text-red-600">
            A single payment cannot exceed the weekly cap — nothing would ever be approvable.
          </p>
        )}

        <label className="mt-6 block text-sm font-medium">Approved recipients</label>
        <p className="mb-2 text-xs text-zinc-500">
          Paying anyone not on this list needs your approval. Leave it empty and every new
          counterparty is escalated, which is the safe default.
        </p>
        <ul className="mb-2 flex flex-col gap-1">
          {recipients.map((r) => (
            <li key={r.address} className="flex items-center justify-between gap-2 rounded border border-zinc-200 px-2 py-1">
              <span className="truncate font-mono text-xs">{r.label} · {r.address.slice(0, 10)}…{r.address.slice(-6)}</span>
              <button onClick={() => setRecipients(recipients.filter((x) => x.address !== r.address))}
                className="text-xs text-red-600">remove</button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <input placeholder="0x…" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            className="flex-1 rounded border border-zinc-300 px-2 py-1 font-mono text-xs" />
          <input placeholder="label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            className="w-28 rounded border border-zinc-300 px-2 py-1 text-xs" />
          <button
            onClick={() => { if (draft.address && draft.label) { setRecipients([...recipients, draft]); setDraft({ address: '', label: '' }) } }}
            className="rounded border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100">Add</button>
        </div>
      </fieldset>

      <p className="mb-4 rounded-md bg-zinc-50 p-3 text-sm">
        Your agent may spend up to <strong>{perTx} SUI</strong> at a time, at most{' '}
        <strong>{weekly} SUI</strong> a week, to{' '}
        <strong>{recipients.length ? `${recipients.length} approved address${recipients.length > 1 ? 'es' : ''}` : 'nobody'}</strong>{' '}
        without asking you.
      </p>

      <button onClick={save} disabled={!ready || overWeekly}
        className="rounded-full bg-black px-5 py-2 text-sm font-medium text-white disabled:opacity-40">
        Save guardrails
      </button>
      {saved && <span className="ml-3 text-sm text-green-700">{saved}</span>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <p className="mt-8 text-xs text-zinc-500">
        The signing key for the spending address lives on this server. Your Ledger is a second human
        factor and the only key to the protected address — it is not key isolation for the float.
      </p>
    </main>
  )
}
