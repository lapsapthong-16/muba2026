import { Transaction } from '@mysten/sui/transactions'
import { SUI_DECIMALS } from './sui'
import type { Evidence } from './policy/policy'

/**
 * Turn a decoded transaction plus its simulated effects into plain English.
 *
 * WHY THIS LIVES HERE AND NOT ON THE DEVICE. A hardware wallet will not display text the computer
 * sends it — that is the entire point of one. If a dapp could push "sending 1 SUI" to the screen,
 * a compromised dapp would push exactly that while draining you. The Ledger renders only what its
 * own embedded Sui app independently derived from the signed bytes, and there is no Sui equivalent
 * of ERC-7730 metadata to extend that vocabulary.
 *
 * So the honest division of labour is:
 *   this screen  — the full story, in English, derived from OUR simulation
 *   the device   — a few fields it derived ITSELF, which is what makes them trustworthy
 * The human's job is to check the two agree. State that plainly rather than implying the device
 * understands more than it does.
 */

export interface Description {
  /** One sentence a non-technical owner can act on. */
  headline: string
  /** Step-by-step, one line per PTB command. */
  steps: string[]
  /** What the device itself will be able to show, so the human knows what to compare. */
  deviceWillShow: string[]
  /** Movements, in the owner's own money. */
  movements: { label: string; amount: string; direction: 'out' | 'in' }[]
  /** WHY this stopped here instead of being signed automatically. */
  flags: Flag[]
}

export interface Flag {
  /** A short category the owner can recognise at a glance. */
  category: string
  /** What specifically tripped, in their terms. */
  detail: string
  /** blocking = cannot be approved at all; review = why your device is being asked. */
  severity: 'blocking' | 'review'
}

/**
 * Every rule the gate can fire, in language an owner recognises. The rule ids are internal; these
 * are what a person actually reads, and they are the answer to "why is my Ledger buzzing".
 */
const CATEGORIES: Record<string, { category: string; severity: Flag['severity'] }> = {
  PER_TX_LIMIT: { category: 'Larger than your single-payment limit', severity: 'review' },
  UNKNOWN_RECIPIENT: { category: 'Paying someone new', severity: 'review' },
  UNKNOWN_PACKAGE: { category: 'Using an app you have not approved', severity: 'review' },
  OBJECT_TRANSFER: { category: 'Giving away an item you own', severity: 'review' },
  WEEKLY_CAP: { category: 'Over your weekly budget', severity: 'blocking' },
  UNCONFIGURED_COIN: { category: 'A coin you have set no limit for', severity: 'blocking' },
  CAPABILITY_TRANSFER: { category: 'Hands over permanent control — cannot be undone', severity: 'blocking' },
  SIMULATION_FAILED: { category: 'Fails when test-run against the network', severity: 'blocking' },
  CHAIN_UNAVAILABLE: { category: 'We could not reach the network to check it', severity: 'blocking' },
  NO_POLICY: { category: 'No guardrails configured yet', severity: 'blocking' },
  PROTECTED_UNFUNDED: { category: 'Protected address has no funds', severity: 'blocking' },
  CLEAN: { category: 'Nothing tripped', severity: 'review' },
}

/** Map a gate decision into flags. Handles the GONKA_* rules, which carry a suffix. */
export function flagsFor(rule: string, reasons: string[]): Flag[] {
  const out: Flag[] = []
  if (rule.startsWith('GONKA_RISK')) {
    out.push({
      category: `Our risk model rated this ${rule.split(':')[1] ?? 'elevated'}`,
      detail: reasons[reasons.length - 1] ?? 'The model considered this risky.',
      severity: 'review',
    })
  } else if (rule.startsWith('GONKA_ABSTAINED')) {
    out.push({
      category: 'Risk check unavailable',
      detail: `The model did not answer (${rule.split(':')[1] ?? 'timeout'}), so this needs you rather than passing unchecked.`,
      severity: 'review',
    })
  }
  // The deterministic reasons carry their own wording already; pair each with its category.
  for (const r of reasons) {
    const hit = Object.entries(CATEGORIES).find(([, v]) => matches(r, v.category))
    const known = CATEGORIES[rule]
    const c = hit?.[1] ?? known
    if (!c || out.some((f) => f.detail === r)) continue
    out.push({ category: c.category, detail: r, severity: c.severity })
  }
  if (!out.length && CATEGORIES[rule]) {
    out.push({ category: CATEGORIES[rule].category, detail: reasons[0] ?? '', severity: CATEGORIES[rule].severity })
  }
  return out
}

// Reason strings are written for humans, so match them loosely back to a category.
function matches(reason: string, category: string): boolean {
  const r = reason.toLowerCase()
  if (category.includes('single-payment')) return r.includes('single-payment limit')
  if (category.includes('someone new')) return r.includes('not on your approved list') && r.includes('money is going')
  if (category.includes('not approved')) return r.includes('an app you have not approved')
  if (category.includes('item')) return r.includes('gives away')
  if (category.includes('weekly')) return r.includes("week's budget")
  if (category.includes('no limit for')) return r.includes('have not set a limit for')
  if (category.includes('permanent control')) return r.includes('permission object')
  if (category.includes('test-run')) return r.includes('fails when we test-run')
  if (category.includes('reach the network')) return r.includes('could not reach the network')
  return false
}

const fmt = (mist: bigint) => {
  const neg = mist < 0n
  const n = neg ? -mist : mist
  const d = BigInt(10) ** BigInt(SUI_DECIMALS)
  const frac = (n % d).toString().padStart(SUI_DECIMALS, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${n / d}${frac ? '.' + frac : ''} SUI`
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export function describe(
  txBytes: Uint8Array,
  ev: Evidence,
  self: string,
  rule = 'CLEAN',
  reasons: string[] = []
): Description {
  const data = Transaction.from(txBytes).getData()
  const commands = (data.commands ?? []) as Record<string, unknown>[]

  const steps: string[] = []
  for (const c of commands) {
    const kind = (c.$kind as string) ?? Object.keys(c)[0]
    switch (kind) {
      case 'SplitCoins':
        steps.push('Take a portion out of one of your coins')
        break
      case 'MergeCoins':
        steps.push('Combine several of your coins into one')
        break
      case 'TransferObjects':
        steps.push('Hand that over to the recipient')
        break
      case 'MoveCall': {
        const mc = c.MoveCall as { module?: string; function?: string; package?: string } | undefined
        steps.push(
          mc?.module === 'coin' && /redeem|send/.test(mc.function ?? '')
            ? 'Draw the amount from your account balance'
            : `Call ${mc?.module}::${mc?.function} on ${short(mc?.package ?? '?')}`
        )
        break
      }
      case 'MakeMoveVec':
        steps.push('Bundle several items together')
        break
      default:
        steps.push(kind)
    }
  }

  // Movements come from the SIMULATION, not from reading the command list — what a transaction
  // actually does is the effects, not its shape.
  const movements: Description['movements'] = []
  let outTotal = 0n
  let payeeTotal = 0n
  let payee: string | null = null
  for (const b of ev.balanceChanges) {
    const amt = BigInt(b.amount)
    if (b.address === self) {
      if (amt < 0n) outTotal += -amt
      movements.push({ label: 'from your wallet', amount: fmt(amt), direction: amt < 0n ? 'out' : 'in' })
    } else if (amt > 0n && b.address !== ev.gasOwner) {
      payee = b.address
      payeeTotal += amt
      movements.push({ label: `to ${short(b.address)}`, amount: fmt(amt), direction: 'in' })
    }
  }

  const calculatedSpend = ev.gasPaidBySender === false ? outTotal : outTotal - netGas(ev)
  // For `send all`, tx.coin() may expose only gas on the sender's row. The recipient's
  // positive balance change is the exact principal that will be transferred.
  const exactSpend = calculatedSpend > 0n ? calculatedSpend : payeeTotal
  const spend = exactSpend > 0n ? fmt(exactSpend) : '0 SUI'
  const headline = payee
    ? `Send ${spend} from your wallet to ${short(payee)}.`
    : `Move ${spend} out of your wallet.`

  // Only claim the device shows a field if the transaction is a shape its parser recognises.
  const hasMoveCall = commands.some((c) => ((c.$kind as string) ?? Object.keys(c)[0]) === 'MoveCall')
  const deviceWillShow = hasMoveCall
    ? [
        'A transaction hash only — this shape contains a Move call, which the Sui app cannot read.',
        'You will be asked to BLIND SIGN. The device cannot confirm the amount or recipient for you.',
      ]
    : ['From (your device address, not the sending wallet)', 'To — compare it with the recipient above', 'Amount — compare it with the figure above', 'Max Gas']

  return { headline, steps, deviceWillShow, movements, flags: flagsFor(rule, reasons) }
}

function netGas(ev: Evidence): bigint {
  return (
    BigInt(ev.gasUsed.computationCost) + BigInt(ev.gasUsed.storageCost) - BigInt(ev.gasUsed.storageRebate)
  )
}
