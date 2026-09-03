import { Transaction } from '@mysten/sui/transactions'
import { getSuiClient } from '../lib/sui'
import { simulate } from '../lib/evidence'

// A testnet address holding >= 2 SUI entirely in Coin<SUI> OBJECTS — the shape `npm run fund`
// gives the demo wallet (fund.mts:50-51 splits a coin and transfers the object).
const SENDER = '0x8e1e504fbf0c54d43e948951f50f3710fff83bb91ee2c911509118ed1331f5ef'
const POOL = 'SUI_DBUSDC'
const AMT = 2
const MINOUT = 1.361844

const { GasStationClient, buildGaslessTransaction } = await import('@shinami/clients/sui')
const { DeepBookClient } = await import('@mysten/deepbook-v3')
const gas = new GasStationClient(process.env.SHINAMI_GAS_STATION_ACCESS_KEY!)
const client = getSuiClient()

for (const budget of [10_000_000, 20_000_000]) {
  try {
    const gasless = await buildGaslessTransaction(
      (tx: Transaction) => {
        tx.setSender(SENDER)
        const db = new DeepBookClient({ address: SENDER, network: 'testnet', client: client as never })
        const [b, q, d] = tx.add(db.deepBook.swapExactBaseForQuote({ poolKey: POOL, amount: AMT, deepAmount: 0, minOut: MINOUT }))
        tx.transferObjects([b, q, d], SENDER)
      },
      { sender: SENDER, gasBudget: budget, sui: client }
    )
    const sp = await gas.sponsorTransaction(gasless)
    const bytes = Uint8Array.from(Buffer.from(sp.txBytes, 'base64'))
    const cmds = (Transaction.from(bytes).getData().commands as any[]).map((c) => c.$kind)
    const sim = await simulate(bytes, SENDER)
    if (sim.kind === 'ok') {
      const g = sim.evidence.gasUsed
      const net = BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate)
      console.log(`budget ${budget}: OK net=${net} ${JSON.stringify(g)}  cmds=${cmds.join(',')}`)
    } else {
      console.log(`budget ${budget}: ${sim.kind} ${sim.error}  cmds=${cmds.join(',')}`)
    }
  } catch (e) {
    console.log(`budget ${budget}: THREW ${(e as Error).message.slice(0, 200)}`)
  }
}
