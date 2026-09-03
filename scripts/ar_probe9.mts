import { Transaction } from '@mysten/sui/transactions'
import { getSuiClient } from '../lib/sui'
import { simulate } from '../lib/evidence'

const COIN_OBJ = '0x8e1e504fbf0c54d43e948951f50f3710fff83bb91ee2c911509118ed1331f5ef' // 23k SUI, all coin OBJECTS
const ADDR_BAL = '0x451ed405c40e86ae973afe9721a0fbd30f1f4007d9fc5d7f04cf8f782a5a75da' // 202 SUI, all ADDRESS BALANCE
const POOL = 'SUI_DBUSDC'
const AMT = 2
const MINOUT = 1.361844

const { DeepBookClient } = await import('@mysten/deepbook-v3')
const client = getSuiClient()

// self-paid control pair: identical PTB, only the sender's funding SHAPE differs
for (const sender of [ADDR_BAL, COIN_OBJ]) {
  for (const budget of [10_000_000, 30_000_000]) {
    try {
      const tx = new Transaction()
      tx.setSender(sender)
      tx.setGasBudget(budget)
      const db = new DeepBookClient({ address: sender, network: 'testnet', client: client as never })
      const [b, q, d] = tx.add(db.deepBook.swapExactBaseForQuote({ poolKey: POOL, amount: AMT, deepAmount: 0, minOut: MINOUT }))
      tx.transferObjects([b, q, d], sender)
      const bytes = await tx.build({ client })
      const cmds = (Transaction.from(bytes).getData().commands as any[]).map((c) => c.$kind)
      const sim = await simulate(bytes, sender)
      if (sim.kind === 'ok') {
        const g = sim.evidence.gasUsed
        const net = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate)
        console.log(`${sender.slice(0, 10)} self-paid budget ${budget}: OK net=${net} ${JSON.stringify(g)} cmds=${cmds.join(',')}`)
      } else {
        console.log(`${sender.slice(0, 10)} self-paid budget ${budget}: ${sim.kind} ${sim.error}`)
      }
    } catch (e) {
      console.log(`${sender.slice(0, 10)} budget ${budget}: THREW ${(e as Error).message.slice(0, 160)}`)
    }
  }
}
