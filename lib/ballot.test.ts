import { GONKA_MODELS } from './gonka'
import { requestConsensus, type BallotOutcome, type VerifierModel } from './ballot'
import type { Evidence } from './policy/policy'

const evidence = { balanceChanges: [], gasUsed: { computationCost: '0', storageCost: '0', storageRebate: '0' }, gasCoinType: '0x2::sui::SUI', movePackages: [], simulationOk: true } as Evidence
const calls = new Map<string, number>()
const low = (model: string, id: string): BallotOutcome => ({ ok: true, model, requestId: id, devshardId: 'shard-1', latencyMs: 1, ballot: { score: 10, risk: 'low', reasons: [], signals: [] } })

const requester = async (model: VerifierModel): Promise<BallotOutcome> => {
  const n = calls.get(model) ?? 0
  calls.set(model, n + 1)
  if (model === GONKA_MODELS.DEEPSEEK && n === 0) return { ok: false, abstainReason: 'substituted', requestId: 'bad-fallback', devshardId: 'shard-2', latencyMs: 1 }
  return low(model, `${model}-winner`)
}

void (async () => {
  const consensus = await requestConsensus(evidence, '0x1', 'test', requester)
  const deepseek = consensus.votes.find((v) => v.model === GONKA_MODELS.DEEPSEEK)!
  const minimaxVotes = consensus.votes.filter((v) => v.model === GONKA_MODELS.MINIMAX)
  const pass = consensus.consensus === 'review_required' && consensus.validVotes === 1 && deepseek.ok && deepseek.fallbackFrom === GONKA_MODELS.DEEPSEEK && minimaxVotes.length === 2
  console.log(`${pass ? 'ok' : 'FAIL'} fallback is displayed but duplicate serving models do not form a quorum`)
  if (!pass) process.exit(1)
})()
