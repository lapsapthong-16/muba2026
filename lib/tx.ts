import { Transaction } from '@mysten/sui/transactions'
import { createHash } from 'node:crypto'
import { getSuiClient, SUI_TYPE } from './sui'

/**
 * Build a transaction ONCE and freeze it. Everything downstream — simulation, evidence, the
 * verdict, both signatures — is bound to these exact bytes.
 *
 * Why once, and never rebuilt: with an empty gas payment the SDK injects a random u32 into the
 * ValidDuring expiration, so two builds of the same logical transaction produce DIFFERENT bytes.
 * A design that stores an intent and rebuilds it after human approval would sign something other
 * than what was scored. Pin explicit gas coins and keep the Uint8Array.
 *
 * Also: tx.getDigest() returns a PROMISE in 2.29. Not awaiting it writes the literal string
 * "Promise { <pending> }" into your audit log and your approval card.
 */

export interface FrozenTx {
  bytes: Uint8Array
  /** sha256 of the built bytes. Re-checked immediately before every signature. */
  sha256: string
  /** The offline digest — what the Ledger shows and what an explorer will show. */
  digest: string
  sender: string
}

async function freeze(tx: Transaction, sender: string): Promise<FrozenTx> {
  const bytes = await tx.build({ client: getSuiClient() })
  const digest = await tx.getDigest() // a Promise in 2.29 — await it
  return { bytes, sha256: sha256(bytes), digest, sender }
}

export function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex')
}

/**
 * Pin real gas coins when the wallet holds any.
 *
 * A Sui address can hold SUI two ways, and this caught us out: as `Coin<SUI>` OBJECTS, or as a
 * SIP-58 ADDRESS BALANCE in the accumulator. Measured on a live wallet holding 1.647 SUI:
 *   coinBalance: 0, addressBalance: 1647069908
 * so `listOwnedObjects` correctly returned nothing and an earlier version of this function threw
 * "No SUI coins to pay gas with" on a perfectly well-funded wallet.
 *
 * When there are no coin objects we simply do not call setGasPayment and let the node select gas
 * from the address balance — verified working. Pinning is still preferred where possible, because
 * an EMPTY gas payment injects a random ValidDuring nonce and makes rebuilt bytes non-reproducible;
 * leaving gas UNSET is not the same thing as setting it to [].
 */
async function pinGas(tx: Transaction, sender: string): Promise<void> {
  const client = getSuiClient()
  let objects: unknown[] = []
  try {
    const res = await client.core.listOwnedObjects({ owner: sender, type: `0x2::coin::Coin<${SUI_TYPE}>` })
    objects = (res as { objects?: unknown[] }).objects ?? []
  } catch {
    /* fall through to node gas selection */
  }
  const coins = objects.slice(0, 8).map((o) => {
    const c = o as { objectId?: string; id?: string; version: string | number; digest: string }
    return { objectId: (c.objectId ?? c.id)!, version: String(c.version), digest: c.digest }
  })
  if (coins.length) tx.setGasPayment(coins)
  // else: leave gas unset. The node selects from the address balance.
}

/** DEMO 2 — "transfer all my funds to <address>". The verified Sui drain shape. */
export async function buildTransferAll(sender: string, to: string): Promise<FrozenTx> {
  const tx = new Transaction()
  tx.setSender(sender)
  await pinGas(tx, sender)
  // tx.gas IS the wallet's SUI. Transferring it moves everything not reserved for gas.
  tx.transferObjects([tx.gas], to)
  return freeze(tx, sender)
}

/** A bounded transfer — split first, so only `amount` moves. */
export async function buildTransfer(sender: string, to: string, amountMist: bigint): Promise<FrozenTx> {
  const tx = new Transaction()
  tx.setSender(sender)
  await pinGas(tx, sender)
  const [coin] = tx.splitCoins(tx.gas, [amountMist])
  tx.transferObjects([coin], to)
  return freeze(tx, sender)
}

/** Test-only: build against an unfunded address. Requires simulate({doGasSelection:false}). */
export async function buildTransferUnfunded(sender: string, to: string, amountMist: bigint): Promise<FrozenTx> {
  const tx = new Transaction()
  tx.setSender(sender)
  tx.setGasBudget(10_000_000)
  tx.setGasPrice(1000)
  tx.setGasPayment([]) // budget + price + empty payment. All three, or build() throws.
  const [coin] = tx.splitCoins(tx.gas, [amountMist])
  tx.transferObjects([coin], to)
  return freeze(tx, sender)
}
