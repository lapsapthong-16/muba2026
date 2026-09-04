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
  /**
   * If the human stated the cap in dollars, what they said and the rate it was pinned at.
   *
   * The LIMIT ITSELF STAYS IN BASE UNITS. Converting at evaluation time would put a live price
   * feed in front of every payment — a slow oracle would stall the gate, and a moving one would
   * mean the same transaction is allowed at 10:00 and refused at 10:01 with nothing changed. So
   * the rate is pinned when the cap is set, and this records what it was so the number can be
   * explained later rather than looking arbitrary.
   */
  usd: z.object({
    perTxUsd: z.number().positive(),
    weeklyUsd: z.number().positive(),
    suiUsdAtSet: z.number().positive(),
    pinnedAt: z.number().int().positive(),
  }).optional(),
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
  /**
   * Which named preset this policy came from. Optional so every policy written before modes
   * existed still parses — absent means 'reef', the cautious reading, which is the only safe
   * default for a field that governs whether a rule fires.
   */
  mode: z.enum(['reef', 'open_water']).optional(),
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
  /**
   * Did the SENDER pay gas, or a sponsor? This changes the spend arithmetic and getting it wrong
   * is permissive. Measured live on testnet for the same 10,000,000 MIST transfer:
   *   self-paid   sender delta -12,007,760, netGas 2,007,760  -> principal = -delta - netGas
   *   sponsored   sender delta -10,000,000, netGas 2,007,760  -> principal = -delta
   * Subtracting gas from a sponsored transaction reports 7,992,240 for a 10,000,000 spend, so every
   * sponsored payment would consume less of the cap than it actually spends.
   * Defaults to true (self-paid), which is the conservative reading.
   */
  gasPaidBySender?: boolean
  /**
   * Who paid gas. Needed as an ADDRESS, not just a boolean, because the gas payer shows up in
   * balanceChanges as fee/rebate settlement rather than as value received — and Shinami's sponsor
   * address ROTATES between transactions, so it can never be allowlisted.
   */
  gasOwner?: string
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
    // Only net gas out when the SENDER paid it. Under sponsorship the sponsor's coin covers gas,
    // so the sender's delta is already the pure principal.
    if (coinType === gasCoin && ev.gasPaidBySender !== false) principal -= netGas
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
  // The GAS PAYER is not a payee. Its balance row is fee-and-rebate settlement, and when a
  // transaction deletes objects — which merging coins does — the storage rebate can EXCEED the
  // fee, leaving the sponsor with a POSITIVE delta. Left unhandled, a payment to an allowlisted
  // address escalates with "Money is going to 0x1c1a…8b6c", which is the gas station. Verified
  // reproducible. Netting rather than skipping means a sponsor that is ALSO a genuine payee still
  // shows a positive residual and is still flagged.
  const gasOwner = normalizeSuiAddress(ev.gasOwner ?? self)
  const sponsorPaidGas = ev.gasPaidBySender === false && gasOwner !== self
  const recipients: string[] = []
  const seenRecipients = new Set<string>()
  for (const b of ev.balanceChanges) {
    const addr = normalizeSuiAddress(b.address)
    if (addr === self || seenRecipients.has(addr)) continue
    const gained = sponsorPaidGas && addr === gasOwner ? BigInt(b.amount) + netGas : BigInt(b.amount)
    if (gained > 0n) {
      recipients.push(addr)
      seenRecipients.add(addr)
    }
  }
  // Open Water deliberately does not gate on the payee — that is the whole difference between the
  // two modes, and the human chose it by name. Everything else still runs: the per-transaction
  // limit, the weekly cap, the capability check, the simulation, and the risk model, which is what
  // actually catches a drain to a stranger once this rule is off. And an abstaining model
  // escalates, so the permissive mode fails closed rather than open.
  if (policy.mode !== 'open_water') {
    for (const r of recipients) {
      if (!allowed.has(r)) {
        reasons.push({ rule: 'UNKNOWN_RECIPIENT', verdict: 'require_approval', human: `Money is going to ${r.slice(0, 6)}…${r.slice(-4)}, an address that is not on your approved list.` })
      }
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
