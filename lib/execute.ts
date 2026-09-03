import { getDb } from './db'
import { getSuiClient } from './sui'
import { keypairFromSealed } from './keys'
import { combineAndVerify, type WalletCommittees } from './multisig'
import type { FrozenTx } from './tx'
import { sha256 } from './tx'

/**
 * Signing and broadcasting. Both addresses are multisig, so even the solo path is NOT a plain
 * Ed25519 signature: the platform key produces a PARTIAL, and that partial is combined against the
 * H committee (threshold 1, platform weight 1) into a multisig signature the validators accept.
 *
 * combinePartialSignatures fails silently in two ways — wrong member order, or under threshold —
 * returning a plausible-looking signature that simply does not verify, with no throw. Everything
 * here goes through combineAndVerify, which checks before we broadcast.
 */

export interface ExecResult {
  digest: string
  effects: unknown
}

function committees(accountId: string): WalletCommittees {
  const row = getDb()
    .prepare('SELECT committees_json FROM wallets WHERE account_id=?')
    .get(accountId) as { committees_json: string | null } | undefined
  if (!row?.committees_json) throw new Error('No committees stored. Connect a Ledger first.')
  return JSON.parse(row.committees_json) as WalletCommittees
}

/** The platform's partial. A plain 132-char base64 string: flag ‖ sig(64) ‖ pubkey(32). */
export async function platformPartial(accountId: string, bytes: Uint8Array): Promise<string> {
  const row = getDb()
    .prepare('SELECT enc_platform_key FROM wallets WHERE account_id=?')
    .get(accountId) as { enc_platform_key: string } | undefined
  if (!row) throw new Error('No wallet for this account')
  const kp = keypairFromSealed(accountId, row.enc_platform_key)
  const { signature } = await kp.signTransaction(bytes)
  return signature
}

/**
 * The low-risk path: H is 1-of-2, so the platform key alone meets the threshold.
 *
 * The sha256 re-check is the whole "the bytes that were scored are the bytes that get signed"
 * guarantee, and it costs nothing. If it ever fires, something rebuilt the transaction between
 * scoring and signing and we must not proceed.
 */
export async function executeFromSpending(accountId: string, frozen: FrozenTx): Promise<ExecResult> {
  if (sha256(frozen.bytes) !== frozen.sha256) {
    throw new Error('Transaction bytes changed after they were checked. Refusing to sign.')
  }
  const c = committees(accountId)
  const partial = await platformPartial(accountId, frozen.bytes)
  const signature = await combineAndVerify(c.spending, [partial], frozen.bytes)
  return broadcast(frozen.bytes, [signature])
}

/**
 * The escalated path: M is 2-of-2, so the platform partial is worthless on its own. The Ledger's
 * partial arrives from the browser over plain JSON and is combined here.
 *
 * Order matters and is not negotiable: partials must be ordered to match committee.members, which
 * is [platform, ledger, recovery]. Passing them the other way round yields a 320-char signature
 * that verifies false, with no error raised anywhere.
 */
export async function executeFromProtected(
  accountId: string,
  frozen: FrozenTx,
  ledgerPartial: string
): Promise<ExecResult> {
  if (sha256(frozen.bytes) !== frozen.sha256) {
    throw new Error('Transaction bytes changed after they were checked. Refusing to sign.')
  }
  const c = committees(accountId)
  const partial = await platformPartial(accountId, frozen.bytes)
  const signature = await combineAndVerify(c.protected, [partial, ledgerPartial], frozen.bytes)
  return broadcast(frozen.bytes, [signature])
}

async function broadcast(bytes: Uint8Array, signatures: string[]): Promise<ExecResult> {
  const res = await getSuiClient().core.executeTransaction({
    transaction: bytes,
    signatures,
    include: { effects: true, balanceChanges: true },
  })
  const T = (res as { $kind?: string; Transaction?: Record<string, unknown> }).Transaction ?? (res as Record<string, unknown>)
  const digest = String((T as { digest?: string }).digest ?? '')
  if (!digest) throw new Error(`Execution returned no digest: ${JSON.stringify(res).slice(0, 200)}`)
  return { digest, effects: (T as { effects?: unknown }).effects }
}

/**
 * Debit the rolling window at SIGN time, not request time. Then rewrite the amount from the
 * EXECUTED effects, because the simulated figure and the settled one can differ.
 *
 * Until this is called the weekly cap reads zero spent forever, which makes it decorative.
 */
export function recordSpend(
  accountId: string,
  coinType: string,
  amountBaseUnits: string,
  digest: string | null,
  status: 'reserved' | 'settled' = 'settled'
): void {
  getDb()
    .prepare(
      'INSERT INTO spend_ledger(account_id, coin_type, amount, digest, status, created_at) VALUES(?,?,?,?,?,?)'
    )
    .run(accountId, coinType, amountBaseUnits, digest, status, Date.now())
}
