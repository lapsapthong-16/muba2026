import { getDb } from '@/lib/db'
import { requireHuman, authErrorResponse } from '@/lib/auth'
import { getBalance, SUI_DECIMALS, NETWORK } from '@/lib/sui'

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

  return Response.json({
    network: NETWORK,
    pending_ids: pending.map((p) => p.id),
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
