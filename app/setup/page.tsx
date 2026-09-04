'use client'

import { useCallback, useEffect, useState } from 'react'
import Image from 'next/image'
import LedgerConnect from './LedgerConnect'

interface State {
  network: string
  spending_address: string | null
  protected_address: string | null
  ledger_address: string | null
  spending_balance_sui: string
  protected_balance_sui: string
  ready: boolean
}

export default function Setup() {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const r = await fetch('/api/setup/state')
    if (r.ok) setState(await r.json())
    else setError((await r.json().catch(() => ({}))).error ?? 'Could not load your wallet.')
  }, [])

  useEffect(() => {
    ;(async () => {
      // The token lives in the fragment, so it never reached a server. Redeem it once for an
      // httpOnly cookie, then strip it from the URL so a screenshot or a shared link is inert.
      const token = new URLSearchParams(location.hash.slice(1)).get('s')
      if (token) {
        await fetch('/api/setup/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        history.replaceState(null, '', location.pathname)
      }
      await refresh()
    })()
  }, [refresh])

  // Funds usually arrive while this page is open, so poll rather than making people reload.
  useEffect(() => {
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [refresh])

  if (error) return <Shell><p className="setup-message setup-message--error">{error}</p></Shell>
  if (!state) return <Shell><p className="setup-message">Preparing your safe water…</p></Shell>

  return (
    <Shell>
      <div className="setup-hero">
        <div>
          <h1>SET UP YOUR<br />AGENT WALLET</h1>
          <p>Three short steps. One wallet your agent can use without swimming out of bounds.</p>
        </div>
        <Image className="setup-hero__puffer" src="/assets/puffer/puffer-calm-small.png" alt="" width={180} height={180} priority />
      </div>
      <div className="setup-statusbar">
        <span><i /> SECURE SETUP</span>
        <span className="setup-network">{state.network}</span>
      </div>

      <Step n={1} title="Connect your Ledger" done={!!state.ledger_address}>
        {state.ledger_address ? (
          <p className="setup-device-address">{state.ledger_address}</p>
        ) : (
          <>
            <p className="setup-copy">
              Your wallet does not exist until this is done. Both of its addresses are built from
              your device&apos;s key together with ours — we cannot create them alone, and that is
              the point.
            </p>
            <LedgerConnect onEnrolled={refresh} />
          </>
        )}
      </Step>

      <Step n={2} title="Fund the spending address" done={Number(state.spending_balance_sui) > 0}>
        {state.spending_address ? (
          <div className="flex flex-col gap-3">
            <Address label="Spending · 1-of-2" hint="Your agent spends from here on its own, under the limits you set next."
              address={state.spending_address} balance={state.spending_balance_sui} primary />
            <Address label="Protected · 2-of-2" hint="Everything else. Moving anything out of here needs your Ledger."
              address={state.protected_address!} balance={state.protected_balance_sui} />
            <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">
              Send <strong>{state.network}</strong> SUI only. A Sui address is identical on every
              network, so coins sent on mainnet will not appear here and cannot be recovered.
            </p>
          </div>
        ) : (
          <p className="setup-muted">Connect your Ledger first.</p>
        )}
      </Step>

      <Step n={3} title="Set your guardrails" done={state.ready}>
        <a href="/guardrails"
          className={`setup-guardrails-button ${
            state.ledger_address ? '' : 'is-disabled'
          }`}>
          {state.ready ? 'Edit guardrails' : 'Set spending limits →'}
        </a>
      </Step>

      {state.ready && (
        <p className="setup-live-message">
          Your wallet is live. Your agent can spend within your limits; anything that trips them
          stops here for you to approve on your Ledger.
        </p>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="setup-page"><div className="setup-shell">{children}</div></main>
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <section className={`setup-step ${done ? 'is-done' : ''}`}>
      <h2>
        <span className="setup-step__number">
          {done ? '✓' : n}
        </span>
        <span><small>STEP {n}</small>{title}</span>
      </h2>
      {children}
    </section>
  )
}

function Address({ label, hint, address, balance, primary }: {
  label: string; hint: string; address: string; balance: string; primary?: boolean
}) {
  return (
    <div className={`setup-address ${primary ? 'setup-address--spending' : 'setup-address--protected'}`}>
      <div className="setup-address__topline">
        <span>{label}</span>
        <strong>{balance} SUI</strong>
      </div>
      <p className="setup-address__value">{address}</p>
      <div className="setup-address__footer">
        <button onClick={() => navigator.clipboard.writeText(address)}
          className="setup-copy-button">COPY</button>
        <span>{hint}</span>
      </div>
    </div>
  )
}
