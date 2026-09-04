'use client'

import { useEffect, useState } from 'react'
import Automations from './automations'

/**
 * The wallet dashboard — what the owner sees when they are not being asked to approve something.
 *
 * Reads the human session, never a bearer, so nothing here is reachable by the agent. It is a
 * mirror: it shows state and links to the pages that change it, rather than becoming a fourth
 * place limits can be edited from.
 */

interface Check { check: string; ok: boolean; detail: string }
interface Decision {
  id: string
  state: string
  intent: string
  rule: string | null
  digest: string | null
  created_at: number
}
interface State {
  ledger_address?: string | null
  spending_address?: string | null
  protected_address?: string | null
  spending_balance_sui?: string
  protected_balance_sui?: string
  policy?: {
    mode?: string
    caps: { perTxLimit: string; weeklyLimit: string; usd?: { perTxUsd: number; weeklyUsd: number; suiUsdAtSet: number } }[]
    allowedRecipients: { address: string; label: string }[]
    allowedPackages: { packageId: string; label: string }[]
  } | null
  preflight?: Check[]
  pending_ids?: string[]
  recent?: Decision[]
}

const sui = (mist?: string) => (mist ? (Number(mist) / 1e9).toFixed(4).replace(/\.?0+$/, '') : '—')
const short = (a?: string | null) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '—')

export default function Dashboard() {
  const [s, setS] = useState<State | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const r = await fetch('/api/setup/state')
      if (!r.ok) return setErr('No session. Open your setup link first.')
      const j = await r.json()
      if (alive) setS(j)
    }
    void load()
    const t = setInterval(load, 15_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const cap = s?.policy?.caps?.[0]
  const usd = cap?.usd

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-200 pb-5">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-400">Sui testnet</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Puffer</h1>
        </div>
        <nav className="flex gap-4 text-sm">
          <a href="/guardrails" className="text-zinc-500 hover:text-zinc-900">Guardrails</a>
          <a href="/test" className="text-zinc-500 hover:text-zinc-900">Approvals</a>
          <a href="/setup" className="text-zinc-500 hover:text-zinc-900">Setup</a>
        </nav>
      </header>

      {err && <p className="mt-8 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm">{err}</p>}

      {s && (
        <>
          {/* balances + limits, side by side because one is meaningless without the other */}
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { k: 'Spending', v: `${sui(s.spending_balance_sui)} SUI`, sub: short(s.spending_address), tone: 'text-emerald-700' },
              { k: 'Protected', v: `${sui(s.protected_balance_sui)} SUI`, sub: short(s.protected_address), tone: 'text-amber-700' },
              {
                k: 'Per payment',
                v: usd ? `$${usd.perTxUsd}` : `${sui(cap?.perTxLimit)} SUI`,
                sub: usd ? `${sui(cap?.perTxLimit)} SUI at $${usd.suiUsdAtSet}` : 'set in SUI',
                tone: 'text-zinc-900',
              },
              {
                k: 'Weekly cap',
                v: usd ? `$${usd.weeklyUsd}` : `${sui(cap?.weeklyLimit)} SUI`,
                sub: 'hard stop — hardware cannot widen it',
                tone: 'text-zinc-900',
              },
            ].map((c) => (
              <div key={c.k} className="rounded-xl border border-zinc-200 bg-white p-4">
                <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">{c.k}</p>
                <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${c.tone}`}>{c.v}</p>
                <p className="mt-1 truncate font-mono text-[11px] text-zinc-500">{c.sub}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            {/* preflight — the same checks the agent gets, so both are looking at one truth */}
            <section className="rounded-xl border border-zinc-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">Readiness</h2>
                {s.policy?.mode && (
                  <span className="rounded-full border border-zinc-300 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider">
                    {s.policy.mode === 'open_water' ? 'Open Water' : 'Reef'}
                  </span>
                )}
              </div>
              <ul className="mt-3 space-y-2">
                {(s.preflight ?? []).map((c) => (
                  <li key={c.check} className="flex gap-3 text-sm">
                    <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${c.ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                    <span>
                      <b className="font-mono text-[12px] font-medium">{c.check}</b>
                      <span className="block text-zinc-600">{c.detail}</span>
                    </span>
                  </li>
                ))}
                {!(s.preflight ?? []).length && <li className="text-sm text-zinc-500">Connect a Ledger to see this.</li>}
              </ul>
            </section>

            {/* who the agent may pay */}
            <section className="rounded-xl border border-zinc-200 bg-white p-5">
              <h2 className="text-base font-semibold">Allowed</h2>
              <p className="mt-1 text-xs text-zinc-500">Anyone else needs your Ledger.</p>
              <ul className="mt-3 space-y-1.5">
                {(s.policy?.allowedRecipients ?? []).map((r) => (
                  <li key={r.address} className="text-sm">
                    {r.label}
                    <span className="block font-mono text-[11px] text-zinc-500">{short(r.address)}</span>
                  </li>
                ))}
                {!(s.policy?.allowedRecipients ?? []).length && (
                  <li className="text-sm text-zinc-500">Nobody yet — every payment will ask.</li>
                )}
              </ul>
              <p className="mt-4 text-[11px] font-medium uppercase tracking-wider text-zinc-400">Contracts</p>
              <ul className="mt-1.5 space-y-1">
                {(s.policy?.allowedPackages ?? []).map((p) => (
                  <li key={p.packageId} className="text-sm">
                    {p.label}
                    <span className="block font-mono text-[11px] text-zinc-500">{short(p.packageId)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/* what actually happened */}
          <section className="mt-4 rounded-xl border border-zinc-200 bg-white">
            <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
              <h2 className="text-base font-semibold">Activity</h2>
              {!!s.pending_ids?.length && (
                <a href="/test" className="rounded-full bg-amber-500 px-3 py-1 text-xs font-medium text-white">
                  {s.pending_ids.length} waiting on you
                </a>
              )}
            </header>
            <ul className="divide-y divide-zinc-100">
              {(s.recent ?? []).map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3">
                  <span className="text-sm">{d.intent}</span>
                  <span className="flex items-center gap-3 font-mono text-[11px] text-zinc-500">
                    {d.rule && d.rule !== 'CLEAN' && <span>{d.rule}</span>}
                    <span
                      className={
                        d.state === 'executed' ? 'text-emerald-700'
                        : d.state === 'pending' ? 'text-amber-700'
                        : 'text-zinc-500'
                      }
                    >
                      {d.state}
                    </span>
                    {d.digest && (
                      <a
                        className="underline decoration-dotted"
                        href={`https://suiscan.xyz/testnet/tx/${d.digest}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {d.digest.slice(0, 8)}…
                      </a>
                    )}
                  </span>
                </li>
              ))}
              {!(s.recent ?? []).length && (
                <li className="px-5 py-6 text-sm text-zinc-500">Nothing yet. Ask your agent to do something.</li>
              )}
            </ul>
          </section>
        </>
      )}

      {/* Outside the session gate on purpose: the canvas holds no wallet data, so there is no
          reason to show an error where a working tool can be. */}
      <div className="mt-4">
        <Automations />
      </div>
    </main>
  )
}
