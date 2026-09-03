import { buildSwap } from '../lib/tx'
import { simulate } from '../lib/evidence'
import { Transaction } from '@mysten/sui/transactions'
const A = '0xb9b81ffd9f29aefd39042bf4a75e764b99c72621907d04a1f404bfa74426535d' // 8.03 SUI, 8.0 in COIN OBJECTS
const f = await buildSwap(A, 'SUI_DBUSDC', 2, 0)
const d: any = Transaction.from(f.bytes).getData()
console.log('BUILT. gasPaidBySponsor=', f.gasPaidBySponsor, 'budget=', d.gasData?.budget)
console.log('cmds:', d.commands.map((x:any)=> x.MoveCall?`${x.MoveCall.package.slice(0,6)}::${x.MoveCall.module}::${x.MoveCall.function}`:(x.SplitCoins?`Split(${JSON.stringify(x.SplitCoins.coin)})`:Object.keys(x).filter(k=>k!=='$kind')[0])).join(' | '))
const sim = await simulate(f.bytes, A)
console.log('sim.kind =', sim.kind)
if (sim.kind === 'ok') {
  console.log('balanceChanges:', sim.evidence.balanceChanges.map(b=>`${b.coinType.split('::').pop()} ${b.amount}`).join(' , '))
  console.log('gasPaidBySender=', sim.evidence.gasPaidBySender)
} else console.log('err:', (sim as any).error?.slice(0,200))
