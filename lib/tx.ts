import { Transaction } from '@mysten/sui/transactions'
import { createHash } from 'node:crypto'
import { getSuiClient, getBalance, SUI_TYPE } from './sui'

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
 * Build a transaction, have Shinami sponsor the gas, and freeze the result.
 *
 * ORDERING IS THE WHOLE POINT. Sponsorship REPLACES the bytes: a gasless transaction is txKind
 * only (verified: 140 bytes, no gas data), and Shinami returns a complete transaction with gasData
 * filled in. The freeze therefore happens AFTER sponsorship, on the bytes that will actually
 * execute — freezing before would bind us to bytes Shinami discards, silently breaking "the bytes
 * that were scored are the bytes that get signed".
 *
 * FUNDS COME FROM tx.coin(), NEVER tx.gas. Two reasons:
 *   1. Under sponsorship gasData.owner is Shinami, so tx.gas is THEIR coin. Splitting or
 *      transferring it would move the sponsor's money. It is not even constructible — a gasless
 *      build rejects tx.gas outright.
 *   2. A Sui address holds SUI either as Coin<SUI> OBJECTS or as a SIP-58 ADDRESS BALANCE, and
 *      which one you get depends on how the sender paid you. tx.coin() is documented as "sourced
 *      from address balance when available, falling back to owned coins", so it handles both.
 *      Hand-rolling coin selection means throwing "no coins" at wallets that are perfectly funded.
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

/** Leave this much behind when WE pay gas. Ignored under sponsorship. */
const SELF_PAID_GAS_RESERVE = 5_000_000n

type Build = (tx: Transaction, sponsored: boolean) => void

async function buildAndFreeze(sender: string, build: Build): Promise<FrozenTx> {
  const client = getSuiClient()

  if (hasGasStation()) {
    try {
      const { GasStationClient, buildGaslessTransaction } = await shinami()
      const gas = new GasStationClient(process.env.SHINAMI_GAS_STATION_ACCESS_KEY!)
      const gasless = await buildGaslessTransaction(
        (tx: Transaction) => {
          // setSender must come FIRST inside this callback: tx.coin() resolves a
          // CoinWithBalance input against the sender, and without it the build fails with
          // "Sender must be set to resolve CoinWithBalance".
          tx.setSender(sender)
          build(tx, true)
        },
        { sender, gasBudget: 10_000_000, sui: client }
      )
      const sp = await gas.sponsorTransaction(gasless)
      const bytes = Uint8Array.from(Buffer.from(sp.txBytes, 'base64'))
      // Recover the digest from the FINAL bytes, not from our pre-sponsorship builder.
      const digest = await Transaction.from(bytes).getDigest()
      return { bytes, sha256: sha256(bytes), digest, sender, sponsorSignature: sp.signature, gasPaidBySponsor: true }
    } catch (e) {
      console.warn('[gas station] sponsorship failed, falling back to self-paid:', (e as Error).message?.slice(0, 160))
    }
  }

  // Self-paid fallback. Gas is left UNSET so the node selects — from coin objects or from an
  // address balance. That is NOT the same as setGasPayment([]), which injects a random nonce.
  const tx = new Transaction()
  tx.setSender(sender)
  build(tx, false)
  const bytes = await tx.build({ client })
  const digest = await tx.getDigest() // a Promise in 2.29 — await it
  return { bytes, sha256: sha256(bytes), digest, sender, gasPaidBySponsor: false }
}

/** A bounded transfer. Works whether the wallet holds coin objects or an address balance. */
export async function buildTransfer(sender: string, to: string, amountMist: bigint): Promise<FrozenTx> {
  return buildAndFreeze(sender, (tx, sponsored) => {
    const coin = tx.coin({ balance: amountMist, type: SUI_TYPE, useGasCoin: !sponsored })
    tx.transferObjects([coin], to)
  })
}

/**
 * "Transfer all my funds" — the drain. Under sponsorship this really is the whole balance: with
 * gas covered by Shinami the wallet needs no reserve, so nothing is left behind. On the self-paid
 * fallback we hold back enough to pay for the transaction itself.
 */
export async function buildTransferAll(sender: string, to: string): Promise<FrozenTx> {
  const balance = await getBalance(sender)
  if (balance <= SELF_PAID_GAS_RESERVE) {
    throw new Error(`${sender} holds ${balance} MIST, which is too little to move.`)
  }
  const sponsoredAmount = balance
  const selfPaidAmount = balance - SELF_PAID_GAS_RESERVE
  return buildAndFreeze(sender, (tx, sponsored) => {
    const coin = tx.coin({
      balance: sponsored ? sponsoredAmount : selfPaidAmount,
      type: SUI_TYPE,
      useGasCoin: !sponsored,
    })
    tx.transferObjects([coin], to)
  })
}
