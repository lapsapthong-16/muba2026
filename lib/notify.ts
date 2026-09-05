import { getDb } from './db'
import { newToken, sha256hex } from './auth'

/**
 * Telling the human something is waiting, wherever they are.
 *
 * Until now an escalation was silent: the agent knew, the database knew, and the person whose
 * money it was found out only if they happened to have /test open. MetaMask pushes the request to
 * you by email or mobile app, and that is not a nicety — an approval nobody sees expires, and an
 * expiry is indistinguishable from a refusal to the agent waiting on it.
 *
 * WHY A WEBHOOK RATHER THAN EMAIL. A URL the owner supplies works with Slack, Discord, ntfy, or
 * six lines of their own code, and it needs no credentials from us, no sending domain, and no
 * deliverability story. The wallet holds one field; the human owns the channel.
 *
 * THE ASYMMETRY IS THE DESIGN. Approving requires the Ledger, which requires WebHID, which
 * requires a desktop browser — so the notification cannot carry an approve button and should not
 * pretend to. It carries a DECLINE link instead, because declining is the safe action: the worst a
 * leaked decline token can do is refuse a payment that was already being questioned. The dangerous
 * half stays behind the hardware; the safe half goes anywhere.
 *
 * Single-use, hashed at rest, and scoped to one decision — the same shape as every other token
 * here.
 */

export interface Notification {
  decisionId: string
  intent: string
  rule: string | null
  reasons: string[]
  riskConsensus: string | null
  from: string
  expiresInSeconds: number
}

/** Mint a single-use decline token and store only its hash. */
export function mintDeclineToken(decisionId: string): string {
  const token = newToken('dec')
  getDb().prepare('UPDATE decisions SET decline_token_hash=? WHERE id=?').run(sha256hex(token), decisionId)
  return token
}

function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

/**
 * Fire and forget. A notification channel MUST NOT be able to fail a transaction: the escalation
 * has already been recorded, and a human who never hears about it is a worse outcome than a slow
 * response, but a crashed submit is worse than both. Every failure is swallowed and logged.
 *
 * Not awaited by the caller. Deliberately: a webhook pointing at something slow would otherwise
 * add its latency to every escalated payment the agent is waiting on.
 */
export function notify(accountId: string, n: Notification): void {
  let url: string | null = null
  try {
    const row = getDb().prepare('SELECT notify_url FROM wallets WHERE account_id=?').get(accountId) as
      | { notify_url: string | null }
      | undefined
    url = row?.notify_url ?? null
  } catch {
    return
  }
  if (!url) return

  let declineToken: string
  try {
    declineToken = mintDeclineToken(n.decisionId)
  } catch {
    return
  }

  const body = {
    // Slack and Discord both render a top-level `text`, so the same payload is readable in either
    // without the owner configuring anything.
    text:
      `Your wallet is holding a payment.\n` +
      `${n.intent}\n` +
      `Reason: ${n.rule ?? 'flagged'}${n.riskConsensus ? ` (${n.riskConsensus})` : ''}\n` +
      `Approve on your Ledger: ${baseUrl()}/test\n` +
      `Or decline from here: ${baseUrl()}/api/decline/${declineToken}\n` +
      `Expires in ${Math.round(n.expiresInSeconds / 60)} minutes.`,
    wallet: 'puffer',
    decision_id: n.decisionId,
    intent: n.intent,
    rule: n.rule,
    reasons: n.reasons,
    risk_consensus: n.riskConsensus,
    from: n.from,
    expires_in_seconds: n.expiresInSeconds,
    approve_url: `${baseUrl()}/test`,
    decline_url: `${baseUrl()}/api/decline/${declineToken}`,
    note: 'Approving needs your Ledger, so it must happen in a desktop browser. Declining does not.',
  }

  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => {
    console.warn('[notify] delivery failed:', (e as Error).message?.slice(0, 120))
  })
}
