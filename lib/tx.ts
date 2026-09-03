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

/** Pin real gas coins. Never [] outside a test: it injects the nonce and mocks a 1e18 gas coin. */
async function pinGas(tx: Transaction, sender: string): Promise<void> {
  const client = getSuiClient()
  const { objects } = await client.core.listOwnedObjects({ owner: sender, type: `0x2::coin::Coin<${SUI_TYPE}>` })
  const coins = (objects ?? []).slice(0, 8).map((o: any) => ({
    objectId: o.objectId ?? o.id,
    version: String(o.version),
    digest: o.digest,
  }))
  if (!coins.length) throw new Error(`No SUI coins at ${sender} to pay gas with. Fund it first.`)
  tx.setGasPayment(coins)
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
