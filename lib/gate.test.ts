/**
 * The fail-closed matrix. Pure — no network, no key, runs in milliseconds.
 *   npm run test:gate
 *
 * The two rows that matter most are marked. If either regresses, the gate is not a gate.
 */
import { gate } from './gate'
import type { Verdict } from './policy/policy'
import type { BallotOutcome } from './ballot'
import type { SimOutcome } from './evidence'

const ok: SimOutcome = { kind: 'ok', evidence: {} as never }
const clean: Verdict = { verdict: 'allow', reasons: [], outflows: [], recipients: [], gasMist: '0', consultGonka: true }
const overCap: Verdict = { ...clean, verdict: 'deny', reasons: [{ rule: 'WEEKLY_CAP', verdict: 'deny', human: 'over the weekly cap' }] }
const unknownTo: Verdict = { ...clean, verdict: 'require_approval', reasons: [{ rule: 'UNKNOWN_RECIPIENT', verdict: 'require_approval', human: 'unknown recipient' }] }
const capGrab: Verdict = { ...clean, verdict: 'deny', reasons: [{ rule: 'CAPABILITY_TRANSFER', verdict: 'deny', human: 'hands over a permission object' }] }

const low: BallotOutcome = { ok: true, ballot: { risk: 'low', reasons: [], signals: [] }, requestId: 'req-1', model: 'm', latencyMs: 10 }
const high: BallotOutcome = { ok: true, ballot: { risk: 'high', reasons: ['drains the wallet'], signals: [] }, requestId: 'req-2', model: 'm', latencyMs: 10 }
const abstain: BallotOutcome = { ok: false, abstainReason: 'timeout', requestId: null, latencyMs: 30000 }

type Row = [string, SimOutcome, Verdict | null, BallotOutcome | null, string]
const rows: Row[] = [
  ['clean + model low                    ', ok, clean, low, 'allow'],
  ['clean + model HIGH  (model escalates)', ok, clean, high, 'needs_ledger'],
  ['clean + ABSTAIN     ** fail closed **', ok, clean, abstain, 'needs_ledger'],
  ['clean + no ballot yet                ', ok, clean, null, 'allow'],
  ['per-tx hit + model low               ', ok, unknownTo, low, 'needs_ledger'],
  ['weekly cap + model LOW ** floor **   ', ok, overCap, low, 'blocked'],
  ['capability grab + model low          ', ok, capGrab, low, 'blocked'],
  ['simulation aborted                   ', { kind: 'failed', error: 'MoveAbort' }, clean, low, 'blocked'],
  ['chain unreachable                    ', { kind: 'unavailable', error: 'ECONNRESET' }, clean, low, 'blocked'],
  ['no policy configured                 ', ok, null, low, 'blocked'],
]

let failed = 0
for (const [name, sim, verdict, ballot, expected] of rows) {
  const d = gate(sim, verdict, ballot)
  const pass = d.outcome === expected
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}  ->  ${d.outcome.padEnd(12)} [${d.rule}]`)
}

// The invariant stated as an assertion, not a comment: the model can never clear a fired rule.
const cannotUnlock = ['WEEKLY_CAP', 'CAPABILITY_TRANSFER', 'UNKNOWN_RECIPIENT'].every((_, i) => {
  const v = [overCap, capGrab, unknownTo][i]
  return gate(ok, v, low).outcome !== 'allow'
})
console.log(`\n${cannotUnlock ? 'ok  ' : 'FAIL'}  a 'low' ballot can never clear a deterministic rule`)
if (!cannotUnlock) failed++

console.log(failed ? `\n${failed} FAILING` : '\nall gate rows pass')
process.exit(failed ? 1 : 0)
