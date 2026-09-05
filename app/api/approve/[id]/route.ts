import { getDb } from '@/lib/db'
import { requireHuman, authErrorResponse } from '@/lib/auth'
import { executeFromProtected, recordSpend } from '@/lib/execute'
import { sha256 } from '@/lib/tx'
import { simulate } from '@/lib/evidence'
import { describe } from '@/lib/describe'
import { PolicySchema, evaluate, type Policy } from '@/lib/policy/policy'
import { spentLast7d } from '@/lib/db'
import { SUI_DECIMALS } from '@/lib/sui'
import { requestConsensus } from '@/lib/ballot'

/**
 * IN-BAND ADJUSTMENT — the best idea in MetaMask's docs, and the fix for our worst moment.
 *
 * Before this, a transaction over the per-transaction limit meant: stop, leave the terminal, open
 * a settings page, invent a new number, save, then ask the agent to try again. We lived that for
 * an evening. MetaMask sets the limit at the moment it first binds and lets you raise it with the
 * same tap that approves the transaction, which is obviously right — the moment you are being
 * asked is the only moment you have enough context to answer.
 *
 * THREE THINGS KEEP IT SAFE, and none of them may be relaxed:
 *
 *   1. THE SERVER PROPOSES THE NUMBER. It is derived from the transaction already in front of the
 *      human. The agent cannot ask for a limit, cannot influence one, and there is no field in any
 *      tool schema through which a number could arrive.
 *   2. A HARDWARE SIGNATURE MUST BE PRESENT. An adjustment rides along with an approval that the
 *      Ledger has already signed. This is strictly stronger than our settings page, which needs
 *      only a browser session — so the in-band path is the *harder* way to widen a limit, not a
 *      shortcut around one.
 *   3. THE WEEKLY CAP IS THE CEILING AND IS NEVER RAISABLE. A per-transaction limit can rise to
 *      meet the weekly cap and no further. WEEKLY_CAP stays a hard deny, because "hardware cannot
 *      create budget" is the one promise that makes the rest of the limits mean anything.
 */

const fmt = (mist: bigint) => (Number(mist) / 10 ** SUI_DECIMALS).toFixed(4).replace(/\.?0+$/, '')

interface Adjustments {
  raise_limit?: { from_sui: string; to_sui: string; ceiling_sui: string; toMist: string; why: string }
  allow_recipient?: { address: string; why: string }
}

/**
 * What could be adjusted so this class of transaction stops asking. Returns nothing at all unless
 * the rule that fired is one adjustment would actually fix — we never offer to widen a limit that
 * was not the reason for the hold.
 */
function offerAdjustments(
  policy: Policy, accountId: string, evidence: unknown, rule: string | null, sender: string
): Adjustments {
  const out: Adjustments = {}
  let v
  try {
    // Evaluate against the ACTUAL sender. An escalation was rebuilt from the protected address, so
    // scoring it against the policy's own walletAddress (the spending one) makes the real sender
    // look like a counterparty and the outflow read as zero — which silently produced no offer at
    // all on exactly the rule this feature exists for. submitTransfer makes the same override.
    v = evaluate({ ...policy, walletAddress: sender }, evidence as never, (ct) => spentLast7d(accountId, ct))
  } catch {
    return out
  }
  const cap = policy.caps[0]

  if (rule === 'PER_TX_LIMIT') {
    const need = v.outflows.reduce((m, o) => (BigInt(o.principal) > m ? BigInt(o.principal) : m), 0n)
    const ceiling = BigInt(cap.weeklyLimit)
    // Round up to a whole 0.1 SUI so the stored limit is a number a human recognises later,
    // rather than the exact size of one historical payment.
    const step = 100_000_000n
    const rounded = ((need + step - 1n) / step) * step
    const target = rounded > ceiling ? ceiling : rounded
    if (target > BigInt(cap.perTxLimit)) {
      out.raise_limit = {
        from_sui: fmt(BigInt(cap.perTxLimit)),
        to_sui: fmt(target),
        ceiling_sui: fmt(ceiling),
        toMist: target.toString(),
        why: `This payment is ${fmt(need)} SUI, over your ${fmt(BigInt(cap.perTxLimit))} SUI single-payment limit. Raising it to ${fmt(target)} SUI stops payments this size from asking again. Your ${fmt(ceiling)} SUI weekly cap does not change and cannot be raised here.`,
      }
    }
  }

  if (rule === 'UNKNOWN_RECIPIENT' && v.recipients.length) {
    const unknown = v.recipients.find((r) => !policy.allowedRecipients.some((a) => a.address === r))
    if (unknown) {
      out.allow_recipient = {
        address: unknown,
        why: `${unknown.slice(0, 8)}…${unknown.slice(-6)} is not on your approved list. Adding it means future payments to this address settle without asking — only add it if you recognise it.`,
      }
    }
  }
  return out
}

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
  const riskConsensus = decision.consensus ?? (typeof decision.ballotScore === 'number'
    ? {
        legacy: true,
        consensus: decision.ballotRisk === 'low' ? 'low_quorum' : 'review_required',
        validVotes: 1,
        lowVotes: decision.ballotRisk === 'low' ? 1 : 0,
        votes: [{ model: 'Legacy MiniMax ballot', ok: true, requestId: decision.gonkaRequestId ?? null, devshardId: null,
          ballot: { score: decision.ballotScore, risk: decision.ballotRisk, reasons: decision.ballotReasons ?? [] } }],
      }
    : null)
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

  // What could be adjusted, computed from the transaction in front of them.
  let adjustments: Adjustments = {}
  try {
    const pj = getDb().prepare('SELECT policy_json FROM wallets WHERE account_id=?').get(accountId) as { policy_json: string }
    if (pj?.policy_json && evidence) {
      adjustments = offerAdjustments(PolicySchema.parse(JSON.parse(pj.policy_json)), accountId, evidence, decision.rule, row.sender)
    }
  } catch { /* an adjustment offer must never block an approval */ }

  // The card named the rule and the risk but never the remaining budget, so a human had no way to
  // notice they were approving the payment that would exhaust it.
  let weekly_remaining_sui: string | null = null
  try {
    const pj = getDb().prepare('SELECT policy_json FROM wallets WHERE account_id=?').get(accountId) as { policy_json: string }
    const pol = PolicySchema.parse(JSON.parse(pj.policy_json))
    const cap = pol.caps[0]
    weekly_remaining_sui = fmt(BigInt(cap.weeklyLimit) - spentLast7d(accountId, cap.coinType))
  } catch { /* informational only */ }

  return Response.json({
    description,
    adjustments,
    weekly_remaining_sui,
    id: row.id,
    state: row.state,
    intent: row.intent,
    from: row.sender,
    expired: Date.now() > row.expires_at,
    expires_in_seconds: Math.max(0, Math.round((row.expires_at - Date.now()) / 1000)),
    rule: decision.rule,
    reasons: decision.reasons,
    risk_consensus: riskConsensus,
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
  const body = (await req.json().catch(() => null)) as {
    action?: string
    ledgerSignature?: string
    /** Opt-ins, only ever honoured alongside a hardware signature. */
    also_raise_limit?: boolean
    also_allow_recipient?: boolean
  } | null
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

  /**
   * RE-RUN THE DETERMINISTIC FLOOR, AT THE MOMENT THE MONEY MOVES.
   *
   * Everything above re-checks that this is the same transaction: same state, same policy version,
   * same bytes, same on-chain outcome. None of it re-checks that it is still ALLOWED. A hold is
   * scored when it is created, and the budget it was scored against can be spent out from under it
   * while it waits — by the agent, through perfectly legitimate payments that each pass on their
   * own. The human then taps once and settles a payment the floor would now deny.
   *
   * That matters because WEEKLY_CAP is the one rule a hardware approval must never be able to
   * widen; the guardrails page promises exactly that. A `require_approval` reason is precisely what
   * the tap is for and still passes here. A `deny` is not tappable, and never was.
   */
  try {
    const pj = getDb().prepare('SELECT policy_json FROM wallets WHERE account_id=?').get(accountId) as
      | { policy_json: string | null }
      | undefined
    if (pj?.policy_json) {
      const pol = PolicySchema.parse(JSON.parse(pj.policy_json))
      const now = evaluate({ ...pol, walletAddress: row.sender }, fresh.evidence, (ct) => spentLast7d(accountId, ct))
      const hard = now.reasons.find((r) => r.verdict === 'deny')
      if (hard) {
        getDb().prepare("UPDATE decisions SET state='blocked' WHERE id=?").run(id)
        return Response.json(
          {
            error: hard.human,
            rule: hard.rule,
            note: 'Nothing was sent. This was inside your limits when it was held, but no longer is — ' +
              'other spending has happened since. A hardware approval cannot widen this one.',
          },
          { status: 409 }
        )
      }
    }
  } catch (e) {
    // A floor we cannot evaluate is a floor we cannot honour. Refuse rather than assume.
    return Response.json(
      { error: `Could not re-check your guardrails, so nothing was sent. (${e instanceof Error ? e.message.slice(0, 120) : String(e)})` },
      { status: 500 }
    )
  }

  // The bytes are fixed, but their simulated effects can change with live chain state. Re-run and
  // retain the model review for the effects being executed. A held payment is already behind the
  // Ledger gate, so a high-risk fresh review explains the tap; it does not void it on its own.
  const freshConsensus = await requestConsensus(fresh.evidence, row.sender, row.intent)
  getDb().prepare('UPDATE decisions SET ballot_json=? WHERE id=?').run(JSON.stringify(freshConsensus), id)

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
    /**
     * Adjust AFTER the transaction has settled, never before.
     *
     * Writing policy bumps policy_version, and a version bump voids every pending decision —
     * including, if we did this first, the very one we are in the middle of approving. Executing
     * first also means a failed broadcast leaves the limits exactly as they were: you cannot end
     * up with a widened limit and nothing to show for it.
     */
    const adjusted: string[] = []
    if (body.also_raise_limit || body.also_allow_recipient) {
      try {
        const pj = getDb().prepare('SELECT policy_json, policy_version FROM wallets WHERE account_id=?')
          .get(accountId) as { policy_json: string; policy_version: number }
        const policy = PolicySchema.parse(JSON.parse(pj.policy_json))
        // Recompute the offer from the FRESH simulation rather than trusting anything the client
        // sent. The request carries booleans only — never an address, never an amount — so there
        // is nothing in the body for a compromised page to inflate.
        const offer = offerAdjustments(policy, accountId, fresh.evidence, JSON.parse(row.verdict_json).rule, row.sender)

        if (body.also_raise_limit && offer.raise_limit) {
          policy.caps[0].perTxLimit = offer.raise_limit.toMist
          adjusted.push(`Single-payment limit raised to ${offer.raise_limit.to_sui} SUI.`)
        }
        if (body.also_allow_recipient && offer.allow_recipient) {
          policy.allowedRecipients.push({ address: offer.allow_recipient.address, label: 'Added when you approved a payment' })
          adjusted.push(`${offer.allow_recipient.address.slice(0, 8)}…${offer.allow_recipient.address.slice(-6)} added to your approved payees.`)
        }
        if (adjusted.length) {
          const next = PolicySchema.parse({ ...policy, version: pj.policy_version + 1 })
          getDb().prepare('UPDATE wallets SET policy_json=?, policy_version=? WHERE account_id=?')
            .run(JSON.stringify(next), next.version, accountId)
          getDb().prepare("UPDATE decisions SET state='expired' WHERE account_id=? AND state='pending'").run(accountId)
        }
      } catch (e) {
        // The payment already settled. A failed adjustment is worth reporting, never worth
        // turning into a failure of the thing that actually worked.
        adjusted.push(`Could not update your guardrails: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`)
      }
    }

    return Response.json({
      state: 'executed',
      digest: exec.digest,
      explorer: `https://suiscan.xyz/testnet/tx/${exec.digest}`,
      ...(adjusted.length ? { guardrails_updated: adjusted } : {}),
    })
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message.split('\n')[0].slice(0, 300) : String(e) },
      { status: 400 }
    )
  }
}
