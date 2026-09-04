'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'

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
    <main className="guardrails-page"><div className="guardrails-shell">
      <header className="guardrails-hero"><div><p>PUFFER / CONTROL ROOM</p><h1>SET THE<br />BOUNDARIES</h1><span>Give your agent room to run — and a reef it cannot cross without you.</span></div><Image src="/assets/puffer/puffer-alert-large.png" alt="" width={300} height={220} priority /></header>
      <div className="guardrails-status"><span><i /> POLICY CONFIGURATION</span><b>LEDGER REQUIRED</b></div>

      {!ready && <p className="guardrails-alert">Connect your Ledger on the setup page first.</p>}

      <fieldset className="guardrails-form" disabled={!ready}>
        <section className="guardrails-panel"><h2><b>01</b><span>SPENDING LIMITS<small>Set the hard edge of autonomous spending.</small></span></h2><div className="guardrails-limits"><div><label>Single payment limit</label><p>Anything larger waits for your approval on the device.</p><div>
          <input type="number" min={0} step={0.1} value={perTx} onChange={(e) => setPerTx(+e.target.value)}
            className="guardrails-number" /><span>SUI</span>
        </div>
        <em>{BigInt(Math.round(perTx * 1e9)).toString()} MIST</em></div>

        <div className="guardrails-limit--coral"><label>Weekly cap</label><p>
          A rolling 7-day ceiling. Reaching it stops the agent outright rather than escalating.
        </p>
        <div>
          <input type="number" min={0} step={1} value={weekly} onChange={(e) => setWeekly(+e.target.value)}
            className="guardrails-number" /><span>SUI</span>
        </div>
        <em>{BigInt(Math.round(weekly * 1e9)).toString()} MIST</em></div></div>
        {overWeekly && (
          <p className="guardrails-validation">
            A single payment cannot exceed the weekly cap — nothing would ever be approvable.
          </p>
        )}</section>

        <section className="guardrails-panel guardrails-recipients"><h2><b>02</b><span>APPROVED RECIPIENTS<small>Known routes can pass without a human check.</small></span></h2><p>
          Paying anyone not on this list needs your approval. Leave it empty and every new
          counterparty is escalated, which is the safe default.
        </p>
        <ul>
          {recipients.map((r) => (
            <li key={r.address}>
              <span>{r.label} <small>· {r.address.slice(0, 10)}…{r.address.slice(-6)}</small></span>
              <button onClick={() => setRecipients(recipients.filter((x) => x.address !== r.address))}
                className="guardrails-remove">REMOVE</button>
            </li>
          ))}
        </ul>
        <div className="guardrails-recipient-inputs">
          <input placeholder="0x…" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            className="guardrails-address-input" />
          <input placeholder="label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            className="guardrails-label-input" />
          <button
            onClick={() => { if (draft.address && draft.label) { setRecipients([...recipients, draft]); setDraft({ address: '', label: '' }) } }}
            className="guardrails-add">ADD</button>
        </div>
        </section></fieldset>

      <section className="guardrails-summary"><p>YOUR AUTONOMY WINDOW</p><div><strong>{perTx} <small>SUI</small></strong><span>per payment</span><i /> <strong>{weekly} <small>SUI</small></strong><span>per week</span><i /> <strong>{recipients.length}</strong><span>approved routes</span></div><p>Your agent can use this window without calling you back to the surface.</p></section>

      <div className="guardrails-save-row"><button onClick={save} disabled={!ready || overWeekly} className="guardrails-save">SAVE GUARDRAILS <span>→</span></button>{saved && <span className="guardrails-saved">✓ {saved}</span>}</div>
      {error && <p className="guardrails-error">{error}</p>}

      <p className="guardrails-footnote">
        The signing key for the spending address lives on this server. Your Ledger is a second human
        factor and the only key to the protected address — it is not key isolation for the float.
      </p></div>
    </main>
  )
}
