import { getDb } from '@/lib/db'
import { sha256hex } from '@/lib/auth'

export const runtime = 'nodejs'

/**
 * Redeem the setup token for a session cookie.
 *
 * The token arrives in the URL FRAGMENT (…/setup#s=st_…), so it is never sent to a server, never
 * lands in an access log, and never leaks through a Referer header. The page reads it from
 * location.hash, POSTs it here once, and history.replaceState's it away.
 *
 * The cookie is httpOnly + SameSite=Strict: the page itself cannot read it back, so an XSS on this
 * page cannot exfiltrate the session, and no cross-site form can drive it.
 */
export async function POST(req: Request) {
  const { token } = (await req.json().catch(() => ({}))) as { token?: string }
  if (!token) return Response.json({ error: 'Missing token.' }, { status: 400 })

  const row = getDb()
    .prepare('SELECT id FROM accounts WHERE setup_token_hash = ?')
    .get(sha256hex(token)) as { id: string } | undefined
  if (!row) return Response.json({ error: 'This setup link is not valid.' }, { status: 401 })

  return Response.json(
    { ok: true },
    {
      headers: {
        'Set-Cookie': [
          `hw_session=${encodeURIComponent(token)}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Strict',
          'Max-Age=86400',
          process.env.PUBLIC_BASE_URL?.startsWith('https') ? 'Secure' : '',
        ]
          .filter(Boolean)
          .join('; '),
      },
    }
  )
}
