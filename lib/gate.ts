import type { Verdict } from './policy/policy'
import { consensusAllows, type ConsensusOutcome } from './ballot'
import type { SimOutcome } from './evidence'

export type Outcome = 'allow' | 'needs_ledger' | 'blocked'
export interface GateDecision {
  outcome: Outcome
  rule: string
  reasons: string[]
  consensus: ConsensusOutcome | null
  gonkaRequestId: string | null
}

/** The fixed decision point: policy is a floor; two independent low votes are the only AI allow. */
export function gate(sim: SimOutcome, verdict: Verdict | null, consensus: ConsensusOutcome | null): GateDecision {
  const base = {
    reasons: verdict ? verdict.reasons.map((r) => r.human) : [],
    consensus,
    gonkaRequestId: consensus?.primaryRequestId ?? null,
  }
  if (sim.kind === 'failed') return { ...base, outcome: 'blocked', rule: 'SIMULATION_FAILED', reasons: [`This transaction fails when we test-run it, so we did not sign it. (${sim.error.slice(0, 120)})`] }
  if (sim.kind === 'unavailable') return { ...base, outcome: 'blocked', rule: 'CHAIN_UNAVAILABLE', reasons: ['We could not reach the network to check this transaction, so we did not sign it.'] }
  if (!verdict) return { ...base, outcome: 'blocked', rule: 'NO_POLICY', reasons: ['No guardrails are configured yet. Open the setup link and set your limits first.'] }
  const hard = verdict.reasons.find((r) => r.verdict === 'deny')
  if (hard) return { ...base, outcome: 'blocked', rule: hard.rule }
  const soft = verdict.reasons.find((r) => r.verdict === 'require_approval')
  if (soft) return { ...base, outcome: 'needs_ledger', rule: soft.rule }
  if (!consensus) return { ...base, outcome: 'needs_ledger', rule: 'GONKA_INSUFFICIENT_QUORUM', reasons: [...base.reasons, 'Risk reviewers did not provide a quorum, so this needs your approval.'] }
  if (consensusAllows(consensus)) return { ...base, outcome: 'allow', rule: 'CONSENSUS_LOW' }
  const votedReasons = consensus.votes.flatMap((vote) => vote.ok ? vote.ballot?.reasons ?? [] : [])
  const rule = consensus.validVotes < 2 ? 'GONKA_INSUFFICIENT_QUORUM' : 'GONKA_CONSENSUS_REVIEW'
  return { ...base, outcome: 'needs_ledger', rule, reasons: [...base.reasons, ...votedReasons, 'The model consensus requires your approval.'] }
}
