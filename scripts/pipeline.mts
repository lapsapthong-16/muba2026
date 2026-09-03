/**
 * End-to-end pipeline check: build -> freeze -> simulate -> evidence -> verdict.
 *
 *   npm run pipeline
 *
 * Runs unfunded (mocked gas) unless .env.test holds a funded DEV_SECRET_KEY, in which case it
 * pins real gas coins and the numbers on screen are the true ones.
 */
import { readFileSync, existsSync } from 'node:fs'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { assertChain, getBalance, NETWORK, SUI_TYPE } from '../lib/sui'
import { buildTransfer, buildTransferAll, buildTransferUnfunded } from '../lib/tx'
import { simulate } from '../lib/evidence'
import { PolicySchema, evaluate } from '../lib/policy/policy'

const ATTACKER = '0xbadb00000000000000000000000000000000000000000000000000000000bad0'

const env = existsSync('.env.test') ? readFileSync('.env.test', 'utf8') : ''
const sk = env.match(/DEV_SECRET_KEY=(\S+)/)?.[1]
const kp = sk ? Ed25519Keypair.fromSecretKey(sk) : Ed25519Keypair.generate()
const ME = kp.toSuiAddress()

console.log(`chain      : ${NETWORK} ${await assertChain()}`)
console.log(`wallet     : ${ME}`)
const balance = await getBalance(ME)
const funded = balance > 20_000_000n
console.log(`balance    : ${balance} MIST${funded ? '' : '   <-- UNFUNDED: gas is mocked, amounts are not real'}\n`)

const policy = PolicySchema.parse({
  version: 1,
  walletAddress: ME,
  caps: [{ coinType: SUI_TYPE, symbol: 'SUI', decimals: 9, perTxLimit: '2000000000', weeklyLimit: '10000000000' }],
  allowedRecipients: [],
  allowedPackages: [{ packageId: '0x2', label: 'Sui Framework' }],
})

async function run(name: string, build: () => Promise<any>) {
  console.log(`\n${'='.repeat(64)}\n${name}\n${'='.repeat(64)}`)
  let frozen
  try {
    frozen = await build()
  } catch (e) {
    console.log(`BUILD FAILED: ${e instanceof Error ? e.message.split('\n')[0] : e}`)
    return
  }
  console.log(`digest     : ${frozen.digest}`)
  console.log(`sha256     : ${frozen.sha256.slice(0, 32)}…  (re-checked before every signature)`)

  const sim = await simulate(frozen.bytes, ME, funded ? {} : { doGasSelection: false })
  if (sim.kind !== 'ok') {
    console.log(`simulation : ${sim.kind.toUpperCase()} — ${sim.error.split('\n')[0].slice(0, 120)}`)
    return
  }
  const ev = sim.evidence
  console.log(`\nEVIDENCE`)
  for (const b of ev.balanceChanges) {
    const who = b.address === ME ? 'me      ' : `${b.address.slice(0, 8)}…`
    console.log(`  ${who} ${b.amount.padStart(22)}  ${b.coinType.split('::').pop()}`)
  }
  console.log(`  gas      ${ev.gasUsed.computationCost} + ${ev.gasUsed.storageCost} - ${ev.gasUsed.storageRebate}`)
  console.log(`  packages ${ev.movePackages.join(', ') || '(none)'}`)
  console.log(`  objects  ${ev.objectTransfers?.length ? JSON.stringify(ev.objectTransfers) : '(none leaving)'}`)

  const v = evaluate(policy, ev, () => 0n)
  console.log(`\nVERDICT    : ${v.verdict.toUpperCase()}`)
  for (const r of v.reasons) console.log(`  [${r.rule}] ${r.human}`)
  for (const o of v.outflows) console.log(`  spend: ${o.principal} ${o.symbol} base units (gas excluded)`)
}

await run('SAFE — send 1 SUI, under the 2 SUI per-tx limit', () =>
  funded ? buildTransfer(ME, ATTACKER, 1_000_000_000n) : buildTransferUnfunded(ME, ATTACKER, 1_000_000_000n))

await run('MALICIOUS — transfer all my funds to a random address', () =>
  funded ? buildTransferAll(ME, ATTACKER) : buildTransferUnfunded(ME, ATTACKER, 999_000_000_000n))

console.log(`\n${funded ? '' : 'NOTE: unfunded run. Fund the wallet above to see true amounts.\n'}`)
