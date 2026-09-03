import { getDb } from '@/lib/db'
import { sha256hex } from '@/lib/auth'

export const runtime = 'nodejs'

/**
 * Decline a held payment from anywhere, with one tap and no session.
 *
 * THIS IS THE ONE UNAUTHENTICATED MUTATING ROUTE IN THE SERVICE, and it is deliberate. Every other
 * route that changes anything demands either the agent's bearer or the owner's browser session.
 * This one demands only a token from a notification, because of what it can do:
 *
 *   the only reachable state transition is pending -> denied.
 *
 * There is no parameter for an amount, an address, or a decision id — the token IS the decision.
 * The worst outcome an attacker who steals a notification can produce is refusing a payment that
 * was already flagged as suspicious enough to stop. Someone who can read the owner's Slack can
 * annoy them; they cannot move a coin. Approving stays behind the Ledger, where the asymmetry
 * belongs.
 *
 * The token is single-use (cleared on the transition), stored only as a sha256, and dies with its
 * decision.
 *
 * GET as well as POST: a notification is a link, and a link is a GET. That normally invites
 * prefetchers to fire it — accepted here precisely because the action is the SAFE one. A prefetched
 * decline costs a refused payment the human can ask the agent to retry; a prefetched approve would
 * be unforgivable, which is why no such link exists.
 */

interface Row {
  id: string
  state: string
  intent: string
  decline_token_hash: string | null
}

function decline(token: string): { status: number; body: Record<string, unknown> } {
  const db = getDb()
  const row = db
    .prepare('SELECT id, state, intent, decline_token_hash FROM decisions WHERE decline_token_hash = ?')
    .get(sha256hex(token)) as Row | undefined

  if (!row) {
    return { status: 404, body: { error: 'This link is not valid. It may already have been used.' } }
  }
  if (row.state !== 'pending') {
    return {
      status: 409,
      body: {
        state: row.state,
        note: `Nothing to do — this was already ${row.state}.`,
        funds_moved: row.state === 'executed',
      },
    }
  }

  db.prepare("UPDATE decisions SET state='denied', decline_token_hash=NULL WHERE id=?").run(row.id)
  return {
    status: 200,
    body: {
      state: 'denied',
      intent: row.intent,
      funds_moved: false,
      note: 'Declined. Nothing was sent, and this link is now spent.',
    },
  }
}

function html(body: Record<string, unknown>, status: number): Response {
  const ok = body.state === 'denied'
  const title = ok ? 'Declined' : (body.error as string) ?? `Already ${body.state}`
  const sub = ok
    ? 'Nothing was sent. Your agent has been told.'
    : (body.note as string) ?? 'This link can no longer be used.'
  // Self-contained: a phone opening a Slack link should not depend on our CSS loading.
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<div style="font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:34rem;margin:18vh auto;padding:0 1.5rem;color:#14181e">
  <div style="font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:#7c918b">Puffer</div>
  <h1 style="font-size:1.9rem;margin:.4rem 0 .5rem;color:${ok ? '#0a6154' : '#a75c13'}">${title}</h1>
  <p style="margin:0;color:#4c605b">${sub}</p>
  ${body.intent ? `<p style="margin:1.2rem 0 0;font:13px ui-monospace,Menlo,monospace;color:#7c918b">${String(body.intent).replace(/[<>&]/g, '')}</p>` : ''}
</div>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  )
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const { status, body } = decline(token)
  return html(body, status)
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const { status, body } = decline(token)
  return Response.json(body, { status })
}
