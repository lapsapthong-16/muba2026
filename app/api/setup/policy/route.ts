import { getDb } from '@/lib/db'
import { requireHuman, authErrorResponse } from '@/lib/auth'
import { PolicySchema } from '@/lib/policy/policy'
import { SUI_TYPE, DEEPBOOK_PACKAGE } from '@/lib/sui'

export const runtime = 'nodejs'

/**
 * Module 2 — the guardrails. Human session only, and there is deliberately NO MCP tool that
 * reaches this: if the agent could write policy, the spending cap would be decorative.
 *
 * Saving bumps policy_version, which invalidates every pending decision. An approval the human is
 * mid-way through reading was scored against the OLD limits, so it must not survive a change to
 * them.
 */
export async function POST(req: Request) {
  let accountId: string
  try {
    accountId = requireHuman(req).accountId
  } catch (e) {
    return authErrorResponse(e)
  }

  const body = (await req.json().catch(() => null)) as {
    perTxSui?: number
    weeklySui?: number
    allowedRecipients?: { address: string; label: string }[]
    allowedPackages?: { packageId: string; label: string }[]
  } | null
  if (!body) return Response.json({ error: 'Body must be JSON.' }, { status: 400 })

  const db = getDb()
  const w = db
    .prepare('SELECT h_address, m_address, policy_version FROM wallets WHERE account_id=?')
    .get(accountId) as { h_address: string; m_address: string | null; policy_version: number } | undefined
  if (!w?.h_address || !w.m_address) {
    return Response.json({ error: 'Connect your Ledger first — the wallet does not exist yet.' }, { status: 409 })
  }

  // Amounts are decimal strings in base units all the way down. Never a JS number:
  // Number("100000000000000001") silently loses a unit.
  const toMist = (sui: number) => BigInt(Math.round(sui * 1e9)).toString()

  let policy
  try {
    policy = PolicySchema.parse({
      version: w.policy_version + 1,
      walletAddress: w.h_address,
      caps: [
        {
          coinType: SUI_TYPE,
          symbol: 'SUI',
          decimals: 9,
          perTxLimit: toMist(body.perTxSui ?? 1),
          weeklyLimit: toMist(body.weeklySui ?? 10),
        },
      ],
      allowedRecipients: body.allowedRecipients ?? [],
      // 0x2 is unavoidable — splitCoins and transferObjects are framework calls, so a policy
      // without it cannot approve any payment at all.
      allowedPackages:
        body.allowedPackages?.length
          ? body.allowedPackages
          : [
              { packageId: '0x2', label: 'Sui Framework' },
              { packageId: DEEPBOOK_PACKAGE, label: 'DeepBook' },
            ],
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Invalid policy'
    return Response.json({ error: msg.slice(0, 400) }, { status: 400 })
  }

  db.prepare('UPDATE wallets SET policy_json=?, policy_version=? WHERE account_id=?').run(
    JSON.stringify(policy),
    policy.version,
    accountId
  )
  // Any decision scored under the old limits is void.
  db.prepare("UPDATE decisions SET state='expired' WHERE account_id=? AND state='pending'").run(accountId)

  return Response.json({ ok: true, policy_version: policy.version, policy })
}
