import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { LEDGER_PATH } from '../lib/ledger'
import { writeFileSync } from 'node:fs'

const kp = Ed25519Keypair.generate()
const body = {
  suiPublicKey: kp.getPublicKey().toSuiPublicKey(),
  deviceAddress: kp.getPublicKey().toSuiAddress(),
  derivationPath: LEDGER_PATH,
}
writeFileSync('/private/tmp/claude-501/-Users-derek-Developer-muba2026/a1b98a94-c3a3-4231-b528-22151703dee2/scratchpad/enrol.json', JSON.stringify(body))
console.log('LEDGER_PATH =', LEDGER_PATH)
console.log(JSON.stringify(body, null, 2))
