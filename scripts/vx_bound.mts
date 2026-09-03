import { getDb } from '../lib/db'
import { getSuiClient, SUI_TYPE } from '../lib/sui'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
const c = getSuiClient()
const rows: any = getDb().prepare("SELECT account_id,h_address,m_address FROM wallets WHERE h_address!=''").all()
const addrs = new Set<string>()
for (const r of rows) { if (r.h_address) addrs.add(r.h_address); if (r.m_address) addrs.add(r.m_address) }
if (process.env.PRIVATE_KEY) addrs.add(Ed25519Keypair.fromSecretKey(process.env.PRIVATE_KEY.trim()).toSuiAddress())
for (const a of addrs) {
  const b: any = await c.core.getBalance({ owner: a, coinType: SUI_TYPE })
  const n = Number(b.balance.balance)
  if (n > 0) console.log(a, 'total=', (n/1e9).toFixed(4), 'coinBal=', (Number(b.balance.coinBalance)/1e9).toFixed(4), 'addrBal=', (Number(b.balance.addressBalance)/1e9).toFixed(4))
}
