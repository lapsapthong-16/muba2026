import { gate } from './gate'
import { GONKA_MODELS } from './gonka'
import type { ConsensusOutcome, Risk } from './ballot'
import type { Verdict } from './policy/policy'
import type { SimOutcome } from './evidence'

const ok: SimOutcome = { kind: 'ok', evidence: {} as never }
const clean: Verdict = { verdict: 'allow', reasons: [], outflows: [], recipients: [], gasMist: '0', consultGonka: true }
const overCap: Verdict = { ...clean, verdict: 'deny', reasons: [{ rule: 'WEEKLY_CAP', verdict: 'deny', human: 'over the weekly cap' }] }
const unknownTo: Verdict = { ...clean, verdict: 'require_approval', reasons: [{ rule: 'UNKNOWN_RECIPIENT', verdict: 'require_approval', human: 'unknown recipient' }] }
const capGrab: Verdict = { ...clean, verdict: 'deny', reasons: [{ rule: 'CAPABILITY_TRANSFER', verdict: 'deny', human: 'hands over a permission object' }] }
const models = [GONKA_MODELS.MINIMAX, GONKA_MODELS.MINIMAX, GONKA_MODELS.MINIMAX] as const

function consensus(risks: (Risk | null)[]): ConsensusOutcome {
  const votes = models.map((model, i) => risks[i] === null
    ? { model, ok: false, requestId: null, devshardId: null, latencyMs: null, abstainReason: 'timeout' as const, attempts: [] }
    : { model, ok: true, ballot: { risk: risks[i]!, score: risks[i] === 'low' ? 10 : 80, reasons: [], signals: [] }, requestId: `req-${i}`, devshardId: 'shard', latencyMs: 10, attempts: [] })
  const valid = votes.filter((v) => v.ok)
  const lowVotes = valid.filter((v) => v.ballot?.risk === 'low').length
  return { votes, validVotes: valid.length, lowVotes, consensus: valid.length >= 2 && valid.length === lowVotes ? 'low_quorum' : 'review_required', primaryRequestId: 'req-0' }
}

const rows: [string, SimOutcome, Verdict | null, ConsensusOutcome | null, string][] = [
  ['three low', ok, clean, consensus(['low', 'low', 'low']), 'allow'],
  ['two MiniMax low + timeout', ok, clean, consensus(['low', 'low', null]), 'allow'],
  ['one high', ok, clean, consensus(['high', 'low', 'low']), 'needs_ledger'],
  ['disagreement', ok, clean, consensus(['low', 'medium', null]), 'needs_ledger'],
  ['one valid vote', ok, clean, consensus(['low', null, null]), 'needs_ledger'],
  ['policy floor', ok, unknownTo, consensus(['low', 'low', 'low']), 'needs_ledger'],
  ['weekly cap', ok, overCap, consensus(['low', 'low', 'low']), 'blocked'],
  ['capability', ok, capGrab, consensus(['low', 'low', 'low']), 'blocked'],
]

let failed = 0
for (const [name, sim, verdict, votes, expected] of rows) {
  const actual = gate(sim, verdict, votes).outcome
  const pass = actual === expected
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} -> ${actual}`)
  if (!pass) failed++
}
if (failed) process.exit(1)
