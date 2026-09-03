import { requireAgent, AuthError } from '@/lib/auth'
import { getWallet } from '@/lib/wallet'
import { getDb, spentLast7d } from '@/lib/db'
import { buildTransfer, buildTransferAll } from '@/lib/tx'
import { simulate } from '@/lib/evidence'
import { PolicySchema, evaluate } from '@/lib/policy/policy'
import { requestBallot, RISK_BANDS } from '@/lib/ballot'
import { gate } from '@/lib/gate'
import { SUI_DECIMALS } from '@/lib/sui'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Dry run: build, simulate, score and gate a transaction WITHOUT signing it, broadcasting it, or
 * creating an approval the human then has to clear.
 *
 * This is the endpoint an agent should call when it wants to know whether something WOULD be
 * allowed — planning a route, checking a counterparty, showing its user what it is about to do.
 * wallet_transfer is the one that commits; this one only looks.
 *
 * It deliberately produces no side effects at all: no decision row, no spend-ledger debit, no
 * pending approval. Calling it repeatedly is free apart from the model latency.
 */
export async function POST(req: Request) {
  let accountId: string
  try {
    accountId = requireAgent(req).accountId
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = (await req.json().catch(() => null)) as
    | { to?: string; amount_sui?: number | 'all'; reason?: string }
    | null
  if (!body?.to || body.amount_sui === undefined) {
    return Response.json({ error: 'to and amount_sui are required.' }, { status: 400 })
  }

  const w = await getWallet(accountId)
  if (!w.h_address || !w.policy_json) {
    return Response.json({ error: 'Wallet is not set up yet. Open the setup link first.' }, { status: 409 })
  }
  const policy = PolicySchema.parse(JSON.parse(w.policy_json))

  let frozen
  try {
    frozen =
      body.amount_sui === 'all'
        ? await buildTransferAll(w.h_address, body.to)
        : await buildTransfer(w.h_address, body.to, BigInt(Math.round(Number(body.amount_sui) * 10 ** SUI_DECIMALS)))
  } catch (e) {
    return Response.json({
      would: 'blocked',
      stage: 'build',
      reasons: [e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e)],
    })
  }

  const sim = await simulate(frozen.bytes, w.h_address)
  if (sim.kind !== 'ok') {
    return Response.json({
      would: 'blocked',
      stage: 'simulate',
      simulation: sim.kind,
      reasons: [sim.error.split('\n')[0].slice(0, 200)],
    })
  }

  const verdict = evaluate(policy, sim.evidence, (ct) => spentLast7d(accountId, ct))
  const ballot = await requestBallot(sim.evidence, w.h_address, body.reason ?? '', 30_000)
  const decision = gate(sim, verdict, ballot)

  const sui = (raw: string) => (Number(raw) / 10 ** SUI_DECIMALS).toFixed(6).replace(/\.?0+$/, '')

  return Response.json({
    would: decision.outcome, // allow | needs_ledger | blocked
    rule: decision.rule,
    reasons: decision.reasons,
    nothing_happened: true,
    from: w.h_address,
    digest_if_sent: frozen.digest,
    gas_paid_by: frozen.gasPaidBySponsor ? 'sponsor' : 'the wallet',
    simulation: {
      balance_changes: sim.evidence.balanceChanges.map((b) => ({
        who:
          b.address === w.h_address ? 'wallet' : b.address === sim.evidence.gasOwner ? 'gas_sponsor' : 'counterparty',
        address: b.address,
        amount_sui: sui(b.amount),
      })),
      move_packages: sim.evidence.movePackages,
      objects_leaving: sim.evidence.objectTransfers ?? [],
    },
    risk: ballot.ok
      ? {
          score: ballot.ballot.score,
          band: ballot.ballot.risk,
          bands: RISK_BANDS,
          reasons: ballot.ballot.reasons,
          signals: ballot.ballot.signals,
          model: ballot.model,
          gonka_request_id: ballot.requestId,
          latency_ms: ballot.latencyMs,
        }
      : { abstained: ballot.abstainReason, latency_ms: ballot.latencyMs, note: 'An abstention escalates; it never passes.' },
    spend_so_far_this_week_sui: sui(spentLast7d(accountId, policy.caps[0].coinType).toString()),
  })
}
