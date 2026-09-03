import { buildSwap } from '../lib/tx'
import { getSuiClient, SUI_TYPE } from '../lib/sui'
import { Transaction } from '@mysten/sui/transactions'
const WALLETS = [
  ['RICH  0x58baf5de', '0x58baf5de9454ce6e6d17ebcf7d31513d700d012f304b16ef02e4a5b187cd9c13'],
  ['MID   0xb9b81ffd', '0xb9b81ffd9f29aefd39042bf4a75e764b99c72621907d04a1f404bfa74426535d'],
]
const c = getSuiClient()
for (const [label, a] of WALLETS) {
  const b: any = await c.core.getBalance({ owner: a, coinType: SUI_TYPE })
  const o: any = await c.core.listOwnedObjects({ owner: a, type: `0x2::coin::Coin<${SUI_TYPE}>` })
  console.log(`\n=== ${label} coinObjs=${(o.objects??[]).length} coinBal=${b.balance.coinBalance} addrBal=${b.balance.addressBalance}`)
  for (const attempt of [1,2]) {
    try {
      const f = await buildSwap(a, 'SUI_DBUSDC', 2, 0)
      const d: any = Transaction.from(f.bytes).getData()
      console.log(`  try${attempt}: sponsored=${f.gasPaidBySponsor} budget=${d.gasData?.budget} cmds=` +
        d.commands.map((x:any)=> x.MoveCall?`${x.MoveCall.module}::${x.MoveCall.function}`:(x.SplitCoins?`Split(${x.SplitCoins.coin.$kind})`:Object.keys(x).filter(k=>k!=='$kind')[0])).join('|'))
    } catch (e:any) { console.log(`  try${attempt}: FAILED ${String(e.message).split('\n')[0].slice(0,120)}`) }
  }
}
