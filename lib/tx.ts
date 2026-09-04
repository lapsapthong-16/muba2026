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

/**
 * Enough for a transfer, and NOT enough for a DeepBook swap — measured, the swap consumes
 * 11,502,220 MIST and a sponsored build at 10,000,000 fails simulation with InsufficientGas, which
 * the gate then reports as SIMULATION_FAILED. Callers that need more say so.
 */
const DEFAULT_GAS_BUDGET = 10_000_000

async function buildAndFreeze(sender: string, build: Build, gasBudget = DEFAULT_GAS_BUDGET): Promise<FrozenTx> {
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
        { sender, gasBudget, sui: client }
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

/**
 * Owned Coin<SUI> object ids, plus how much SUI sits in coin objects rather than in the address
 * balance.
 *
 * listOwnedObjects returns objectId/version/digest/type/owner and NO balance field — an earlier
 * version read `o.balance`, got undefined for every coin, and silently concluded the wallet had
 * nothing spendable. getBalance splits the total into coinBalance vs addressBalance, so ask it.
 */
async function suiCoins(owner: string): Promise<{ ids: string[]; coinBalance: bigint }> {
  try {
    const [objs, bal] = await Promise.all([
      getSuiClient().core.listOwnedObjects({ owner, type: `0x2::coin::Coin<${SUI_TYPE}>` }) as Promise<{
        objects?: { objectId: string }[]
      }>,
      getSuiClient().core.getBalance({ owner, coinType: SUI_TYPE }) as Promise<{
        balance: { coinBalance?: string }
      }>,
    ])
    return {
      ids: (objs.objects ?? []).map((o) => o.objectId),
      coinBalance: BigInt(bal.balance.coinBalance ?? 0),
    }
  } catch {
    return { ids: [], coinBalance: 0n }
  }
}

/**
 * A bounded transfer.
 *
 * SHAPE MATTERS FOR THE LEDGER. tx.coin() is the robust source — it spends an address balance or
 * owned coins — but it expands into 0x2::coin::redeem_funds and send_funds MoveCalls, and the Sui
 * Ledger app clear-signs only a small set of shapes. A MoveCall is not one of them, so the device
 * falls back to blind signing a bare hash, which defeats the point of asking a human at all.
 *
 * So when the wallet holds coin objects we build the plain SplitCoins -> TransferObjects shape,
 * which is what the device can actually read out. Address-balance-only wallets still work, they
 * just blind-sign — and `npm run fund` produces coin objects precisely so escalations stay
 * readable.
 */
export async function buildTransfer(sender: string, to: string, amountMist: bigint): Promise<FrozenTx> {
  const { ids, coinBalance } = await suiCoins(sender)
  // Only take the readable path if coin objects alone cover the amount; otherwise we would have to
  // top up from the address balance and be back to a MoveCall anyway.
  const clearSignable = ids.length > 0 && coinBalance >= amountMist

  return buildAndFreeze(sender, (tx, sponsored) => {
    if (clearSignable) {
      const primary = tx.object(ids[0])
      if (ids.length > 1) tx.mergeCoins(primary, ids.slice(1).map((id) => tx.object(id)))
      const [coin] = tx.splitCoins(primary, [amountMist])
      tx.transferObjects([coin], to)
    } else {
      tx.transferObjects([tx.coin({ balance: amountMist, type: SUI_TYPE, useGasCoin: !sponsored })], to)
    }
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
  // Same clear-signing preference as buildTransfer: if every last MIST is already in coin objects
  // we can hand the device a plain transfer. If any of it sits in the address balance we must go
  // through tx.coin()'s MoveCalls, and the device will blind-sign.
  const { ids, coinBalance } = await suiCoins(sender)
  const allInCoins = ids.length > 0 && coinBalance === balance

  return buildAndFreeze(sender, (tx, sponsored) => {
    if (allInCoins && sponsored) {
      const primary = tx.object(ids[0])
      if (ids.length > 1) tx.mergeCoins(primary, ids.slice(1).map((id) => tx.object(id)))
      tx.transferObjects([primary], to)
      return
    }
    tx.transferObjects(
      [tx.coin({ balance: sponsored ? sponsoredAmount : selfPaidAmount, type: SUI_TYPE, useGasCoin: !sponsored })],
      to
    )
  })
}

/**
 * A DeepBook swap — the agent's "real work" action, and the safe half of the demo.
 *
 * Sponsorable without special handling: DeepBook sources its input with coinWithBalance, the same
 * primitive tx.coin() uses, so it never touches tx.gas and the sponsor's coin is left alone.
 *
 * The three coins the swap returns MUST be transferred back. SUI has no implicit drop for Coin, so
 * a PTB that leaves them unconsumed does not type-check — and transferring them to the sender is
 * also what makes the trade legible to the risk engine: value leaves and value returns, in the same
 * transaction, which is exactly the shape a plain drain does not have.
 *
 * NOTE ON SIZE. The SUI_DBUSDC book has minSize 1 and lotSize 0.1, but the real floor is neither:
 * measured live it returns quoteOut 0 at 1.0 SUI and fills from 1.1 (1.1 -> 0.724, 1.2 -> 0.7964,
 * 1.5 -> 1.0136, 2 -> 1.3756). That floor is a property of the resting orders, not of the pool
 * config, so it MOVES. Never hard-code it — quote first and refuse a zero-output trade.
 *
 * WE SUPPLY THE BASE COIN OURSELVES. Left to itself the SDK calls coinWithBalance({type, balance})
 * with no useGasCoin, and that flag DEFAULTS TO TRUE for SUI — so the resolver looks only at the
 * address balance and, when that is short, emits a GasCoin input. Under sponsorship the gas coin is
 * SHINAMI'S, and their RPC rejects the whole transaction with a bare "Invalid params". Since
 * `npm run fund` delivers coin OBJECTS rather than an address balance, that is the shape every
 * funded demo wallet is actually in, and the swap would silently self-pay every time. Passing
 * params.baseCoin short-circuits the default (verified at deepbook.ts:806 — `params.baseCoin ??`),
 * so sponsorship holds no matter how the wallet was funded.
 */
export async function buildSwap(
  sender: string,
  poolKey: string,
  amount: number,
  minOut: number
): Promise<FrozenTx> {
  const { DeepBookClient } = await import('@mysten/deepbook-v3')
  // DYNAMIC, to match how DeepBook itself loads it. @mysten/sui ships both a CJS and an ESM build
  // from one package, so a static import here resolves to CJS while DeepBook's ESM import resolves
  // to the ESM copy — two module instances, two different coinWithBalance functions, and
  // addIntentResolver throws when the same intent arrives with a different function reference.
  // Loading it the same way DeepBook does puts us in the same instance.
  const { coinWithBalance } = await import('@mysten/sui/transactions')
  return buildAndFreeze(
    sender,
    (tx, sponsored) => {
    const db = new DeepBookClient({
      address: sender,
      network: 'testnet',
      client: getSuiClient() as never,
    })
    const [baseOut, quoteOut, deepOut] = tx.add(
      db.deepBook.swapExactBaseForQuote({
        poolKey,
        amount,
        deepAmount: 0,
        minOut,
        baseCoin: coinWithBalance({
          type: SUI_TYPE,
          balance: BigInt(Math.round(amount * 1e9)),
          useGasCoin: !sponsored,
        }),
      } as never)
    )
    // Everything the pool hands back goes to the wallet. Leaving any of it unconsumed is a
    // compile error, not a silent leak — Move's ability system will not let the PTB close.
    tx.transferObjects([baseOut, quoteOut, deepOut], sender)
    },
    // The swap really costs 11,502,220 MIST. 10,000,000 builds fine and then dies in simulation.
    30_000_000
  )
}

/** Live quote, so we never build a swap the book cannot fill. */
export async function quoteSwap(poolKey: string, amount: number) {
  const { DeepBookClient } = await import('@mysten/deepbook-v3')
  const db = new DeepBookClient({ address: '0x0', network: 'testnet', client: getSuiClient() as never })
  return (db as unknown as {
    getQuoteQuantityOutInputFee(p: string, a: number): Promise<{ quoteOut: number; deepRequired: number }>
  }).getQuoteQuantityOutInputFee(poolKey, amount)
}

/**
 * SUI priced in USD, from the order book we already trade on.
 *
 * A USD spending cap needs a price, and the honest place to get one is the same book the wallet
 * actually fills against — DBUSDC is a dollar stand-in, so the SUI_DBUSDC mid price IS the price
 * this wallet would really get. No oracle, no API key, no third party to be down.
 *
 * Returns null rather than guessing. A cap denominated against a made-up price is worse than a cap
 * the human had to state in SUI.
 */
export async function suiUsdPrice(): Promise<number | null> {
  try {
    const { DeepBookClient } = await import('@mysten/deepbook-v3')
    const db = new DeepBookClient({ address: '0x0', network: 'testnet', client: getSuiClient() as never })
    const mid = await (db as unknown as { midPrice(pool: string): Promise<number> }).midPrice('SUI_DBUSDC')
    return typeof mid === 'number' && mid > 0 ? mid : null
  } catch {
    return null
  }
}
