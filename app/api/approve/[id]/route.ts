import { getDb } from '@/lib/db'
import { requireHuman, authErrorResponse } from '@/lib/auth'
import { executeFromProtected, recordSpend } from '@/lib/execute'
import { sha256 } from '@/lib/tx'
import { simulate } from '@/lib/evidence'
import { describe } from '@/lib/describe'

export const runtime = 'nodejs'

/**
 * The human approval endpoint. Human session only — there is deliberately NO MCP tool that
 * approves an approval, because an agent resolving its own alert is the whole product inverted.
 *
 * GET  returns the pending decision plus the bytes the Ledger must sign.
 * POST accepts the device's partial signature, re-verifies everything, and broadcasts.
 *
 * Note ctx.params is a Promise in this Next version — await it.
 */

interface Row {
  id: string
  state: string
  intent: string
  sender: string
  tx_bytes_b64: string
  bytes_sha256: string
  evidence_json: string
  verdict_json: string
  policy_version: number
  expires_at: number
}

function load(accountId: string, id: string): Row | undefined {
  return getDb()
    .prepare('SELECT * FROM decisions WHERE id=? AND account_id=?')
    .get(id, accountId) as Row | undefined
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let accountId: string
  try {
    accountId = requireHuman(req).accountId
  } catch (e) {
    return authErrorResponse(e)
  }
  const { id } = await ctx.params
  const row = load(accountId, id)
  if (!row) return Response.json({ error: 'No such decision.' }, { status: 404 })

  const decision = JSON.parse(row.verdict_json)
  const stored = JSON.parse(row.evidence_json) as { sim?: { evidence?: unknown } }
  const evidence = (stored?.sim as { evidence?: unknown })?.evidence
  let description = null
  try {
    if (evidence) {
      description = describe(
        Uint8Array.from(Buffer.from(row.tx_bytes_b64, 'base64')),
        evidence as never,
        row.sender,
        decision.rule,
        decision.reasons ?? []
      )
    }
  } catch {
    /* a missing description must never block an approval */
  }

  return Response.json({
    description,
    id: row.id,
    state: row.state,
    intent: row.intent,
    from: row.sender,
    expired: Date.now() > row.expires_at,
    expires_in_seconds: Math.max(0, Math.round((row.expires_at - Date.now()) / 1000)),
    rule: decision.rule,
    reasons: decision.reasons,
    risk: decision.ballotRisk,
    risk_reasons: decision.ballotReasons ?? [],
    risk_latency_ms: decision.ballotLatencyMs ?? null,
    gonka_request_id: decision.gonkaRequestId,
    evidence: JSON.parse(row.evidence_json),
    /** The exact bytes to hand the device. Nothing rebuilds them. */
    tx_bytes_b64: row.tx_bytes_b64,
  })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let accountId: string
  try {
    accountId = requireHuman(req).accountId
  } catch (e) {
    return authErrorResponse(e)
  }
  const { id } = await ctx.params
  const body = (await req.json().catch(() => null)) as { action?: string; ledgerSignature?: string } | null
  const row = load(accountId, id)
  if (!row) return Response.json({ error: 'No such decision.' }, { status: 404 })
  if (row.state !== 'pending') {
    return Response.json({ error: `This decision is already ${row.state}.` }, { status: 409 })
  }
  if (Date.now() > row.expires_at) {
    getDb().prepare("UPDATE decisions SET state='expired' WHERE id=?").run(id)
    return Response.json({ error: 'This approval expired. Ask the agent to try again.' }, { status: 410 })
  }

  if (body?.action === 'decline') {
    getDb().prepare("UPDATE decisions SET state='denied' WHERE id=?").run(id)
    return Response.json({ state: 'denied', note: 'Nothing was sent.' })
  }
  if (!body?.ledgerSignature) {
    return Response.json({ error: 'ledgerSignature is required to approve.' }, { status: 400 })
  }

  // Policy may have changed while this sat pending. It was scored against the old limits.
  const cur = getDb()
    .prepare('SELECT policy_version FROM wallets WHERE account_id=?')
    .get(accountId) as { policy_version: number }
  if (cur.policy_version !== row.policy_version) {
    getDb().prepare("UPDATE decisions SET state='expired' WHERE id=?").run(id)
    return Response.json(
      { error: 'Your guardrails changed since this was checked, so it was discarded. Ask the agent to try again.' },
      { status: 409 }
    )
  }

  const bytes = Uint8Array.from(Buffer.from(row.tx_bytes_b64, 'base64'))
  if (sha256(bytes) !== row.bytes_sha256) {
    return Response.json({ error: 'Stored transaction bytes do not match their hash. Refusing.' }, { status: 500 })
  }

  // Re-simulate immediately before signing. Chain state moves, and the human is approving a
  // specific set of effects — not merely a digest.
  const fresh = await simulate(bytes, row.sender)
  if (fresh.kind !== 'ok') {
    getDb().prepare("UPDATE decisions SET state='expired' WHERE id=?").run(id)
    return Response.json(
      { error: `This no longer succeeds on chain (${fresh.kind}), so it was not sent.` },
      { status: 409 }
    )
  }

  const frozen = {
    bytes,
    sha256: row.bytes_sha256,
    digest: '',
    sender: row.sender,
    sponsorSignature: undefined as string | undefined,
    gasPaidBySponsor: false,
  }
  // The sponsor signature was captured at build time and travels with the stored bytes.
  const stored = JSON.parse(row.evidence_json) as { sponsorSignature?: string }
  if (stored?.sponsorSignature) frozen.sponsorSignature = stored.sponsorSignature

  try {
    const exec = await executeFromProtected(accountId, frozen, body.ledgerSignature)
    getDb().prepare("UPDATE decisions SET state='executed', digest=? WHERE id=?").run(exec.digest, id)
    for (const bc of fresh.evidence.balanceChanges) {
      if (bc.address === row.sender && BigInt(bc.amount) < 0n) {
        recordSpend(accountId, bc.coinType, (-BigInt(bc.amount)).toString(), exec.digest)
      }
    }
    return Response.json({
      state: 'executed',
      digest: exec.digest,
      explorer: `https://suiscan.xyz/testnet/tx/${exec.digest}`,
    })
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message.split('\n')[0].slice(0, 300) : String(e) },
      { status: 400 }
    )
  }
}
