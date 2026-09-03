import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'

/**
 * The platform's half of both committees, sealed at rest.
 *
 * Honest scope: this protects the key from someone who reads the sqlite file WITHOUT the master
 * key — a leaked backup, a snapshot, a stray copy. It does not protect against someone who owns
 * the process, because the process must be able to sign unattended. That is precisely why the
 * bulk of the money lives at M, behind a 2-of-2 this server cannot satisfy alone.
 *
 * WALLET_MASTER_KEY: 32 bytes, base64. Generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

const ALGO = 'aes-256-gcm'

function masterKey(): Buffer {
  const raw = process.env.WALLET_MASTER_KEY
  if (!raw) throw new Error('WALLET_MASTER_KEY is not set. 32 random bytes, base64.')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error(`WALLET_MASTER_KEY must decode to 32 bytes, got ${key.length}.`)
  return key
}

/** Per-account subkey, so one leaked ciphertext is not a break of every other account. */
function accountKey(accountId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey(), Buffer.alloc(0), Buffer.from(`wallet:${accountId}`), 32))
}

export function sealSecretKey(accountId: string, suiSecretKey: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv(ALGO, accountKey(accountId), iv)
  const ct = Buffer.concat([c.update(suiSecretKey, 'utf8'), c.final()])
  // iv ‖ tag ‖ ciphertext, base64. Version prefix so the format can change later.
  return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`
}

export function openSecretKey(accountId: string, sealed: string): string {
  const [v, b64] = sealed.split('.', 2)
  if (v !== 'v1' || !b64) throw new Error('Unrecognised keystore envelope')
  const buf = Buffer.from(b64, 'base64')
  const d = createDecipheriv(ALGO, accountKey(accountId), buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
}

/** Generate the platform keypair for a new account. The caller seals and stores it. */
export function newPlatformKeypair(): { keypair: Ed25519Keypair; secretKey: string } {
  const keypair = Ed25519Keypair.generate()
  return { keypair, secretKey: keypair.getSecretKey() }
}

export function keypairFromSealed(accountId: string, sealed: string): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(openSecretKey(accountId, sealed))
}
