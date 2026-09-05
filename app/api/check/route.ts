import { requireAgent, AuthError } from '@/lib/auth'
import { getWallet } from '@/lib/wallet'
import { spentLast7d } from '@/lib/db'
import { buildTransfer, buildTransferAll, buildSwap, quoteSwap } from '@/lib/tx'
import { simulate } from '@/lib/evidence'
import { PolicySchema, evaluate } from '@/lib/policy/policy'
import { requestConsensus } from '@/lib/ballot'
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
    | { action?: 'transfer' | 'swap'; to?: string; pool?: string; amount_sui?: number | 'all'; reason?: string }
    | null
  const action = body?.action ?? 'transfer'
  if (body?.amount_sui === undefined) {
    return Response.json({ error: 'amount_sui is required.' }, { status: 400 })
  }
  if (action === 'transfer' && !body.to) {
    return Response.json({ error: 'to is required for a transfer.' }, { status: 400 })
  }
  if (action === 'swap' && body.amount_sui === 'all') {
    return Response.json({ error: 'A swap needs a concrete size; "all" is transfer-only.' }, { status: 400 })
  }

  const w = await getWallet(accountId)
  if (!w.h_address || !w.policy_json) {
    return Response.json({ error: 'Wallet is not set up yet. Open the setup link first.' }, { status: 409 })
  }
  const policy = PolicySchema.parse(JSON.parse(w.policy_json))

  // A swap is quoted before it is built, exactly as wallet_swap does it, so a dry run tells you the
  // same "the book cannot fill this" you would get from the committing path — without spending gas
  // to find out.
  const pool = body!.pool ?? 'SUI_DBUSDC'
  let quote: { quoteOut: number } | undefined
  if (action === 'swap') {
    try {
      quote = await quoteSwap(pool, Number(body!.amount_sui))
    } catch (e) {
      return Response.json({ would: 'blocked', stage: 'quote', nothing_happened: true,
        reasons: [e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e)] })
    }
    if (!quote.quoteOut || quote.quoteOut <= 0) {
      return Response.json({
        would: 'blocked', stage: 'quote', rule: 'BELOW_MARKET_MINIMUM', nothing_happened: true,
        reasons: [`Swapping ${body!.amount_sui} SUI on ${pool} returns nothing — the order book has no fill at that size.`],
        hint: 'Try a larger size. This book most recently began filling around 1.1 SUI, but that floor moves with the resting orders.',
      })
    }
  }

  let frozen
  try {
    frozen =
      action === 'swap'
        ? await buildSwap(w.h_address, pool, Number(body!.amount_sui), quote!.quoteOut * 0.99)
        : body!.amount_sui === 'all'
          ? await buildTransferAll(w.h_address, body!.to!)
          : await buildTransfer(w.h_address, body!.to!, BigInt(Math.round(Number(body!.amount_sui) * 10 ** SUI_DECIMALS)))
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
  const consensus = verdict.verdict !== 'deny'
    ? await requestConsensus(sim.evidence, w.h_address, body!.reason ?? '')
    : null
  const decision = gate(sim, verdict, consensus)

  const sui = (raw: string) => (Number(raw) / 10 ** SUI_DECIMALS).toFixed(6).replace(/\.?0+$/, '')

  return Response.json({
    would: decision.outcome, // allow | needs_ledger | blocked
    rule: decision.rule,
    reasons: decision.reasons,
    nothing_happened: true,
    action,
    ...(quote
      ? { quote: { pool, in_sui: body!.amount_sui, expected_out: quote.quoteOut, min_out: quote.quoteOut * 0.99 } }
      : {}),
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
    risk_consensus: decision.consensus,
    spend_so_far_this_week_sui: sui(spentLast7d(accountId, policy.caps[0].coinType).toString()),
  })
}
