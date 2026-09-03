/**
 * Run both demo instructions against your most recently created wallet.
 *
 *   npm run demo
 *
 * Reads the account straight from sqlite, so there are no shell variables to lose. This drives
 * the SAME pipeline the MCP tools call — build, sponsor, freeze, simulate, evidence, gate — it
 * just skips the HTTP transport, which is already proven.
 *
 * Stop the dev server first if you hit a database lock.
 */
import { getDb } from '../lib/db'
import { getBalance, NETWORK, assertChain, SUI_TYPE, getSuiClient } from '../lib/sui'
import { walletStatus, submitTransfer } from '../lib/wallet'

const FRIEND = '0x1111111111111111111111111111111111111111111111111111111111111111'
const ATTACKER = '0xbadb00000000000000000000000000000000000000000000000000000000bad0'

const acct = getDb()
  .prepare(`SELECT a.id FROM accounts a JOIN wallets w ON w.account_id = a.id
            WHERE w.h_address != '' AND w.policy_json IS NOT NULL
            ORDER BY a.created_at DESC LIMIT 1`)
  .get() as { id: string } | undefined

if (!acct) {
  console.error('No configured wallet found. Run `npm run onboard`, connect your Ledger, and set guardrails first.')
  process.exit(1)
}

console.log(`chain   : ${NETWORK} ${await assertChain()}`)
const st = (await walletStatus(acct.id)) as Record<string, any>
if (!st.wallet_ready) {
  console.error('Wallet is not ready:', JSON.stringify(st.missing))
  process.exit(1)
}
const H = st.spending_address as string
const M = st.protected_address as string

async function coins(a: string) {
  const r = (await getSuiClient().core.listOwnedObjects({ owner: a, type: `0x2::coin::Coin<${SUI_TYPE}>` })) as { objects?: unknown[] }
  return (r.objects ?? []).length
}

console.log(`spending: ${H}`)
console.log(`          ${Number(await getBalance(H)) / 1e9} SUI in ${await coins(H)} coin object(s)`)
console.log(`protected:${M}`)
console.log(`          ${Number(await getBalance(M)) / 1e9} SUI in ${await coins(M)} coin object(s)`)
console.log(`limits  : ${st.guardrails.per_transaction_limit_sui} SUI per payment, ${st.guardrails.weekly_limit_sui} SUI per week`)

async function go(title: string, args: { to: string; amount_sui: number | 'all'; reason: string }) {
  console.log(`\n${'─'.repeat(70)}\n${title}\n${'─'.repeat(70)}`)
  console.log(`  "${args.reason}" -> ${args.amount_sui} SUI to ${args.to.slice(0, 12)}…`)
  const r = (await submitTransfer(acct!.id, args)) as Record<string, any>
  console.log(`\n  outcome     : ${r.outcome}`)
  console.log(`  funds moved : ${r.funds_moved}`)
  if (r.rule) console.log(`  rule        : ${r.rule}`)
  for (const x of (r.reasons ?? []) as string[]) console.log(`     · ${x}`)
  if (r.digest) console.log(`  digest      : ${r.digest}\n  explorer    : ${r.explorer}`)
  if (r.approval_id) {
    console.log(`  approval id : ${r.approval_id}`)
    console.log(`  re-issued from: ${r.from}`)
    console.log(`  ${r.from === M ? '  ^ that is your PROTECTED address — needs your Ledger' : '  ^ UNEXPECTED: should be the protected address'}`)
    console.log(`\n  Now open /test in Chrome and approve it on your Ledger.`)
  }
}

const perTx = Number(st.guardrails.per_transaction_limit_sui)
const hSui = Number(await getBalance(H)) / 1e9
const mSui = Number(await getBalance(M)) / 1e9

// The limit has to sit BELOW what the wallet can actually send, or nothing ever escalates and
// there is no demo. Say so plainly rather than attempting a transfer that must fail.
if (perTx >= hSui) {
  console.error(
    `\n  Your per-payment limit (${perTx} SUI) is at or above your spending balance (${hSui} SUI),\n` +
      `  so no payment can ever exceed it and nothing will escalate to your Ledger.\n\n` +
      `  Open /guardrails and set the single payment limit to about ${(hSui / 4).toFixed(4)} SUI,\n` +
      `  keeping the weekly cap well above your balance. Then run this again.`
  )
  process.exit(1)
}
if (mSui <= 0.003) {
  console.error(
    `\n  Your protected address holds ${mSui} SUI, which is not enough to re-issue an escalated\n` +
      `  payment from. Top it up:  npm run fund -- ${M} 0.05`
  )
  process.exit(1)
}

const safeAmount = Math.max(0.001, Math.min(perTx / 2, hSui / 4))
const bigAmount = Math.min(Math.max(perTx * 1.5, perTx + 0.001), mSui * 0.7)

await go('1 · SAFE — under your per-payment limit', {
  to: FRIEND, amount_sui: round(safeAmount), reason: 'small test payment',
})
await go('2 · SUSPICIOUS — over your limit, to an address you never approved', {
  to: ATTACKER, amount_sui: round(bigAmount), reason: 'claim your free airdrop',
})

function round(n: number) {
  return Math.round(n * 1e6) / 1e6
}
