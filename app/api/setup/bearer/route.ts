import { getDb } from '@/lib/db'
import { requireHuman, authErrorResponse, newToken, sha256hex } from '@/lib/auth'

export const runtime = 'nodejs'

/**
 * Re-issue the agent's bearer.
 *
 * Bearers are stored as a sha256 hash and shown exactly once, at onboarding. That is the right
 * default — but it means a lost bearer stranded an account that had a funded wallet and an enrolled
 * Ledger behind it, with no way back: /api/setup/ledger refuses a second enrolment, and onboarding
 * again mints a NEW platform key, hence a different committee, hence different H and M addresses
 * and orphaned funds. Losing a credential should not cost you the wallet.
 *
 * Human session only, like everything else under /setup. An agent that could mint its own bearer
 * would just be minting itself a second one, but the header check keeps the rule uniform.
 *
 * This ROTATES: the previous bearer stops working the moment this returns. That is the point —
 * re-issue is also how you revoke a leaked one.
 */
export async function POST(req: Request) {
  let accountId: string
  try {
    accountId = requireHuman(req).accountId
  } catch (e) {
    return authErrorResponse(e)
  }

  const db = getDb()
  const w = db.prepare('SELECT h_address, m_address FROM wallets WHERE account_id=?').get(accountId) as
    | { h_address: string; m_address: string | null }
    | undefined
  if (!w?.h_address) {
    return Response.json(
      { error: 'No wallet yet. Connect your Ledger first — there is nothing for an agent to spend.' },
      { status: 409 }
    )
  }

  const bearer = newToken('hw_live')
  db.prepare('UPDATE accounts SET token_hash=? WHERE id=?').run(sha256hex(bearer), accountId)

  const proto = req.headers.get('x-forwarded-proto') ?? 'http'
  const host = req.headers.get('host') ?? 'localhost:3000'
  const url = (process.env.PUBLIC_BASE_URL ?? `${proto}://${host}`).replace(/\/$/, '')

  return Response.json({
    bearer,
    spending_address: w.h_address,
    protected_address: w.m_address,
    rotated: 'The previous bearer no longer works.',
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
