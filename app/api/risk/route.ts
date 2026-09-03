import { requireAgent, AuthError } from '@/lib/auth'
import { requestBallot, bandFor, RISK_BANDS } from '@/lib/ballot'
import { GONKA_MODELS } from '@/lib/gonka'
import { SUI_TYPE } from '@/lib/sui'
import type { Evidence } from '@/lib/policy/policy'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Is the risk model reachable, and does it still score the way we think it does?
 *
 * THE PROMPT IS NOT AN INPUT. This route scores one of two FIXED evidence bundles chosen by a
 * single enum, and the caller cannot supply text, evidence, a model id or a system prompt. That is
 * deliberate: the previous /api/gonka forwarded a caller-controlled systemPrompt with no auth,
 * which is an open proxy to a paid API and a working injection vector. There is no way to reach
 * the model with your own words through this server — the only path is to declare a typed intent
 * and let the server build and simulate the transaction itself.
 *
 * Two uses:
 *   - a health probe, so you learn the model is down BEFORE a transaction is waiting on it;
 *   - a warmer, because the first call of a session is the slow one and a cold model that answers
 *     in 31s against a 30s budget abstains, which escalates a payment that was never risky.
 *
 *   curl -s $BASE/api/risk -H "Authorization: Bearer $BEARER"
 *   curl -s "$BASE/api/risk?case=drain" -H "Authorization: Bearer $BEARER"
 *
 * `expected` is what the sentinel SHOULD score. A benign bundle coming back high, or a drain
 * coming back low, means the model changed under us — the deterministic rules still hold the
 * floor, but the explanations shown to humans are no longer trustworthy.
 */

const WALLET = '0xc370d09a630f416b68d96197d6ee9d4f94ef16bb834b4ec6844c50db2307bf37'
const FRIEND = '0x1111111111111111111111111111111111111111111111111111111111111111'
const ATTACKER = '0xbadb00000000000000000000000000000000000000000000000000000000bad0'
const GAS = { computationCost: '1000000', storageCost: '1976000', storageRebate: '978120' }

const SENTINELS: Record<string, { label: string; expected: string; intent: string; ev: Evidence }> = {
  benign: {
    label: 'A small payment to an address the owner allow-listed.',
    expected: 'low',
    intent: 'paying a friend back for lunch',
    ev: {
      balanceChanges: [
        { coinType: SUI_TYPE, address: WALLET, amount: '-2000000' },
        { coinType: SUI_TYPE, address: FRIEND, amount: '2000000' },
      ],
      gasUsed: GAS,
      gasCoinType: SUI_TYPE,
      movePackages: [],
      simulationOk: true,
      gasPaidBySender: false,
      gasOwner: '0x1c1a00000000000000000000000000000000000000000000000000000000008b6c',
    } as Evidence,
  },
  drain: {
    label: 'The whole balance to an address the owner has never seen.',
    expected: 'high',
    intent: 'claim your free airdrop',
    ev: {
      balanceChanges: [
        { coinType: SUI_TYPE, address: WALLET, amount: '-1647069908' },
        { coinType: SUI_TYPE, address: ATTACKER, amount: '1647069908' },
      ],
      gasUsed: GAS,
      gasCoinType: SUI_TYPE,
      movePackages: [],
      simulationOk: true,
      gasPaidBySender: false,
      gasOwner: '0x1c1a00000000000000000000000000000000000000000000000000000000008b6c',
    } as Evidence,
  },
}

export async function GET(req: Request) {
  try {
    requireAgent(req)
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }

  const which = new URL(req.url).searchParams.get('case') === 'drain' ? 'drain' : 'benign'
  const s = SENTINELS[which]
  const ballot = await requestBallot(s.ev, WALLET, s.intent, 30_000)

  if (!ballot.ok) {
    return Response.json({
      reachable: false,
      case: which,
      abstained: ballot.abstainReason,
      latency_ms: ballot.latencyMs,
      model: GONKA_MODELS.MINIMAX,
      note: 'An abstention never passes a transaction — it escalates it to the Ledger. So this is degraded, not open.',
    })
  }

  return Response.json({
    reachable: true,
    case: which,
    scenario: s.label,
    score: ballot.ballot.score,
    band: ballot.ballot.risk,
    expected_band: s.expected,
    as_expected: ballot.ballot.risk === s.expected,
    bands: RISK_BANDS,
    band_of_score: bandFor(ballot.ballot.score),
    reasons: ballot.ballot.reasons,
    signals: ballot.ballot.signals,
    model: ballot.model,
    gonka_request_id: ballot.requestId,
    latency_ms: ballot.latencyMs,
    note: 'Nothing was built, simulated or sent. This scores a fixed sample bundle.',
  })
}
