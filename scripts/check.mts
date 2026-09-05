/**
 * The transaction checker, shown stage by stage.
 *
 *   npm run check -- <to-address> <amountSui>
 *   npm run check                              # runs a built-in safe + drain pair
 *
 * Builds a real transaction, simulates it on chain, reduces the simulation to deterministic
 * evidence, asks Gonka to score that evidence 0-100, and applies the gate. Nothing is signed.
 */
import { getDb } from '../lib/db'
import { assertChain, NETWORK, SUI_DECIMALS, getBalance } from '../lib/sui'
import { buildTransfer, buildTransferAll, type FrozenTx } from '../lib/tx'
import { simulate } from '../lib/evidence'
import { PolicySchema, evaluate } from '../lib/policy/policy'
import { requestConsensus, RISK_BANDS } from '../lib/ballot'
import { gate } from '../lib/gate'
import { spentLast7d } from '../lib/db'

const acct = getDb()
  .prepare(`SELECT a.id, w.h_address, w.policy_json FROM accounts a JOIN wallets w ON w.account_id=a.id
            WHERE w.h_address != '' AND w.policy_json IS NOT NULL ORDER BY a.created_at DESC LIMIT 1`)
  .get() as { id: string; h_address: string; policy_json: string } | undefined
if (!acct) {
  console.error('No configured wallet. Run `npm run onboard` first.')
  process.exit(1)
}
const policy = PolicySchema.parse(JSON.parse(acct.policy_json))
const ME = acct.h_address
const fmt = (m: bigint) => (Number(m) / 10 ** SUI_DECIMALS).toFixed(6).replace(/\.?0+$/, '')

const [, , argTo, argAmt] = process.argv
const cases: { title: string; to: string; amount: number | 'all'; reason: string }[] = argTo
  ? [{ title: 'requested', to: argTo, amount: argAmt === 'all' ? 'all' : Number(argAmt ?? 0.001), reason: 'manual check' }]
  : [
      { title: 'A small payment to an address on your approved list', to: policy.allowedRecipients[0]?.address ?? '0x1111111111111111111111111111111111111111111111111111111111111111', amount: 0.001, reason: 'paying a friend back' },
      { title: 'Everything you own, to a stranger', to: '0xbadb00000000000000000000000000000000000000000000000000000000bad0', amount: 'all', reason: 'claim your free airdrop, limited time' },
    ]

console.log(`chain  : ${NETWORK} ${await assertChain()}`)
console.log(`wallet : ${ME}`)
console.log(`balance: ${fmt(await getBalance(ME))} SUI`)
console.log(`bands  : score <${RISK_BANDS.low} low · <${RISK_BANDS.medium} medium · else high`)

for (const c of cases) {
  console.log(`\n${'═'.repeat(72)}\n  ${c.title}\n${'═'.repeat(72)}`)
  console.log(`  agent says: "${c.reason}"`)
  console.log(`  wants     : ${c.amount === 'all' ? 'everything' : c.amount + ' SUI'} -> ${c.to.slice(0, 18)}…`)

  let f: FrozenTx
  try {
    f = c.amount === 'all'
      ? await buildTransferAll(ME, c.to)
      : await buildTransfer(ME, c.to, BigInt(Math.round(c.amount * 10 ** SUI_DECIMALS)))
  } catch (e) {
    console.log(`\n  ① BUILD failed: ${e instanceof Error ? e.message.split('\n')[0] : e}`)
    continue
  }
  console.log(`\n  ① BUILT      ${f.bytes.length} bytes · gas by ${f.gasPaidBySponsor ? 'Shinami' : 'the wallet'} · digest ${f.digest.slice(0, 16)}…`)

  const sim = await simulate(f.bytes, ME)
  if (sim.kind !== 'ok') {
    console.log(`  ② SIMULATE   ${sim.kind.toUpperCase()} — ${sim.error.split('\n')[0].slice(0, 90)}`)
    continue
  }
  console.log(`  ② SIMULATED  on chain, no signature, nothing broadcast`)

  const ev = sim.evidence
  console.log(`  ③ EVIDENCE`)
  for (const b of ev.balanceChanges) {
    const who = b.address === ME ? 'the wallet' : b.address === ev.gasOwner ? 'gas sponsor' : 'recipient '
    console.log(`       ${who}  ${fmt(BigInt(b.amount)).padStart(12)} SUI`)
  }
  if (ev.objectTransfers?.length) {
    for (const o of ev.objectTransfers) console.log(`       object leaving: ${o.objectType} -> ${o.to.slice(0, 12)}… ${o.isCapability ? '(A PERMISSION OBJECT)' : ''}`)
  }

  const t0 = Date.now()
  const consensus = await requestConsensus(ev, ME, c.reason)
  console.log(`  ④ GONKA      ${Date.now() - t0}ms`)
  for (const vote of consensus.votes) {
    if (vote.ok) console.log(`       ${vote.model}: ${vote.ballot!.score}/100 ${vote.ballot!.risk} · ${vote.requestId}`)
    else console.log(`       ${vote.model}: unavailable (${vote.abstainReason})`)
  }

  const verdict = evaluate(policy, ev, (ct) => spentLast7d(acct!.id, ct))
  const d = gate(sim, verdict, consensus)
  console.log(`  ⑤ GATE       ${d.outcome.toUpperCase()}  [${d.rule}]`)
  for (const r of d.reasons) console.log(`       · ${r}`)
}
console.log()
