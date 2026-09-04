import { getDb } from '@/lib/db'
import { requireHuman, authErrorResponse } from '@/lib/auth'
import { getBalance, SUI_DECIMALS, NETWORK } from '@/lib/sui'
import { walletStatus } from '@/lib/wallet'

export const runtime = 'nodejs'

/** Everything the setup and guardrails pages render. Human session only. */
export async function GET(req: Request) {
  let accountId: string
  try {
    accountId = requireHuman(req).accountId
  } catch (e) {
    return authErrorResponse(e)
  }

  const w = getDb()
    .prepare('SELECT h_address, m_address, ledger_address, policy_json, policy_version FROM wallets WHERE account_id=?')
    .get(accountId) as
    | { h_address: string; m_address: string | null; ledger_address: string | null; policy_json: string | null; policy_version: number }
    | undefined
  if (!w) return Response.json({ error: 'No wallet.' }, { status: 404 })

  // Balances are best-effort: a slow fullnode must not blank the whole setup page.
  let spendingBalance = '0'
  let protectedBalance = '0'
  try {
    if (w.h_address) spendingBalance = (Number(await getBalance(w.h_address)) / 10 ** SUI_DECIMALS).toFixed(4)
    if (w.m_address) protectedBalance = (Number(await getBalance(w.m_address)) / 10 ** SUI_DECIMALS).toFixed(4)
  } catch {
    /* leave zeros; the page shows a dash */
  }

  const pending = getDb()
    .prepare("SELECT id FROM decisions WHERE account_id=? AND state='pending' AND expires_at > ? ORDER BY created_at DESC")
    .all(accountId, Date.now()) as { id: string }[]

  // Count recently-expired ones separately. Showing nothing at all when approvals HAVE been
  // created reads as "the device is broken" rather than "you missed the window", which is the
  // wrong thing to debug.
  const expired = getDb()
    .prepare("SELECT COUNT(*) AS n FROM decisions WHERE account_id=? AND state='pending' AND expires_at <= ?")
    .get(accountId, Date.now()) as { n: number }

  // The dashboard shows the SAME preflight the agent gets, deliberately: two places describing
  // readiness differently is how a human ends up debugging a problem the agent already reported.
  let preflight: unknown = []
  try {
    const st = (await walletStatus(accountId)) as { preflight?: unknown }
    preflight = st.preflight ?? []
  } catch { /* a wallet mid-setup has no preflight yet */ }

  const recent = getDb()
    .prepare(
      `SELECT id, state, intent, verdict_json, digest, created_at
         FROM decisions WHERE account_id=? ORDER BY created_at DESC LIMIT 12`
    )
    .all(accountId) as { id: string; state: string; intent: string; verdict_json: string; digest: string | null; created_at: number }[]

  return Response.json({
    network: NETWORK,
    preflight,
    recent: recent.map((d) => {
      let rule: string | null = null
      try { rule = (JSON.parse(d.verdict_json) as { rule?: string }).rule ?? null } catch { /* unreadable verdict still lists */ }
      return { id: d.id, state: d.state, intent: d.intent, rule, digest: d.digest, created_at: d.created_at }
    }),
    pending_ids: pending.map((p) => p.id),
    expired_count: expired.n,
    spending_address: w.h_address || null,
    protected_address: w.m_address,
    ledger_address: w.ledger_address,
    spending_balance_sui: spendingBalance,
    protected_balance_sui: protectedBalance,
    policy: w.policy_json ? JSON.parse(w.policy_json) : null,
    policy_version: w.policy_version,
    ready: !!(w.h_address && w.ledger_address && w.policy_json),
  })
}
