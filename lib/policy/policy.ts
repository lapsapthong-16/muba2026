import { z } from 'zod'
import { normalizeStructTag, normalizeSuiAddress, isValidSuiAddress, isValidSuiObjectId } from '@mysten/sui/utils'

/* ---------- primitives ---------- */

// TWO traps here, both verified:
//  1. normalizeSuiAddress MUST run before isValidSuiAddress — the validator rejects "0xabc".
//  2. NEVER pass these helpers as bare function references. zod calls the callback with
//     (value, ctx); normalizeSuiAddress's 2nd param is `forceAdd0x`, and a truthy ctx yields
//     "0x0x1111..." which then fails validation. Always wrap in an arrow.
const SuiAddress = z.string().trim().transform((s) => normalizeSuiAddress(s)).refine((s) => isValidSuiAddress(s), 'Not a Sui address')
const PackageId = z.string().trim().transform((s) => normalizeSuiAddress(s)).refine((s) => isValidSuiObjectId(s), 'Not a package id')
const CoinType = z.string().trim().transform((s) => normalizeStructTag(s))
// Base units, decimal digits only. Never a JS number: Number("100000000000000001") loses a unit.
const BaseUnits = z.string().regex(/^\d+$/, 'Whole base units only').refine((s) => s.length <= 30, 'Too large')

/* ---------- policy ---------- */

export const CoinCapSchema = z.object({
  coinType: CoinType,
  symbol: z.string().min(1).max(12),
  decimals: z.number().int().min(0).max(18),
  perTxLimit: BaseUnits,
  weeklyLimit: BaseUnits,
}).refine((c) => BigInt(c.perTxLimit) <= BigInt(c.weeklyLimit), {
  message: 'Per-transaction limit cannot exceed the weekly cap',
  path: ['perTxLimit'],
})

export const AllowedRecipientSchema = z.object({
  address: SuiAddress,
  label: z.string().min(1).max(40),
  suinsName: z.string().regex(/^[a-z0-9-]+\.sui$/).optional(),
  resolvedAt: z.number().int().positive().optional(),
})

export const AllowedPackageSchema = z.object({
  packageId: PackageId,
  label: z.string().min(1).max(40),
})

export const PolicySchema = z.object({
  version: z.number().int().positive(),
  walletAddress: SuiAddress,
  caps: z.array(CoinCapSchema).min(1),
  allowedRecipients: z.array(AllowedRecipientSchema),
  allowedPackages: z.array(AllowedPackageSchema).min(1),
})
  .refine((p) => new Set(p.caps.map((c) => c.coinType)).size === p.caps.length, 'Duplicate coin cap')
  .refine((p) => !p.allowedRecipients.some((r) => r.address === p.walletAddress), 'Your own wallet is always allowed')

export type Policy = z.infer<typeof PolicySchema>

/* ---------- evidence (from ONE simulateTransaction) ---------- */

export interface Evidence {
  balanceChanges: { coinType: string; address: string; amount: string }[]
  gasUsed: { computationCost: string; storageCost: string; storageRebate: string }
  gasCoinType: string
  movePackages: string[] // package id of every MoveCall command
  /**
   * Non-coin objects leaving this wallet. Balance changes CANNOT see these: handing over a
   * capability object yields a balanceChanges array whose only row is gas, so every cap, weekly
   * limit and recipient rule below would pass a total authority handover clean. Verified live.
   */
  objectTransfers?: { objectId: string; objectType: string; to: string; isCapability: boolean }[]
  simulationOk: boolean
}

/* ---------- verdict ---------- */

export type Rule = 'UNCONFIGURED_COIN' | 'WEEKLY_CAP' | 'PER_TX_LIMIT' | 'UNKNOWN_RECIPIENT' | 'UNKNOWN_PACKAGE' | 'SIMULATION_FAILED' | 'CAPABILITY_TRANSFER' | 'OBJECT_TRANSFER'
export interface Reason { rule: Rule; verdict: 'deny' | 'require_approval'; human: string }
export interface Outflow { coinType: string; symbol: string; decimals: number; principal: string }
export interface Verdict {
  verdict: 'allow' | 'require_approval' | 'deny'
  reasons: Reason[]
  outflows: Outflow[]
  recipients: string[]
  gasMist: string
  consultGonka: boolean
}

const fmt = (base: string, decimals: number) => {
  const n = BigInt(base), d = BigInt(10) ** BigInt(decimals)
  const frac = (n % d).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${n / d}${frac ? '.' + frac : ''}`
}

/** Headroom lookup, injected: SUM(amount) for coinType over the last 7 days. */
export type SpentLast7d = (coinType: string) => bigint

export function evaluate(policy: Policy, ev: Evidence, spent: SpentLast7d): Verdict {
  const reasons: Reason[] = []
  const self = policy.walletAddress
  const capOf = new Map(policy.caps.map((c) => [c.coinType, c] as const))
  const gasCoin = normalizeStructTag(ev.gasCoinType)

  const netGas = BigInt(ev.gasUsed.computationCost) + BigInt(ev.gasUsed.storageCost) - BigInt(ev.gasUsed.storageRebate)

  if (!ev.simulationOk) {
    reasons.push({ rule: 'SIMULATION_FAILED', verdict: 'deny', human: 'This transaction fails when we test-run it, so we did not sign it.' })
  }

  // 1. Outflows. Only NEGATIVE deltas at our own address are spend. Gas is netted into the
  //    sender's delta on the gas coin, so add it back to recover the principal.
  const outflows: Outflow[] = []
  for (const bc of ev.balanceChanges) {
    if (normalizeSuiAddress(bc.address) !== self) continue
    const delta = BigInt(bc.amount)
    if (delta >= 0n) continue // receiving is never capped
    const coinType = normalizeStructTag(bc.coinType)
    let principal = -delta
    if (coinType === gasCoin) principal -= netGas
    if (principal <= 0n) continue // gas-only transaction

    const cap = capOf.get(coinType)
    if (!cap) {
      reasons.push({ rule: 'UNCONFIGURED_COIN', verdict: 'deny', human: `This spends a coin you have not set a limit for (${coinType.split('::').pop()}). Add a limit for it in Guardrails first.` })
      continue
    }
    outflows.push({ coinType, symbol: cap.symbol, decimals: cap.decimals, principal: principal.toString() })

    const weeklyLeft = BigInt(cap.weeklyLimit) - spent(coinType)
    if (principal > weeklyLeft) {
      reasons.push({ rule: 'WEEKLY_CAP', verdict: 'deny', human: `This would spend ${fmt(principal.toString(), cap.decimals)} ${cap.symbol}, but only ${fmt((weeklyLeft > 0n ? weeklyLeft : 0n).toString(), cap.decimals)} ${cap.symbol} is left in this week's budget.` })
    } else if (principal > BigInt(cap.perTxLimit)) {
      reasons.push({ rule: 'PER_TX_LIMIT', verdict: 'require_approval', human: `${fmt(principal.toString(), cap.decimals)} ${cap.symbol} is over your ${fmt(cap.perTxLimit, cap.decimals)} ${cap.symbol} single-payment limit.` })
    }
  }

  // 2. Recipients: any OTHER address gaining value.
  const allowed = new Set(policy.allowedRecipients.map((r) => r.address))
  const recipients = [...new Set(ev.balanceChanges.filter((b) => BigInt(b.amount) > 0n).map((b) => normalizeSuiAddress(b.address)))].filter((a) => a !== self)
  for (const r of recipients) {
    if (!allowed.has(r)) {
      reasons.push({ rule: 'UNKNOWN_RECIPIENT', verdict: 'require_approval', human: `Money is going to ${r.slice(0, 6)}…${r.slice(-4)}, an address that is not on your approved list.` })
    }
  }

  // 3. Packages: every Move package the transaction calls into.
  const allowedPkg = new Set(policy.allowedPackages.map((p) => p.packageId))
  // .map((p) => f(p)), never .map(f): Array.map passes (value, index) and index 1 lands on
  // normalizeSuiAddress's forceAdd0x, producing "0x0x2". Same trap as in the zod schema above.
  for (const p of [...new Set(ev.movePackages.map((p) => normalizeSuiAddress(p)))]) {
    if (!allowedPkg.has(p)) {
      reasons.push({ rule: 'UNKNOWN_PACKAGE', verdict: 'require_approval', human: `This uses an app you have not approved (${p.slice(0, 6)}…${p.slice(-4)}).` })
    }
  }

  // 4. Objects leaving the wallet. Invisible to every check above, because a non-coin object
  //    moving produces no balance change at all — the only row is gas.
  for (const ot of ev.objectTransfers ?? []) {
    const short = `${ot.to.slice(0, 6)}…${ot.to.slice(-4)}`
    // Strip generics BEFORE splitting, or TreasuryCap<0xabc::tok::TOK> renders as "TOK>".
    const outer = ot.objectType.split('<')[0]
    const typeName = outer.split('::').slice(-1)[0] || ot.objectType
    if (ot.isCapability) {
      // Sui's analogue of unlimited approval, and strictly worse: there is no allowance ledger
      // and nothing to revoke afterwards. Never escalate this — deny it.
      reasons.push({ rule: 'CAPABILITY_TRANSFER', verdict: 'deny', human: `This hands over ${typeName}, a permission object, to ${short}. That cannot be undone, so we did not sign it.` })
    } else if (!allowed.has(ot.to)) {
      reasons.push({ rule: 'OBJECT_TRANSFER', verdict: 'require_approval', human: `This gives away ${typeName} to ${short}, an address that is not on your approved list.` })
    }
  }

  const verdict = reasons.some((r) => r.verdict === 'deny') ? 'deny' : reasons.length ? 'require_approval' : 'allow'
  return { verdict, reasons, outflows, recipients, gasMist: netGas.toString(), consultGonka: verdict !== 'deny' }
}
