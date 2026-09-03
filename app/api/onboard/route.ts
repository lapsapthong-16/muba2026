import { randomUUID } from 'node:crypto'
import { getDb } from '@/lib/db'
import { newToken, sha256hex } from '@/lib/auth'
import { newPlatformKeypair, sealSecretKey } from '@/lib/keys'

export const runtime = 'nodejs'

/**
 * The agent's first contact. One curl, and it gets everything it needs plus a link for the human.
 *
 *   curl -sX POST https://HOST/api/onboard -d '{"agent":"hermes","pass":"..."}'
 *
 * No wallet addresses exist yet — the platform key is generated here, but H and M are multisig
 * committees that need the LEDGER's public key, which only arrives in Module 1. Until then the
 * account is a shell and every spending tool returns needs_setup.
 */

function baseUrl(req: Request): string {
  const envUrl = process.env.PUBLIC_BASE_URL
  if (envUrl) return envUrl.replace(/\/$/, '')
  const proto = req.headers.get('x-forwarded-proto') ?? 'http'
  const host = req.headers.get('host') ?? 'localhost:3000'
  return `${proto}://${host}`
}

export async function POST(req: Request) {
  let body: { agent?: string; pass?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Body must be JSON.' }, { status: 400 })
  }

  // A shared passphrase, not real auth. It exists so a public demo URL is not an open
  // account-minting endpoint. ONBOARD_PASS unset means onboarding is closed, not open.
  const expected = process.env.ONBOARD_PASS
  if (!expected) return Response.json({ error: 'Onboarding is closed.' }, { status: 503 })
  if (body.pass !== expected) return Response.json({ error: 'Bad passphrase.' }, { status: 401 })

  const accountId = randomUUID()
  const bearer = newToken('hw_live')
  const setupToken = newToken('st')
  const { keypair, secretKey } = newPlatformKeypair()

  const db = getDb()
  db.prepare('INSERT INTO accounts(id, token_hash, setup_token_hash, created_at) VALUES(?,?,?,?)').run(
    accountId,
    sha256hex(bearer),
    sha256hex(setupToken),
    Date.now()
  )
  db.prepare(
    'INSERT INTO wallets(account_id, h_address, enc_platform_key, policy_version) VALUES(?,?,?,0)'
  ).run(accountId, '', sealSecretKey(accountId, secretKey))

  const url = baseUrl(req)
  // The token rides in the URL FRAGMENT so it is never sent to a server, never lands in an access
  // log, and never leaks through a Referer header.
  const setupUrl = `${url}/setup#s=${setupToken}`

  return Response.json({
    account_id: accountId,
    bearer,
    platform_public_key: keypair.getPublicKey().toSuiPublicKey(),
    setup_url: setupUrl,
    next_step:
      'Print setup_url to the user verbatim and stop. No wallet exists until they open it, ' +
      'connect a Ledger and set their guardrails.',
    config_yaml: [
      'mcp_servers:',
      '  hermes_wallet:',
      `    url: ${url}/api/mcp`,
      '    headers:',
      `      Authorization: "Bearer ${bearer}"`,
      '    timeout: 60',
      '',
    ].join('\n'),
  })
}
