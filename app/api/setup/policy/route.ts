import { getDb } from '@/lib/db'
import { requireHuman, authErrorResponse } from '@/lib/auth'
import { PolicySchema } from '@/lib/policy/policy'
import { SUI_TYPE, DEEPBOOK_PACKAGE } from '@/lib/sui'
import { MODES, isModeName, policyFromMode, DEFAULT_MODE } from '@/lib/policy/modes'
import { suiUsdPrice } from '@/lib/tx'

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
    mode?: string
    notifyUrl?: string | null
    perTxUsd?: number
    weeklyUsd?: number
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

  // A named mode fills in every number, and explicit figures still win over it — so "reef, but
  // 5 SUI per transaction" is expressible. Picking a word is the path we expect people to take;
  // typing four figures they have no basis for choosing is the path that produced a 0.0025 SUI
  // limit on a book whose smallest fillable trade is 1.1 SUI.
  if (body.mode !== undefined && !isModeName(body.mode)) {
    return Response.json(
      { error: `Unknown mode "${body.mode}". Choose ${Object.keys(MODES).join(' or ')}.` },
      { status: 400 }
    )
  }
  const mode = isModeName(body.mode) ? body.mode : DEFAULT_MODE
  const preset = policyFromMode(mode, { allowedRecipients: body.allowedRecipients })

  // Dollars are how people actually think about a spending limit; SUI is how the chain thinks.
  // Convert once, here, and record the rate — so the stored limit stays a fixed number the gate can
  // apply in microseconds, and the figure can still be explained six weeks later.
  let usd: { perTxUsd: number; weeklyUsd: number; suiUsdAtSet: number; pinnedAt: number } | undefined
  let perTxFromUsd: string | undefined
  let weeklyFromUsd: string | undefined
  if (body.perTxUsd !== undefined || body.weeklyUsd !== undefined) {
    const price = await suiUsdPrice()
    if (!price) {
      return Response.json(
        { error: 'Could not read a SUI price just now, so a dollar limit cannot be pinned. Set the limit in SUI, or try again shortly.' },
        { status: 503 }
      )
    }
    const perTxUsd = body.perTxUsd ?? body.weeklyUsd!
    const weeklyUsd = body.weeklyUsd ?? perTxUsd * 4
    if (perTxUsd <= 0 || weeklyUsd <= 0) {
      return Response.json({ error: 'Dollar limits must be positive.' }, { status: 400 })
    }
    const toMistUsd = (d: number) => BigInt(Math.round((d / price) * 1e9)).toString()
    perTxFromUsd = toMistUsd(perTxUsd)
    weeklyFromUsd = toMistUsd(weeklyUsd)
    usd = { perTxUsd, weeklyUsd, suiUsdAtSet: price, pinnedAt: Date.now() }
  }

  let policy
  try {
    policy = PolicySchema.parse({
      version: w.policy_version + 1,
      walletAddress: w.h_address,
      mode,
      caps: [
        {
          coinType: SUI_TYPE,
          symbol: 'SUI',
          decimals: 9,
          perTxLimit: body.perTxSui !== undefined ? toMist(body.perTxSui) : perTxFromUsd ?? preset.caps[0].perTxLimit,
          weeklyLimit: body.weeklySui !== undefined ? toMist(body.weeklySui) : weeklyFromUsd ?? preset.caps[0].weeklyLimit,
          usd,
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

  // Where to tell the owner something is waiting. Only settable here, which means only from a
  // browser session — an agent that could redirect its own alerts would be choosing who watches it.
  if (body.notifyUrl !== undefined) {
    const u = body.notifyUrl?.trim() || null
    if (u && !/^https?:\/\//i.test(u)) {
      return Response.json({ error: 'notifyUrl must be an http(s) URL.' }, { status: 400 })
    }
    db.prepare('UPDATE wallets SET notify_url=? WHERE account_id=?').run(u, accountId)
  }

  db.prepare('UPDATE wallets SET policy_json=?, policy_version=? WHERE account_id=?').run(
    JSON.stringify(policy),
    policy.version,
    accountId
  )
  // Any decision scored under the old limits is void.
  db.prepare("UPDATE decisions SET state='expired' WHERE account_id=? AND state='pending'").run(accountId)

  return Response.json({ ok: true, policy_version: policy.version, mode, mode_summary: MODES[mode].summary, usd, policy })
}
