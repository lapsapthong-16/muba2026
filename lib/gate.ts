import type { Verdict } from './policy/policy'
import type { BallotOutcome } from './ballot'
import type { SimOutcome } from './evidence'

/**
 * The one gate. Every caller imports THIS — there is no second copy of these rules anywhere.
 * First match wins.
 *
 *   1  simulation aborted, or the chain was unreachable        -> blocked
 *   2  HARD deterministic deny (weekly cap, unconfigured coin,
 *      capability handover)                                    -> blocked
 *   3  SOFT deterministic hit (per-tx limit, unknown recipient,
 *      unknown package, object leaving)                        -> needs_ledger
 *   4  Gonka says high or medium                               -> needs_ledger
 *   5  Gonka abstained (timeout, 429, substituted, unparseable) -> needs_ledger
 *   6  otherwise                                               -> allow
 *
 * Two invariants this encodes, and they are the whole security argument:
 *
 *  - The deterministic rules are a FLOOR the model cannot argue under. Gonka may only escalate
 *    allow -> needs_ledger. It can never clear a rule that fired. So a compromised or
 *    prompt-injected model cannot unlock anything.
 *  - NEVER allow on oracle failure. An abstention is not a low-risk verdict. A gate that fails
 *    open the moment its model is unreachable is not a gate.
 *
 * Note rule 2 outranks a Ledger tap on purpose: a hardware signature cannot conjure budget that
 * the human's own weekly cap says is not there. To spend more, widen the policy in Module 2.
 */

export type Outcome = 'allow' | 'needs_ledger' | 'blocked'

export interface GateDecision {
  outcome: Outcome
  /** The single rule that decided it. Shown to the human and returned to the agent. */
  rule: string
  /** Every reason, for the approval card. Deterministic ones first. */
  reasons: string[]
  ballotRisk: 'low' | 'medium' | 'high' | null
  /** What the model said, kept even when a deterministic rule decided the outcome. */
  ballotReasons: string[]
  ballotLatencyMs: number | null
  abstained: boolean
  gonkaRequestId: string | null
}

export function gate(sim: SimOutcome, verdict: Verdict | null, ballot: BallotOutcome | null): GateDecision {
  const gonkaRequestId = ballot ? ballot.requestId : null
  const base = {
    reasons: verdict ? verdict.reasons.map((r) => r.human) : [],
    ballotRisk: ballot?.ok ? ballot.ballot.risk : null,
    // Kept even when a deterministic rule decided, so the model's opinion is never silently
    // discarded just because a limit fired first.
    ballotReasons: ballot?.ok ? ballot.ballot.reasons : [],
    ballotLatencyMs: ballot ? ballot.latencyMs : null,
    abstained: ballot ? !ballot.ok : false,
    gonkaRequestId,
  }

  // 1. We could not establish what the transaction does. Both branches fail closed, but they are
  //    different facts and the human is told which.
  if (sim.kind === 'failed') {
    return { ...base, outcome: 'blocked', rule: 'SIMULATION_FAILED',
      reasons: [`This transaction fails when we test-run it, so we did not sign it. (${sim.error.slice(0, 120)})`] }
  }
  if (sim.kind === 'unavailable') {
    return { ...base, outcome: 'blocked', rule: 'CHAIN_UNAVAILABLE',
      reasons: ['We could not reach the network to check this transaction, so we did not sign it.'] }
  }
  if (!verdict) {
    return { ...base, outcome: 'blocked', rule: 'NO_POLICY',
      reasons: ['No guardrails are configured yet. Open the setup link and set your limits first.'] }
  }

  // 2. A hard deterministic deny. Not escalatable — hardware cannot create budget.
  const hard = verdict.reasons.find((r) => r.verdict === 'deny')
  if (hard) return { ...base, outcome: 'blocked', rule: hard.rule }

  // 3. A soft deterministic hit. The model is not consulted to overturn it.
  const soft = verdict.reasons.find((r) => r.verdict === 'require_approval')
  if (soft) return { ...base, outcome: 'needs_ledger', rule: soft.rule }

  // 4/5. Nothing deterministic fired. Gonka may still escalate — and only escalate.
  if (ballot) {
    if (!ballot.ok) {
      return { ...base, outcome: 'needs_ledger', rule: `GONKA_ABSTAINED:${ballot.abstainReason}`,
        reasons: [...base.reasons, `Our risk model could not give an answer (${ballot.abstainReason}), so this needs your approval.`] }
    }
    if (ballot.ballot.risk !== 'low') {
      return { ...base, outcome: 'needs_ledger', rule: `GONKA_RISK:${ballot.ballot.risk}`,
        reasons: [...base.reasons, ...ballot.ballot.reasons] }
    }
  }

  return { ...base, outcome: 'allow', rule: 'CLEAN' }
}
