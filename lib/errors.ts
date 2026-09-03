/**
 * Stable error codes.
 *
 * MetaMask's CLI answers every failure with a SCREAMING_SNAKE code whose meaning column carries the
 * remedy, and that is the difference between an API a model can act on and one it can only
 * apologise about. A free-text message is something an agent paraphrases to its human; a code is
 * something it can branch on.
 *
 * TWO FIELDS DO THE WORK.
 *
 *   `code` is a promise. Once shipped it never changes meaning — add a new one rather than
 *   repurposing an old one, because an agent may have been told what it means.
 *
 *   `retriable` is the one an agent actually needs, and getting it wrong is expensive in both
 *   directions. Marking a permanent refusal retriable makes a well-behaved agent hammer a wall;
 *   marking a transient failure permanent makes it give up and tell its human something false.
 *   The rule here: retriable means THE SAME CALL, UNCHANGED, COULD SUCCEED LATER. A busy risk model
 *   qualifies. A payment over your limit does not — it needs a human, not patience.
 */

export type Retriable = boolean

export interface CodedError {
  code: string
  retriable: Retriable
  /** What to do about it, addressed to the agent. */
  remedy: string
}

const T = true
const F = false

export const CODES: Record<string, { retriable: Retriable; remedy: string }> = {
  /* ---- setup ---- */
  NEEDS_SETUP: { retriable: F, remedy: 'Show the human the setup link and stop. You cannot complete setup for them.' },
  NO_PROTECTED_ADDRESS: { retriable: F, remedy: 'No Ledger is enrolled, so there is nowhere to escalate to. The human must connect one.' },
  PROTECTED_UNFUNDED: { retriable: F, remedy: 'The protected address cannot fund the rebuilt transaction. Ask the human to fund it, then try again.' },

  /* ---- the human said no, or has not said yes ---- */
  AWAITING_APPROVAL: { retriable: F, remedy: 'Nothing was sent. Poll wallet_approval_status. Do NOT resubmit — a retry creates a second pending approval, it does not bypass the first.' },
  DENIED: { retriable: F, remedy: 'The human declined. Do not try again with the same transaction; ask them what they would accept.' },
  EXPIRED: { retriable: T, remedy: 'The approval window closed without an answer. Submitting again is reasonable if the human is now available.' },

  /* ---- limits ---- */
  PER_TX_LIMIT: { retriable: F, remedy: 'Over the single-payment limit. A human can approve this one on their Ledger, and may raise the limit at the same time.' },
  WEEKLY_CAP: { retriable: F, remedy: 'Over the weekly budget. This one cannot be approved away — hardware cannot create budget. Wait for the window to roll, or ask the human to change the cap.' },
  UNKNOWN_RECIPIENT: { retriable: F, remedy: 'The payee is not on the approved list. A human can approve this payment and optionally add the payee.' },
  UNKNOWN_PACKAGE: { retriable: F, remedy: 'The contract is not on the approved list. Needs a human.' },
  CAPABILITY_TRANSFER: { retriable: F, remedy: 'This hands a permission object out of the wallet. Always needs a human.' },

  /* ---- the transaction itself ---- */
  SIMULATION_FAILED: { retriable: T, remedy: 'It fails when test-run against the live chain. Often a stale balance or a changed pool — re-check the inputs and try once more.' },
  BUILD_FAILED: { retriable: T, remedy: 'The transaction could not be constructed. Usually insufficient balance; check wallet_status first.' },
  BELOW_MARKET_MINIMUM: { retriable: T, remedy: 'The order book fills nothing at this size. Call wallet_markets for the current floor and try a larger size.' },
  QUOTE_FAILED: { retriable: T, remedy: 'The venue did not answer. Try again shortly.' },

  /* ---- infrastructure ---- */
  CHAIN_UNAVAILABLE: { retriable: T, remedy: 'The network could not be reached, so nothing was signed. Try again shortly.' },
  RISK_MODEL_UNAVAILABLE: { retriable: T, remedy: 'The risk model did not answer in time, so this was escalated rather than passed. Not a refusal — try again, or let the human approve it.' },
}

/**
 * A gate rule or internal reason mapped onto the published table.
 *
 * Rules arrive decorated — `GONKA_RISK:high`, `GONKA_ABSTAINED:timeout` — so match the prefix
 * rather than the whole string, or every model-driven escalation lands in the unknown bucket and
 * loses its remedy.
 */
export function codeFor(rule: string | null | undefined, fallback = 'BLOCKED'): CodedError {
  if (!rule) return { code: fallback, retriable: false, remedy: 'See the reasons for what to do next.' }
  if (rule.startsWith('GONKA_ABSTAINED')) {
    return { code: 'RISK_MODEL_UNAVAILABLE', ...CODES.RISK_MODEL_UNAVAILABLE }
  }
  if (rule.startsWith('GONKA_RISK')) {
    return {
      code: 'RISK_TOO_HIGH',
      retriable: false,
      remedy: 'The risk model scored this above the safe band. A human can still approve it; do not retry unchanged.',
    }
  }
  const hit = CODES[rule]
  if (hit) return { code: rule, ...hit }
  return { code: rule, retriable: false, remedy: 'See the reasons for what to do next.' }
}

/** Attach `code`, `retriable` and `remedy` to a result that carries a rule. */
export function withCode(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.code) return payload
  const rule = typeof payload.rule === 'string' ? payload.rule : null
  if (payload.outcome === 'awaiting_approval') return { ...payload, ...codeFor('AWAITING_APPROVAL') }
  if (!rule || rule === 'CLEAN') return payload
  return { ...payload, ...codeFor(rule) }
}
