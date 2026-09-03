import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { getDb } from './db'

/**
 * TWO functions, deliberately not sharing a helper.
 *
 * The agent authenticates with a bearer token. The human authenticates with a session cookie.
 * If one function served both, an agent holding its own bearer could raise its own spending
 * limits and resolve its own alerts — which inverts the entire product. So `requireHuman` throws
 * on the mere PRESENCE of an Authorization header, rather than just ignoring it.
 *
 * Test: replay the agent bearer against every non-MCP route and expect 401.
 */

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  // Both are sha256 digests, so lengths are unconditionally equal — timingSafeEqual won't throw.
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** AGENT ONLY. Reads the Authorization header and nothing else. Imported by /api/mcp alone. */
export function requireAgent(req: Request): { accountId: string } {
  const header = req.headers.get('authorization')
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token) throw new AuthError(401, 'Missing bearer token')
  const hash = sha256hex(token)
  const row = getDb()
    .prepare('SELECT id, token_hash FROM accounts WHERE token_hash = ?')
    .get(hash) as { id: string; token_hash: string } | undefined
  if (!row || !safeEqualHex(row.token_hash, hash)) throw new AuthError(401, 'Unknown bearer token')
  return { accountId: row.id }
}

/**
 * HUMAN ONLY. Reads the session cookie and nothing else, and REFUSES if an Authorization header
 * is present at all — an agent replaying its bearer must never reach a policy or approval route.
 */
export function requireHuman(req: Request): { accountId: string } {
  if (req.headers.get('authorization')) {
    throw new AuthError(403, 'This endpoint is for the wallet owner in a browser, not for the agent.')
  }
  const cookie = req.headers.get('cookie') ?? ''
  const sid = cookie.match(/(?:^|;\s*)hw_session=([^;]+)/)?.[1]
  if (!sid) throw new AuthError(401, 'No session. Open your setup link.')
  const row = getDb()
    .prepare('SELECT id FROM accounts WHERE setup_token_hash = ?')
    .get(sha256hex(decodeURIComponent(sid))) as { id: string } | undefined
  if (!row) throw new AuthError(401, 'Session expired. Open your setup link again.')
  return { accountId: row.id }
}

export function authErrorResponse(e: unknown): Response {
  if (e instanceof AuthError) {
    return Response.json({ error: e.message }, { status: e.status })
  }
  throw e
}
