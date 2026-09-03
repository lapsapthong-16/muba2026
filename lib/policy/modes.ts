import { SUI_TYPE, DEEPBOOK_PACKAGE } from '../sui'

/**
 * Named guardrail presets.
 *
 * MetaMask ships Guard Mode and Beast Mode, and the reason it works is not the numbers — it is
 * that a human picks ONE WORD instead of typing four figures they have no basis for choosing.
 * "Per-transaction limit" is a question nobody can answer on their first day; "how adventurous is
 * this wallet" is a question everybody can.
 *
 * The failure this fixes is real and we hit it: a wallet configured with a 0.0025 SUI per-tx
 * limit sent every DeepBook trade to the hardware key, because no fillable trade on that book is
 * smaller than 1.1 SUI. Nothing was broken — the number was just picked blind, and there was
 * nothing to pick it against.
 *
 * WHAT DOES NOT CHANGE WITH MODE. Every mode simulates, every mode runs the deterministic rules,
 * and every mode scores with the risk model. Beast Mode in MetaMask still threat-scans; Open
 * Water here still escalates a high score, still blocks a failed simulation, and still cannot
 * exceed the weekly cap. A mode widens WHO you can pay and HOW MUCH at once. It never removes a
 * check, and there is deliberately no mode that signs whatever it is handed.
 */

export type ModeName = 'reef' | 'open_water'

export interface Mode {
  name: ModeName
  label: string
  /** One line a human can decide on without knowing anything about Sui. */
  summary: string
  perTxSui: number
  weeklySui: number
  /** Reef starts empty — you add payees deliberately. Open Water does not gate on the payee. */
  requireAllowlistedRecipient: boolean
  /** What still bites, stated per mode so the table is honest rather than reassuring. */
  stillApplies: string[]
}

export const MODES: Record<ModeName, Mode> = {
  reef: {
    name: 'reef',
    label: 'Reef',
    summary: 'Pays only addresses you have named. Everything else waits for your Ledger.',
    perTxSui: 2.5,
    weeklySui: 10,
    requireAllowlistedRecipient: true,
    stillApplies: [
      'Every transaction is simulated before it is signed.',
      'Anything over 2.5 SUI in one go needs your Ledger.',
      'The 10 SUI weekly cap is a hard stop — a Ledger tap cannot widen it.',
      'A payee you have not named needs your Ledger, at any size.',
      'A high risk score needs your Ledger even inside every limit.',
    ],
  },
  open_water: {
    name: 'open_water',
    label: 'Open Water',
    summary: 'Pays anyone. The limits, the simulation and the risk model still bite.',
    perTxSui: 10,
    weeklySui: 50,
    requireAllowlistedRecipient: false,
    stillApplies: [
      'Every transaction is still simulated before it is signed.',
      'Anything over 10 SUI in one go still needs your Ledger.',
      'The 50 SUI weekly cap is still a hard stop.',
      'A high risk score still needs your Ledger.',
      'Handing over a capability object still needs your Ledger.',
    ],
  },
}

export const DEFAULT_MODE: ModeName = 'reef'

export function isModeName(s: unknown): s is ModeName {
  return s === 'reef' || s === 'open_water'
}

/**
 * The published side-by-side. MetaMask's docs carry this table and it is the single most useful
 * page they have, because it lets you answer "will this stop me?" before you find out the hard
 * way. Returned by wallet_status so the agent can read it too — and, critically, so the agent can
 * tell its human WHICH WORD to say rather than which number to type.
 */
export function modeTable() {
  return (Object.keys(MODES) as ModeName[]).map((k) => {
    const m = MODES[k]
    return {
      mode: m.name,
      label: m.label,
      summary: m.summary,
      per_transaction_limit_sui: m.perTxSui,
      weekly_limit_sui: m.weeklySui,
      pays_unlisted_addresses: m.requireAllowlistedRecipient ? 'needs your Ledger' : 'yes',
      simulated: 'always',
      risk_scored: 'always',
      still_applies: m.stillApplies,
    }
  })
}

/** The policy body a mode expands to. Recipients are carried over: a mode never drops a payee. */
export function policyFromMode(
  mode: ModeName,
  keep: { allowedRecipients?: { address: string; label: string }[] } = {}
) {
  const m = MODES[mode]
  const toMist = (sui: number) => BigInt(Math.round(sui * 1e9)).toString()
  return {
    mode,
    caps: [
      {
        coinType: SUI_TYPE,
        symbol: 'SUI',
        decimals: 9,
        perTxLimit: toMist(m.perTxSui),
        weeklyLimit: toMist(m.weeklySui),
      },
    ],
    allowedRecipients: keep.allowedRecipients ?? [],
    allowedPackages: [
      { packageId: '0x2', label: 'Sui Framework' },
      { packageId: DEEPBOOK_PACKAGE, label: 'DeepBook' },
    ],
  }
}
