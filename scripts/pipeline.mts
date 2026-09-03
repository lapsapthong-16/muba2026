/**
 * End-to-end pipeline check against live testnet:
 *   build gasless -> Shinami sponsors -> freeze -> simulate -> evidence -> verdict
 *
 *   npm run pipeline
 *
 * Uses the throwaway wallet in .env.probe. If it has no coins, it tells you how to fund it.
 * Nothing here signs or broadcasts — it stops at the verdict.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { assertChain, getBalance, NETWORK, SUI_TYPE, getSuiClient } from '../lib/sui'
import { buildTransfer, buildTransferAll, type FrozenTx } from '../lib/tx'
import { simulate } from '../lib/evidence'
import { PolicySchema, evaluate } from '../lib/policy/policy'
import { gate } from '../lib/gate'

const ATTACKER = '0xbadb00000000000000000000000000000000000000000000000000000000bad0'

let sk = existsSync('.env.probe') ? readFileSync('.env.probe', 'utf8').trim() : ''
const kp = sk ? Ed25519Keypair.fromSecretKey(sk) : Ed25519Keypair.generate()
if (!sk) writeFileSync('.env.probe', kp.getSecretKey(), { mode: 0o600 })
const ME = kp.toSuiAddress()

console.log(`chain   : ${NETWORK} ${await assertChain()}`)
console.log(`wallet  : ${ME}`)
console.log(`balance : ${Number(await getBalance(ME)) / 1e9} SUI`)
console.log(`sponsor : ${process.env.SHINAMI_GAS_STATION_ACCESS_KEY ? 'Shinami gas station' : 'NONE — self-paid fallback'}`)

const owned = (await getSuiClient().core.listOwnedObjects({
  owner: ME, type: `0x2::coin::Coin<${SUI_TYPE}>`,
})) as { objects?: unknown[] }
const nCoins = (owned.objects ?? []).length
console.log(`coins   : ${nCoins} object(s)`)
if (nCoins < 2) {
  console.log(`\nFund it first (twice, so gas selection has a spare coin):`)
  console.log(`  npm run fund -- ${ME} 0.1`)
  console.log(`  npm run fund -- ${ME} 0.1`)
  process.exit(0)
}

const policy = PolicySchema.parse({
  version: 1,
  walletAddress: ME,
  caps: [{ coinType: SUI_TYPE, symbol: 'SUI', decimals: 9, perTxLimit: '20000000', weeklyLimit: '5000000000' }],
  allowedRecipients: [],
  allowedPackages: [{ packageId: '0x2', label: 'Sui Framework' }],
})

async function run(name: string, build: () => Promise<FrozenTx>) {
  console.log(`\n${'='.repeat(66)}\n${name}\n${'='.repeat(66)}`)
  let f: FrozenTx
  try {
    f = await build()
  } catch (e) {
    console.log(`BUILD FAILED: ${e instanceof Error ? e.message.split('\n')[0] : e}`)
    return
  }
  console.log(`gas paid by : ${f.gasPaidBySponsor ? 'SHINAMI (sponsored)' : 'the wallet (self-paid fallback)'}`)
  console.log(`digest      : ${f.digest}`)
  console.log(`sha256      : ${f.sha256.slice(0, 24)}…   re-checked before signing`)
  console.log(`signatures  : ${f.sponsorSignature ? 'ours + sponsor' : 'ours only'}`)

  const sim = await simulate(f.bytes, ME)
  if (sim.kind !== 'ok') {
    console.log(`simulation  : ${sim.kind.toUpperCase()} — ${sim.error.split('\n')[0].slice(0, 130)}`)
    return
  }
  const ev = sim.evidence
  console.log(`\nEVIDENCE  (gasPaidBySender=${ev.gasPaidBySender})`)
  for (const b of ev.balanceChanges) {
    const who = b.address === ME ? 'agent wallet' : b.address === ATTACKER ? 'attacker' : 'sponsor'
    console.log(`  ${who.padEnd(14)} ${String(b.amount).padStart(15)}`)
  }

  const v = evaluate(policy, ev, () => 0n)
  for (const o of v.outflows) console.log(`  spend: ${o.principal} MIST (gas excluded correctly)`)
  const d = gate(sim, v, null)
  console.log(`\nVERDICT     : ${d.outcome.toUpperCase()}  [${d.rule}]`)
  for (const r of d.reasons) console.log(`  · ${r}`)
}

await run('SAFE — 0.01 SUI, under the 0.02 per-tx limit', () => buildTransfer(ME, ATTACKER, 10_000_000n))
await run('MALICIOUS — transfer all funds to a random address', () => buildTransferAll(ME, ATTACKER))
