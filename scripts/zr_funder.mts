import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { getBalance, NETWORK } from '../lib/sui'

const sk = process.env.PRIVATE_KEY
if (!sk) {
  console.log('PRIVATE_KEY not set')
  process.exit(0)
}
const kp = Ed25519Keypair.fromSecretKey(sk.trim())
const from = kp.toSuiAddress()
console.log('network      :', NETWORK)
console.log('funder addr  :', from)
const b = await getBalance(from)
console.log('funder bal   :', b.toString(), 'MIST =', Number(b) / 1e9, 'SUI')
