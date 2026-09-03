import { Transaction } from '@mysten/sui/transactions'
import { createHash } from 'node:crypto'
import { getSuiClient, SUI_TYPE } from './sui'

/**
 * @shinami/clients/sui is ESM-only — its exports map has no `require` entry, and its CJS build is
 * unusable anyway because a transitive dep (@open-rpc/client-js) declares no CJS main. A static
 * import therefore breaks any tool that resolves this file as CJS, which tsx does. A dynamic
 * import loads real ESM from either context.
 */
async function shinami() {
  return import('@shinami/clients/sui')
}

/**
 * Build a transaction, get Shinami to sponsor the gas, and freeze the result.
 *
 * ORDERING IS THE WHOLE POINT. Sponsorship REPLACES the bytes: a gasless transaction is txKind
 * only (verified: 140 bytes, no gas data at all), and Shinami returns a complete 424-byte
 * transaction with gasData filled in. So the freeze happens AFTER sponsorship, on the bytes that
 * will actually execute. Freezing before would bind us to bytes Shinami then discards, silently
 * breaking "the bytes that were scored are the bytes that get signed".
 *
 * NOTHING MAY REFERENCE tx.gas. In a sponsored transaction gasData.owner is Shinami, so tx.gas is
 * THEIR coin — splitting or transferring it would move the sponsor's money, not the wallet's. It is
 * not even constructible: buildGaslessTransaction rejects it with "Invalid params", because there
 * is no gas coin at build time. Every builder below sources from the wallet's own Coin<SUI> objects.
 *
 * Verified live: Shinami sponsors a MULTISIG sender without complaint, and the resulting balance
 * changes are agent -10,000,000 / sponsor -2,007,760 (gas) / recipient +10,000,000.
 */

export interface FrozenTx {
  bytes: Uint8Array
  /** sha256 of the final bytes. Re-checked immediately before every signature. */
  sha256: string
  /** The offline digest — what an explorer shows and what the Ledger displays. */
  digest: string
  sender: string
  /** Shinami's signature over the gas half. Absent when we fell back to self-paid. */
  sponsorSignature?: string
  gasPaidBySponsor: boolean
}

export function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex')
}

function hasGasStation(): boolean {
  return !!process.env.SHINAMI_GAS_STATION_ACCESS_KEY
}

/** The wallet's own SUI coin objects, newest first. Never the gas coin. */
async function ownedSuiCoins(owner: string): Promise<{ objectId: string; version: string; digest: string }[]> {
  const res = (await getSuiClient().core.listOwnedObjects({
    owner,
    type: `0x2::coin::Coin<${SUI_TYPE}>`,
  })) as { objects?: { objectId: string; version: string | number; digest: string }[] }
  return (res.objects ?? []).map((o) => ({ objectId: o.objectId, version: String(o.version), digest: o.digest }))
}

type Build = (tx: Transaction, coins: { objectId: string }[], sponsored: boolean) => void

/**
 * Consolidate the wallet's coins into one spendable input.
 *
 * Splitting from coins[0] alone is wrong: a wallet holding 0.06 SUI as two 0.03 coins cannot send
 * 0.04, and fails with a bare "InsufficientCoinBalance in command 0" that reads like the wallet is
 * empty. Merge first so the whole balance is reachable.
 *
 * When SELF-PAID we must leave one coin behind for the node's gas selection — every coin consumed
 * as a command input is unavailable to pay for the transaction. Under sponsorship Shinami provides
 * gas, so everything can be merged and the whole balance really is spendable.
 */
function consolidate(tx: Transaction, coins: { objectId: string }[], sponsored: boolean) {
  const usable = sponsored ? coins : coins.slice(0, Math.max(1, coins.length - 1))
  const primary = tx.object(usable[0].objectId)
  if (usable.length > 1) tx.mergeCoins(primary, usable.slice(1).map((c) => tx.object(c.objectId)))
  return primary
}

/**
 * Sponsor if we can, self-pay if we cannot. A gas station outage should degrade the wallet, not
 * brick it — but the two paths produce DIFFERENT spend arithmetic, which is why FrozenTx carries
 * gasPaidBySponsor and the evidence layer reads it back off the built transaction.
 */
async function buildAndFreeze(sender: string, build: Build): Promise<FrozenTx> {
  const client = getSuiClient()
  const coins = await ownedSuiCoins(sender)
  if (!coins.length) {
    throw new Error(
      `No SUI coin objects at ${sender}. Fund it with \`npm run fund -- ${sender} 0.2\` (twice, so ` +
        `there are at least two coins).`
    )
  }

  if (hasGasStation()) {
    try {
      const { GasStationClient, buildGaslessTransaction } = await shinami()
      const gas = new GasStationClient(process.env.SHINAMI_GAS_STATION_ACCESS_KEY!)
      const gasless = await buildGaslessTransaction((tx: Transaction) => build(tx, coins, true), {
        sender,
        gasBudget: 10_000_000,
        sui: client,
      })
      const sp = await gas.sponsorTransaction(gasless)
      const bytes = Uint8Array.from(Buffer.from(sp.txBytes, 'base64'))
      // Recover the digest from the FINAL bytes, not from our pre-sponsorship builder.
      const digest = await Transaction.from(bytes).getDigest()
      return { bytes, sha256: sha256(bytes), digest, sender, sponsorSignature: sp.signature, gasPaidBySponsor: true }
    } catch (e) {
      console.warn('[gas station] sponsorship failed, falling back to self-paid:', (e as Error).message?.slice(0, 140))
    }
  }

  // Self-paid fallback. Gas is left UNSET so the node selects — from coin objects or from a SIP-58
  // address balance. Note that is not the same as setGasPayment([]), which injects a random nonce.
  const tx = new Transaction()
  tx.setSender(sender)
  build(tx, coins, false)
  const bytes = await tx.build({ client })
  const digest = await tx.getDigest() // a Promise in 2.29 — await it
  return { bytes, sha256: sha256(bytes), digest, sender, gasPaidBySponsor: false }
}

/** A bounded transfer, sourced from the wallet's own coins — never from tx.gas. */
export async function buildTransfer(sender: string, to: string, amountMist: bigint): Promise<FrozenTx> {
  return buildAndFreeze(sender, (tx, coins, sponsored) => {
    const [coin] = tx.splitCoins(consolidate(tx, coins, sponsored), [amountMist])
    tx.transferObjects([coin], to)
  })
}

/**
 * "Transfer all my funds" — the drain. Merges every coin object into the first and sends it, which
 * under sponsorship really is the whole balance: with gas covered by Shinami the wallet needs no
 * reserve, so there is nothing left behind.
 */
export async function buildTransferAll(sender: string, to: string): Promise<FrozenTx> {
  return buildAndFreeze(sender, (tx, coins, sponsored) => {
    tx.transferObjects([consolidate(tx, coins, sponsored)], to)
  })
}
