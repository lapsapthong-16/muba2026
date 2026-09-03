/**
 * Fund an agent wallet address from your own testnet wallet.
 *
 *   npm run fund -- 0x<address> [amountSui]
 *
 * The testnet HTTP faucet is IP-blocked (429 on every attempt across ~12 tries with backoff), so
 * this is the funding path. Reads PRIVATE_KEY from .env — a Sui bech32 secret key, the
 * `suiprivkey1…` string you get from `sui keytool export` or a wallet's export dialog.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { getSuiClient, getBalance, SUI_TYPE, NETWORK, assertChain } from '../lib/sui'

const [, , target, amountArg] = process.argv
if (!target?.startsWith('0x')) {
  console.error('usage: npm run fund -- 0x<address> [amountSui]   (default 0.5)')
  process.exit(1)
}
const amountSui = Number(amountArg ?? '0.5')
const amountMist = BigInt(Math.round(amountSui * 1e9))

const sk = process.env.PRIVATE_KEY
if (!sk) {
  console.error('PRIVATE_KEY is not set in .env. Put your testnet secret key there (suiprivkey1…).')
  process.exit(1)
}

const kp = Ed25519Keypair.fromSecretKey(sk.trim())
const from = kp.toSuiAddress()
const client = getSuiClient()

console.log(`network : ${NETWORK} ${await assertChain()}`)
console.log(`from    : ${from}`)
const before = await getBalance(from)
console.log(`balance : ${Number(before) / 1e9} SUI`)

// Keep a gas reserve so this wallet stays usable for the next top-up. A transfer costs about
// 2,000,000 MIST, so 5,000,000 is two transfers of headroom — 20,000,000 was ten times what is
// needed and made the funder look empty while it still held plenty.
const RESERVE = 5_000_000n
if (before < amountMist + RESERVE) {
  console.error(
    `\nNot enough. Need ${Number(amountMist + RESERVE) / 1e9} SUI (${amountSui} + 0.02 gas reserve), have ${Number(before) / 1e9}.`
  )
  process.exit(1)
}

const tx = new Transaction()
tx.setSender(from)
const [coin] = tx.splitCoins(tx.gas, [amountMist])
tx.transferObjects([coin], target)

const bytes = await tx.build({ client })
const { signature } = await kp.signTransaction(bytes)
const res = await client.core.executeTransaction({ transaction: bytes, signatures: [signature] })
const digest = (res as { Transaction?: { digest?: string } }).Transaction?.digest

console.log(`\nsent    : ${amountSui} SUI -> ${target}`)
console.log(`digest  : ${digest}`)
console.log(`explorer: https://suiscan.xyz/${NETWORK}/tx/${digest}`)

// The node needs a moment to reflect the new balance.
await new Promise((r) => setTimeout(r, 3000))
console.log(`\ntarget balance now: ${Number(await getBalance(target, SUI_TYPE)) / 1e9} SUI`)
