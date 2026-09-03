import { getSuiClient, SUI_TYPE } from '../lib/sui'

const cands = [
  '0x8e1e504fbf0c54d43e948951f50f3710fff83bb91ee2c911509118ed1331f5ef', // shinami sponsor seen in gasData
]
for (const a of cands) {
  const bal: any = await getSuiClient().core.getBalance({ owner: a, coinType: SUI_TYPE })
  const objs: any = await getSuiClient().core.listOwnedObjects({ owner: a, type: `0x2::coin::Coin<${SUI_TYPE}>` })
  console.log(a, 'total', bal.balance.balance, 'coinBal', bal.balance.coinBalance, 'objs', (objs.objects ?? []).length)
}
