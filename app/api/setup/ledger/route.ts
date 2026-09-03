import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { publicKeyFromSuiBytes } from '@mysten/sui/verify'
import { getDb } from '@/lib/db'
import { requireHuman, authErrorResponse } from '@/lib/auth'
import { keypairFromSealed, sealSecretKey } from '@/lib/keys'
import { makeCommittees } from '@/lib/multisig'
import { LEDGER_PATH } from '@/lib/ledger'

export const runtime = 'nodejs'

/**
 * Enrol the Ledger and derive both committees.
 *
 * requireHuman, never requireAgent: this endpoint creates the address the agent's own spending is
 * bounded by, so an agent replaying its bearer here would be choosing its own guardian. The auth
 * helper throws on the mere presence of an Authorization header.
 */
export async function POST(req: Request) {
  let accountId: string
  try {
    accountId = requireHuman(req).accountId
  } catch (e) {
    return authErrorResponse(e)
  }

  const body = (await req.json().catch(() => null)) as
    | { suiPublicKey?: string; deviceAddress?: string; derivationPath?: string }
    | null
  if (!body?.suiPublicKey || !body.deviceAddress) {
    return Response.json({ error: 'suiPublicKey and deviceAddress are required.' }, { status: 400 })
  }
  if (body.derivationPath !== LEDGER_PATH) {
    // A 3-level path derives a DIFFERENT key than a 5-level one. Accepting whatever the client
    // sends would let a later reconnect at another path produce a different M.
    return Response.json(
      { error: `Unexpected derivation path. This wallet pins ${LEDGER_PATH}.` },
      { status: 400 }
    )
  }

  let ledgerPk
  try {
    ledgerPk = publicKeyFromSuiBytes(body.suiPublicKey)
  } catch {
    return Response.json({ error: 'Could not decode the device public key.' }, { status: 400 })
  }
  // The device told us an address; check it against the key it also gave us, so a malformed
  // encoding fails here rather than silently producing a committee nobody can sign for.
  if (ledgerPk.toSuiAddress() !== body.deviceAddress.toLowerCase()) {
    return Response.json(
      { error: 'The device public key does not match the address it reported.' },
      { status: 400 }
    )
  }

  const db = getDb()
  const w = db
    .prepare('SELECT enc_platform_key, m_address FROM wallets WHERE account_id = ?')
    .get(accountId) as { enc_platform_key: string; m_address: string | null } | undefined
  if (!w) return Response.json({ error: 'No wallet for this account.' }, { status: 404 })
  if (w.m_address) {
    return Response.json({ error: 'A Ledger is already enrolled for this wallet.' }, { status: 409 })
  }

  const platform = keypairFromSealed(accountId, w.enc_platform_key).getPublicKey()

  // The break-glass key, weight 2, so it alone satisfies M. Without it a dead or lost Ledger
  // strands the protected balance permanently — a larger expected loss than the attack we are
  // preventing. It is shown to the human ONCE here and never stored in a recoverable form.
  const recovery = Ed25519Keypair.generate()

  const { committees, H, M } = makeCommittees(platform, ledgerPk, recovery.getPublicKey(), LEDGER_PATH)

  db.prepare(
    `UPDATE wallets SET h_address=?, m_address=?, ledger_address=?, committees_json=?
      WHERE account_id=?`
  ).run(H, M, body.deviceAddress.toLowerCase(), JSON.stringify(committees), accountId)

  return Response.json({
    spending_address: H,
    protected_address: M,
    ledger_address: body.deviceAddress.toLowerCase(),
    recovery_phrase_once: recovery.getSecretKey(),
    recovery_note:
      'Write this down now and store it offline. It is the only way to move funds out of the ' +
      'protected address if your Ledger is lost, and it is not stored anywhere you can retrieve it.',
    // Sealed only so a page refresh does not strand a user mid-setup; a real deployment would
    // require the human to confirm they saved it and then drop this column.
    _sealed_recovery: sealSecretKey(accountId, recovery.getSecretKey()),
  })
}
