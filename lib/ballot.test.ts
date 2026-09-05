import { GONKA_MODELS } from './gonka'
import { requestConsensus, type BallotOutcome } from './ballot'
import type { GonkaModelId } from './gonka'
import type { Evidence } from './policy/policy'

const evidence = { balanceChanges: [], gasUsed: { computationCost: '0', storageCost: '0', storageRebate: '0' }, gasCoinType: '0x2::sui::SUI', movePackages: [], simulationOk: true } as Evidence
const calls = new Map<string, number>()
const low = (model: string, id: string): BallotOutcome => ({ ok: true, model, requestId: id, devshardId: 'shard-1', latencyMs: 1, ballot: { score: 10, risk: 'low', reasons: [], signals: [] } })

const requester = async (model: GonkaModelId): Promise<BallotOutcome> => {
  const n = calls.get(model) ?? 0
  calls.set(model, n + 1)
  if (model === GONKA_MODELS.MINIMAX && n === 0) return { ok: false, abstainReason: 'http_error', requestId: 'minimax-unavailable', devshardId: 'shard-2', latencyMs: 1 }
  return low(model, `${model}-winner`)
}

void (async () => {
  const consensus = await requestConsensus(evidence, '0x1', 'test', requester)
  const fallback = consensus.votes.find((v) => v.fallbackFrom === GONKA_MODELS.MINIMAX)
  const pass = consensus.consensus === 'review_required' && consensus.validVotes === 1 && fallback?.ok && fallback.servedModel === GONKA_MODELS.DEEPSEEK
  console.log(`${pass ? 'ok' : 'FAIL'} one completed review creates a Ledger-held decision`)
  if (!pass) process.exit(1)
})()
