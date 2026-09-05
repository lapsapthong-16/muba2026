'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import './guardrails-overrides.css'

interface Recipient { address: string; label: string }
interface WalletBalances {
  spending_balance_sui: string
  protected_balance_sui: string
  spending_address: string | null
  protected_address: string | null
}

export default function Guardrails() {
  const [perTx, setPerTx] = useState(1)
  const [weekly, setWeekly] = useState(10)
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [draft, setDraft] = useState({ address: '', label: '' })
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [balances, setBalances] = useState<WalletBalances>({
    spending_balance_sui: '0.0000', protected_balance_sui: '0.0000',
    spending_address: null, protected_address: null,
  })

  useEffect(() => {
    ;(async () => {
      const r = await fetch('/api/setup/state')
      if (!r.ok) return setError('Open your setup link first.')
      const s = await r.json()
      setReady(!!s.ledger_address)
      setBalances({
        spending_balance_sui: s.spending_balance_sui ?? '0.0000',
        protected_balance_sui: s.protected_balance_sui ?? '0.0000',
        spending_address: s.spending_address ?? null,
        protected_address: s.protected_address ?? null,
      })
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
      <header className="guardrails-hero"><div><p>PUFFER / CONTROL ROOM</p><h1>SET THE<br />BOUNDARIES</h1><span>Define spending limits and approve recipients so Puffer can operate within your rules.</span></div><Image src="/assets/puffer/puffer-alert-large.png" alt="" width={300} height={220} priority /></header>
      <div className="guardrails-status"><span><i /> POLICY CONFIGURATION</span><b>LEDGER REQUIRED</b></div>

      <section className="guardrails-wallet-balances" aria-label="Wallet allocation">
        <div className="guardrails-wallet-balance guardrails-wallet-balance--spending">
          <span>SPENDING WALLET · 1-OF-2</span>
          <strong>{balances.spending_balance_sui} SUI</strong>
          <small>{balances.spending_address ? `${balances.spending_address.slice(0, 8)}…${balances.spending_address.slice(-6)}` : 'Waiting for Ledger setup'}</small>
        </div>
        <div className="guardrails-wallet-balance guardrails-wallet-balance--protected">
          <span>PROTECTED WALLET · 2-OF-2</span>
          <strong>{balances.protected_balance_sui} SUI</strong>
          <small>{balances.protected_address ? `${balances.protected_address.slice(0, 8)}…${balances.protected_address.slice(-6)}` : 'Waiting for Ledger setup'}</small>
        </div>
      </section>

      <fieldset className="guardrails-form" disabled={!ready}>
        <section className="guardrails-panel"><h2><b>01</b><span>SPENDING LIMITS<small>Set how much Puffer can spend per transaction and per week.</small></span></h2><div className="guardrails-limits"><div><label>Single payment limit</label><p>Maximum allowed per transaction</p><div className="guardrails-limit-field">
          <input type="number" min={0} step={0.1} value={perTx} onChange={(e) => setPerTx(+e.target.value)}
            className="guardrails-number" /><span>SUI⌄</span>
        </div>
        <em>{BigInt(Math.round(perTx * 1e9)).toString()} MIST</em></div>

        <div className="guardrails-limit--coral"><label>Weekly cap</label><p>
          A rolling 7-day ceiling. Reaching it stops the agent outright rather than escalating.
        </p>
        <div className="guardrails-limit-field">
          <input type="number" min={0} step={1} value={weekly} onChange={(e) => setWeekly(+e.target.value)}
            className="guardrails-number" /><span>SUI⌄</span>
        </div>
        <em>{BigInt(Math.round(weekly * 1e9)).toString()} MIST</em></div></div>
        {overWeekly && (
          <p className="guardrails-validation">
            A single payment cannot exceed the weekly cap — nothing would ever be approvable.
          </p>
        )}</section>

        <section className="guardrails-panel guardrails-recipients"><h2><b>02</b><span>APPROVED RECIPIENTS<small>Only these addresses can receive funds from Puffer.</small></span></h2><p>
          Paying anyone not on this list needs your approval. Add a known route to let your agent
          move inside the boundary you set.
        </p>
        <ul>
          {recipients.map((r) => (
            <li key={r.address}>
              <span>{r.label} <small>{r.address.slice(0, 8)}…{r.address.slice(-5)}</small></span>
              <button onClick={() => setRecipients(recipients.filter((x) => x.address !== r.address))}
                className="guardrails-remove">REMOVE</button>
            </li>
          ))}
        </ul>
        <div className="guardrails-recipient-inputs">
          <input placeholder="Add recipient address (0x...)" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            className="guardrails-address-input" />
          <input placeholder="label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            className="guardrails-label-input" />
          <button
            onClick={() => { if (draft.address && draft.label) { setRecipients([...recipients, draft]); setDraft({ address: '', label: '' }) } }}
            className="guardrails-add">ADD</button>
        </div>
        </section></fieldset>

      <section className="guardrails-summary"><p>GUARDRAILS SUMMARY</p><div><span>Max per payment: <strong>{perTx} SUI</strong></span><i /> <span>Weekly cap: <strong>{weekly} SUI</strong></span><i /> <span>Approved recipients: <strong>{recipients.length}</strong></span></div></section>

      <div className="guardrails-save-row"><button onClick={save} disabled={!ready || overWeekly} className="guardrails-save">SAVE GUARDRAILS <span>→</span></button>{saved && <span className="guardrails-saved">✓ {saved}</span>}</div>
      {error && <p className="guardrails-error">{error}</p>}

      <p className="guardrails-footnote">
        The signing key for the spending address lives on this server. Your Ledger is a second human
        factor and the only key to the protected address — it is not key isolation for the float.
      </p></div>
    </main>
  )
}
