import { getSuiClient, SUI_TYPE } from './sui'
import type { Evidence } from './policy/policy'

/**
 * Simulate a FROZEN transaction and reduce it to deterministic evidence. No scores here — this
 * produces facts with stable ids; the policy evaluator and Gonka do all the judging.
 *
 * Result shape, pinned live against sui-node/1.79.0 (guessing at this costs hours):
 *   res.$kind                        'Transaction' | 'FailedTransaction'
 *   res.Transaction.status           { success, error }
 *   res.Transaction.balanceChanges   [{ coinType, address, amount }]
 *   res.Transaction.objectTypes      { [objectId]: '0x2::coin::Coin<0x2::sui::SUI>' }   ← a MAP
 *   res.Transaction.effects.gasUsed  { computationCost, storageCost, storageRebate, ... }
 *   res.Transaction.effects.changedObjects[] { objectId, inputOwner, outputOwner, ... }
 *
 * Note the payload key is capital-`Transaction`, not `transaction`. And `effects` carries both a
 * raw `bcs` blob AND decoded fields — use the decoded ones.
 */

export type SimOutcome =
  | { kind: 'ok'; evidence: Evidence }
  /** The chain ran it and it aborted. A real fact about the transaction. */
  | { kind: 'failed'; error: string }
  /** We could not reach the chain. NOT the same fact — never let this read as "safe". */
  | { kind: 'unavailable'; error: string }

/** Sui's analogue of unlimited approval: a capability object handed to someone else, forever. */
const CAPABILITY_RE = /::[A-Za-z0-9_]*(Cap|Capability)\b/

export interface ObjectTransfer {
  objectId: string
  objectType: string
  to: string
  isCapability: boolean
}

export async function simulate(
  txBytes: Uint8Array,
  self: string,
  /**
   * Test-only. The node re-runs gas selection at SIMULATE time, so an unfunded sender fails here
   * even when build() succeeded. `doGasSelection: false` makes it substitute a mocked 1e18 gas
   * coin instead — which is why the drain then reports a nonsensical figure. Never in production.
   */
  opts: { doGasSelection?: boolean } = {}
): Promise<SimOutcome> {
  let res: any
  try {
    res = await getSuiClient().core.simulateTransaction({
      transaction: txBytes,
      include: { balanceChanges: true, effects: true, events: true, objectTypes: true, transaction: true },
      ...(opts.doGasSelection === false ? { doGasSelection: false } : {}),
    })
  } catch (e) {
    return { kind: 'unavailable', error: e instanceof Error ? e.message : String(e) }
  }

  if (res.$kind !== 'Transaction') {
    return { kind: 'failed', error: JSON.stringify(res[res.$kind]?.status ?? res.$kind) }
  }
  const T = res.Transaction
  if (T.status && T.status.success === false) {
    return { kind: 'failed', error: String(T.status.error ?? 'aborted') }
  }

  const eff = T.effects ?? {}
  const objectTypes: Record<string, string> = T.objectTypes ?? {}

  return {
    kind: 'ok',
    evidence: {
      balanceChanges: (T.balanceChanges ?? []).map((b: any) => ({
        coinType: b.coinType,
        address: b.address,
        amount: String(b.amount),
      })),
      gasUsed: {
        computationCost: String(eff.gasUsed?.computationCost ?? '0'),
        storageCost: String(eff.gasUsed?.storageCost ?? '0'),
        storageRebate: String(eff.gasUsed?.storageRebate ?? '0'),
      },
      gasCoinType: SUI_TYPE,
      // Who actually paid gas. Under Shinami sponsorship gasData.owner is the sponsor, and the
      // spend arithmetic in policy.ts depends on this. Absent gasData we assume self-paid, which
      // is the conservative reading (it counts MORE against the cap, never less).
      gasPaidBySender: (T.transaction?.gasData?.owner ?? self) === self,
      gasOwner: T.transaction?.gasData?.owner ?? self,
      movePackages: movePackagesFrom(T),
      objectTransfers: objectTransfersFrom(eff, objectTypes, self),
      simulationOk: true,
    },
  }
}

/** Package ids of every MoveCall, read off the BUILT transaction the node echoed back. */
function movePackagesFrom(T: any): string[] {
  const cmds = T.transaction?.kind?.ProgrammableTransaction?.commands ?? T.transaction?.commands ?? []
  const out = new Set<string>()
  for (const cmd of cmds) {
    const mc = cmd?.MoveCall ?? (cmd?.$kind === 'MoveCall' ? cmd.MoveCall : undefined)
    if (mc?.package) out.add(mc.package)
  }
  return [...out]
}

/**
 * Objects leaving this wallet. This is the signal balance changes CANNOT see: handing over a
 * capability object produces a balanceChanges array containing one row, and that row is gas.
 * Verified live — transferObjects([TreasuryCap], attacker) reports the victim spending ~1,017,024
 * MIST and nothing else, so every cap, weekly limit and recipient allowlist passes it clean.
 */
function objectTransfersFrom(
  eff: any,
  objectTypes: Record<string, string>,
  self: string
): ObjectTransfer[] {
  const out: ObjectTransfer[] = []
  for (const co of eff.changedObjects ?? []) {
    const before = ownerAddress(co.inputOwner)
    const after = ownerAddress(co.outputOwner)
    if (!after || before !== self || after === self) continue
    const objectType = objectTypes[co.objectId] ?? 'unknown'
    // A plain Coin leaving is already visible as a balance change; don't double-report it.
    if (/^0x0*2::coin::Coin</.test(objectType)) continue
    out.push({
      objectId: co.objectId,
      objectType,
      to: after,
      isCapability: CAPABILITY_RE.test(objectType) || objectType === 'unknown',
    })
  }
  return out
}

function ownerAddress(owner: any): string | null {
  if (!owner) return null
  return owner.AddressOwner ?? owner.address ?? (owner.$kind === 'AddressOwner' ? owner.AddressOwner : null)
}
