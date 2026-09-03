'use client'

import { useCallback, useEffect, useState } from 'react'
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

  if (error) return <Shell><p className="text-red-600">{error}</p></Shell>
  if (!state) return <Shell><p className="text-zinc-500">Loading…</p></Shell>

  return (
    <Shell>
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Set up your agent wallet</h1>
        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-amber-900">
          {state.network}
        </span>
      </div>

      <Step n={1} title="Connect your Ledger" done={!!state.ledger_address}>
        {state.ledger_address ? (
          <p className="font-mono text-xs break-all text-zinc-600">{state.ledger_address}</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-zinc-600">
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
          <p className="text-sm text-zinc-500">Connect your Ledger first.</p>
        )}
      </Step>

      <Step n={3} title="Set your guardrails" done={state.ready}>
        <a href="/guardrails"
          className={`inline-block rounded-full px-5 py-2 text-sm font-medium ${
            state.ledger_address ? 'bg-black text-white' : 'pointer-events-none bg-zinc-200 text-zinc-400'
          }`}>
          {state.ready ? 'Edit guardrails' : 'Set spending limits →'}
        </a>
      </Step>

      {state.ready && (
        <p className="mt-8 rounded-md bg-green-50 p-4 text-sm text-green-900">
          Your wallet is live. Your agent can spend within your limits; anything that trips them
          stops here for you to approve on your Ledger.
        </p>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-2xl px-6 py-14 font-sans">{children}</main>
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <section className="mb-8 border-l-2 border-zinc-200 pl-5">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] ${done ? 'bg-green-600 text-white' : 'bg-zinc-200 text-zinc-600'}`}>
          {done ? '✓' : n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Address({ label, hint, address, balance, primary }: {
  label: string; hint: string; address: string; balance: string; primary?: boolean
}) {
  return (
    <div className={`rounded-lg border p-3 ${primary ? 'border-black/20 bg-white' : 'border-zinc-200 bg-zinc-50'}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
        <span className="font-mono text-sm tabular-nums">{balance} SUI</span>
      </div>
      <p className="mt-1 break-all font-mono text-xs text-zinc-700">{address}</p>
      <div className="mt-2 flex items-center gap-3">
        <button onClick={() => navigator.clipboard.writeText(address)}
          className="rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100">Copy</button>
        <span className="text-xs text-zinc-500">{hint}</span>
      </div>
    </div>
  )
}
