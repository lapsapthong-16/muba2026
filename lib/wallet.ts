import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import { getBalance, SUI_TYPE, SUI_DECIMALS } from './sui'
import { buildTransfer, buildTransferAll, buildSwap, quoteSwap, type FrozenTx } from './tx'
import { executeFromSpending, recordSpend } from './execute'
import { simulate } from './evidence'
import { PolicySchema, evaluate, type Policy } from './policy/policy'
import { requestBallot } from './ballot'
import { gate, type GateDecision } from './gate'
import { spentLast7d } from './db'

/**
 * The pipeline every money-moving tool runs. One code path, both demo instructions.
 *
 *   build (once, frozen) -> simulate -> evidence -> deterministic evaluate -> [Gonka] -> gate
 *      allow        -> re-check sha256 -> sign with H -> execute
 *      needs_ledger -> persist a decision, return a handle in well under a second
 *      blocked      -> return, nothing signed
 *
 * WHERE GONKA SITS. Measured 14-105s cold against ~100ms for the deterministic checks, and the MCP
 * client deadline is 60s — so the model cannot sit in front of every transaction. Two modes:
 *
 *   deterministic CLEAN      -> consult with a short advisory budget. If it answers "not low" we
 *                               escalate. If it ABSTAINS we proceed on the deterministic clear and
 *                               record that the model did not vote. That is not failing open: the
 *                               rules already cleared it, and the alternative is escalating every
 *                               transaction whenever a shared GPU pool is busy.
 *   deterministic FLAGGED    -> we are escalating regardless. Gonka runs with a full budget to
 *                               write the explanation the human reads, and its abstention cannot
 *                               downgrade anything.
 */

/**
 * Measured, not guessed: a cold MiniMax call answered in 7,972ms against an 8,000ms budget, so the
 * old advisory window was losing by 28 milliseconds and every transaction recorded an abstention.
 * A cold call was then measured at 24.4s, so 20s was still too tight. 30s leaves real headroom and
 * still returns inside the MCP client's 60s deadline alongside build, simulate and execute.
 */
const ADVISORY_BUDGET_MS = 30_000
const ESCALATION_BUDGET_MS = 30_000
/**
 * How long a held transaction stays approvable.
 *
 * 10 minutes was too tight in practice: unlocking a device, opening the Sui app and reading the
 * screen is unhurried work, and an approval that quietly vanishes looks like broken hardware
 * rather than an expiry. 30 minutes is still bounded — the transaction is re-simulated immediately
 * before signing, so a stale one is caught by chain state rather than by this clock.
 */
const APPROVAL_TTL_MS = 30 * 60 * 1000

export interface WalletRow {
  account_id: string
  h_address: string
  m_address: string | null
  enc_platform_key: string
  ledger_address: string | null
  committees_json: string | null
  policy_json: string | null
  policy_version: number
}

export async function getWallet(accountId: string): Promise<WalletRow & { lastDecision?: unknown }> {
  const w = getDb().prepare('SELECT * FROM wallets WHERE account_id = ?').get(accountId) as WalletRow | undefined
  if (!w) throw new Error('No wallet for this account')
  const last = getDb()
    .prepare('SELECT id, state, intent, verdict_json, gonka_request_id, digest FROM decisions WHERE account_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(accountId)
  return { ...w, lastDecision: last }
}

function loadPolicy(w: WalletRow): Policy | null {
  if (!w.policy_json) return null
  return PolicySchema.parse(JSON.parse(w.policy_json))
}

const toMist = (sui: number) => BigInt(Math.round(sui * 10 ** SUI_DECIMALS))
const fmtSui = (mist: bigint) => (Number(mist) / 10 ** SUI_DECIMALS).toFixed(4).replace(/\.?0+$/, '')

export async function walletStatus(accountId: string): Promise<Record<string, unknown>> {
  const w = await getWallet(accountId)
  const configured = !!w.h_address && !!w.policy_json && !!w.ledger_address
  if (!configured) {
    return {
      outcome: 'needs_setup',
      funds_moved: false,
      wallet_ready: false,
      missing: [
        !w.h_address && 'wallet not created',
        !w.ledger_address && 'Ledger not connected',
        !w.policy_json && 'guardrails not set',
      ].filter(Boolean),
      next_action:
        'Show the setup link from onboarding to the human. They must create the wallet, connect a ' +
        'Ledger and set spending limits. You cannot do this for them.',
    }
  }
  const policy = loadPolicy(w)!
  // Fail loudly rather than reading undefined. A cap that does not match is how a spending limit
  // silently stops binding — the policy schema stores the LONG coin-type form, so a short-form
  // constant here would find nothing.
  const cap = policy.caps.find((c) => c.coinType === SUI_TYPE)
  if (!cap) {
    throw new Error(
      `No configured cap for ${SUI_TYPE}. Policy holds: ${policy.caps.map((c) => c.coinType).join(', ')}`
    )
  }
  const spent = spentLast7d(accountId, SUI_TYPE)
  const pending = getDb()
    .prepare("SELECT id, intent, created_at FROM decisions WHERE account_id=? AND state='pending' AND expires_at > ?")
    .all(accountId, Date.now())

  return {
    outcome: 'ok',
    funds_moved: false,
    wallet_ready: true,
    spending_address: w.h_address,
    protected_address: w.m_address,
    balance_sui: fmtSui(await getBalance(w.h_address)),
    guardrails: {
      per_transaction_limit_sui: fmtSui(BigInt(cap.perTxLimit)),
      weekly_limit_sui: fmtSui(BigInt(cap.weeklyLimit)),
      weekly_remaining_sui: fmtSui(BigInt(cap.weeklyLimit) - spent),
      allowed_recipients: policy.allowedRecipients.map((r) => r.address),
      allowed_packages: policy.allowedPackages.map((p) => p.packageId),
    },
    pending_approvals: pending,
  }
}

export async function submitTransfer(
  accountId: string,
  args: { to: string; amount_sui: number | 'all'; reason: string }
): Promise<Record<string, unknown>> {
  const w = await getWallet(accountId)
  const policy = loadPolicy(w)
  if (!policy || !w.h_address) return walletStatus(accountId)

  const intent = `${args.amount_sui === 'all' ? 'all funds' : `${args.amount_sui} SUI`} -> ${args.to}`

  // BUILD ONCE. Nothing rebuilds these bytes; an empty gas payment would inject a random nonce
  // and the rebuilt transaction would differ from the one that was scored.
  let frozen
  try {
    frozen =
      args.amount_sui === 'all'
        ? await buildTransferAll(w.h_address, args.to)
        : await buildTransfer(w.h_address, args.to, toMist(args.amount_sui))
  } catch (e) {
    return { outcome: 'blocked', funds_moved: false, rule: 'BUILD_FAILED',
      reasons: [e instanceof Error ? e.message.split('\n')[0] : String(e)] }
  }

  const sim = await simulate(frozen.bytes, w.h_address)
  const verdict = sim.kind === 'ok' ? evaluate(policy, sim.evidence, (ct) => spentLast7d(accountId, ct)) : null

  // Consult the model. Budget and interpretation depend on whether we are already escalating.
  let ballot = null
  if (sim.kind === 'ok' && verdict) {
    const escalating = verdict.verdict !== 'allow'
    const b = await requestBallot(sim.evidence, w.h_address, args.reason,
      escalating ? ESCALATION_BUDGET_MS : ADVISORY_BUDGET_MS)
    // On the clean path an abstention is advisory-only: the deterministic rules already cleared
    // it, so a busy GPU pool must not turn every payment into a hardware prompt.
    ballot = b.ok || escalating ? b : null
  }

  const decision = gate(sim, verdict, ballot)

  if (decision.outcome === 'blocked') {
    record(accountId, frozen, decision, sim, intent, w, 'blocked')
    return {
      outcome: 'blocked', funds_moved: false, rule: decision.rule, reasons: decision.reasons,
      note: 'Nothing was sent. This is outside the limits the owner set; a hardware approval cannot widen them. Ask them to change the guardrails if it is legitimate.',
    }
  }

  if (decision.outcome === 'needs_ledger') {
    // REBUILD FROM M. The transaction we scored was sent from H, a 1-of-2 the platform key already
    // satisfies alone — a Ledger tap on those bytes would prove nothing, because we could have
    // signed them without the device. Re-originating from M (2-of-2) is what makes the hardware
    // signature load-bearing: validators reject the platform partial on its own with
    // "Insufficient weight=1 threshold=2".
    if (!w.m_address) {
      return { outcome: 'blocked', funds_moved: false, rule: 'NO_PROTECTED_ADDRESS',
        reasons: ['This needs approval but no Ledger is enrolled, so there is nowhere to escalate to.'] }
    }
    let escalated
    try {
      escalated =
        args.amount_sui === 'all'
          ? await buildTransferAll(w.m_address, args.to)
          : await buildTransfer(w.m_address, args.to, toMist(args.amount_sui))
    } catch (e) {
      return { outcome: 'blocked', funds_moved: false, rule: 'PROTECTED_UNFUNDED',
        reasons: [
          e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e),
          `Escalated payments are sent from the protected address (${w.m_address}), which needs its own funds.`,
        ] }
    }
    // Score the bytes that will actually be signed, not the ones we replaced.
    const sim2 = await simulate(escalated.bytes, w.m_address)
    const verdict2 = sim2.kind === 'ok'
      ? evaluate({ ...policy, walletAddress: w.m_address }, sim2.evidence, (ct) => spentLast7d(accountId, ct))
      : null
    const decision2 = gate(sim2, verdict2, ballot)

    const id = record(accountId, escalated, decision2, sim2, intent, w, 'pending')
    return {
      outcome: 'awaiting_approval', funds_moved: false, approval_id: id, rule: decision.rule,
      reasons: decision.reasons, expires_in_seconds: APPROVAL_TTL_MS / 1000,
      risk: decision2.ballotRisk, risk_score: decision2.ballotScore, risk_reasons: decision2.ballotReasons,
      gonka_request_id: decision2.gonkaRequestId,
      from: w.m_address,
      note: 'NOTHING HAS BEEN SENT. This was re-issued from the protected address, which needs the owner\'s Ledger as a second signature — our key alone cannot move it. Poll wallet_approval_status. Do not retry: a retry creates a second pending approval, it does not bypass this one.',
    }
  }

  // allow -> actually sign and broadcast. executeFromSpending re-checks the sha256 first, so the
  // bytes that were scored are provably the bytes that get signed.
  let exec
  try {
    exec = await executeFromSpending(accountId, frozen)
  } catch (e) {
    const id = record(accountId, frozen, decision, sim, intent, w, 'blocked')
    return {
      outcome: 'blocked', funds_moved: false, rule: 'EXECUTION_FAILED', decision_id: id,
      reasons: [e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e)],
      note: 'Nothing was sent.',
    }
  }

  // Debit the rolling window from the SETTLED outflow, not the requested amount. Reaching here
  // means the gate returned allow, which is only possible with a non-null verdict.
  for (const o of verdict!.outflows) recordSpend(accountId, o.coinType, o.principal, exec.digest)

  const id = record(accountId, frozen, decision, sim, intent, w, 'executed')
  getDb().prepare('UPDATE decisions SET digest=? WHERE id=?').run(exec.digest, id)
  return {
    outcome: 'executed', funds_moved: true, digest: exec.digest, rule: decision.rule,
    risk: decision.ballotRisk, risk_score: decision.ballotScore, risk_reasons: decision.ballotReasons,
    risk_latency_ms: decision.ballotLatencyMs, gonka_request_id: decision.gonkaRequestId,
    explorer: `https://suiscan.xyz/testnet/tx/${exec.digest}`,
    note: "Signed and submitted within the owner's limits.",
  }
}

function record(
  accountId: string, frozen: FrozenTx,
  d: GateDecision, sim: unknown, intent: string, w: WalletRow, state: string
): string {
  const id = randomUUID()
  // The SPONSOR SIGNATURE has to survive to approval time: it was produced at build time over
  // these exact bytes, and a sponsored transaction needs it alongside ours at execution. Losing it
  // would leave a pending approval that can never be broadcast.
  // A 'pending' row is one the approve route will hand to executeFromProtected, which signs with
  // the M committee. If its sender is anything but M, the human taps their Ledger, the signature
  // VERIFIES — combineAndVerify checks the signature against the bytes, never that the signer's
  // address matches the sender — and the validator rejects it only at broadcast, after the device
  // has already said yes. Fail here instead, where the mistake is one line from its cause.
  if (state === 'pending' && frozen.sender !== w.m_address) {
    throw new Error(
      `Refusing to store an approval that cannot be signed: sender ${frozen.sender} is not the ` +
        `protected address ${w.m_address}. Escalated transactions must be rebuilt from M.`
    )
  }

  const stored = {
    sim,
    sponsorSignature: frozen.sponsorSignature,
    gasPaidBySponsor: frozen.gasPaidBySponsor,
  }
  getDb().prepare(
    `INSERT INTO decisions(id,account_id,state,intent,evidence_json,verdict_json,gonka_request_id,
       tx_bytes_b64,bytes_sha256,sender,policy_version,digest,created_at,expires_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, accountId, state, intent, JSON.stringify(stored), JSON.stringify(d), d.gonkaRequestId,
    Buffer.from(frozen.bytes).toString('base64'), frozen.sha256, frozen.sender,
    w.policy_version, state === 'executed' ? frozen.digest : null, Date.now(), Date.now() + APPROVAL_TTL_MS
  )
  return id
}

export async function approvalStatus(
  accountId: string, approvalId: string, waitMs: number
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + Math.min(waitMs, 45_000)
  for (;;) {
    const row = getDb()
      .prepare('SELECT state, digest, verdict_json FROM decisions WHERE id=? AND account_id=?')
      .get(approvalId, accountId) as { state: string; digest: string | null; verdict_json: string } | undefined
    if (!row) return { outcome: 'not_found', funds_moved: false }
    if (row.state !== 'pending') {
      const moved = row.state === 'executed'
      return {
        outcome: row.state, funds_moved: moved, ...(moved && row.digest ? { digest: row.digest } : {}),
        note: moved ? 'The owner approved it on their Ledger and it settled.'
          : row.state === 'denied' ? 'The owner declined on their Ledger. Nothing was sent. Do not retry.'
          : 'Nothing was sent.',
      }
    }
    if (Date.now() >= deadline) {
      return { outcome: 'pending_approval', funds_moved: false,
        note: 'Still waiting for the owner. Call again to keep waiting. Nothing has been sent.' }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}


/**
 * A DeepBook swap — the agent doing real work rather than just moving money out.
 *
 * Runs the identical pipeline as a transfer: build, simulate, score, gate. The interesting part is
 * that a swap SHOULD look different to the risk engine — value leaves and value returns inside one
 * transaction — where a drain has an outflow and nothing coming back. That contrast is the whole
 * argument for scoring effects rather than intentions.
 */
export async function submitSwap(
  accountId: string,
  args: { pool?: string; amount_sui: number; reason: string }
): Promise<Record<string, unknown>> {
  const w = await getWallet(accountId)
  const policy = loadPolicy(w)
  if (!policy || !w.h_address) return walletStatus(accountId)

  const pool = args.pool ?? 'SUI_DBUSDC'

  // Quote FIRST. The fillable floor is set by the resting orders, not by the pool config, so it
  // moves: measured live this book returns zero at 1.0 SUI and fills from 1.1, even though its stated
  // minSize is 1 — building a swap the book cannot fill wastes gas and produces a transaction the
  // agent cannot learn anything from.
  let quote
  try {
    quote = await quoteSwap(pool, args.amount_sui)
  } catch (e) {
    return { outcome: 'blocked', funds_moved: false, rule: 'QUOTE_FAILED',
      reasons: [e instanceof Error ? e.message.split('\n')[0].slice(0, 160) : String(e)] }
  }
  if (!quote.quoteOut || quote.quoteOut <= 0) {
    return {
      outcome: 'blocked', funds_moved: false, rule: 'BELOW_MARKET_MINIMUM',
      reasons: [`Swapping ${args.amount_sui} SUI on ${pool} returns nothing — the order book has no fill at that size.`],
      hint: 'Try a larger size — this book most recently began filling around 1.1 SUI, but that floor moves with the resting orders. If larger sizes also return nothing, the book is empty.',
    }
  }

  const minOut = quote.quoteOut * 0.99 // 1% slippage floor, set by us and never by the agent
  const intent = `swap ${args.amount_sui} SUI on ${pool} for >= ${minOut.toFixed(4)}`

  let frozen: FrozenTx
  try {
    frozen = await buildSwap(w.h_address, pool, args.amount_sui, minOut)
  } catch (e) {
    return { outcome: 'blocked', funds_moved: false, rule: 'BUILD_FAILED',
      reasons: [e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e)] }
  }

  const sim = await simulate(frozen.bytes, w.h_address)
  const verdict = sim.kind === 'ok' ? evaluate(policy, sim.evidence, (ct) => spentLast7d(accountId, ct)) : null
  const ballot = sim.kind === 'ok' && verdict
    ? await requestBallot(sim.evidence, w.h_address, args.reason, ESCALATION_BUDGET_MS)
    : null
  const decision = gate(sim, verdict, ballot)

  if (decision.outcome === 'blocked') {
    record(accountId, frozen, decision, sim, intent, w, 'blocked')
    return {
      outcome: 'blocked', funds_moved: false, rule: decision.rule, reasons: decision.reasons,
      quote: { pool, in_sui: args.amount_sui, expected_out: quote.quoteOut, min_out: minOut },
      risk: decision.ballotRisk, risk_score: decision.ballotScore,
      note: 'Nothing was swapped.',
    }
  }

  if (decision.outcome === 'needs_ledger') {
    // REBUILD FROM M, exactly as submitTransfer does. Storing the H-built bytes here was a bug you
    // could only see at the very end: the approve route calls executeFromProtected
    // unconditionally, so it would combine an M-committee signature over a transaction whose
    // sender is H. combineAndVerify checks the signature against the BYTES, not that the signer's
    // address matches the sender, so it verifies happily and the validator rejects it at
    // broadcast — an approval the human could sign on the device and still never see settle.
    if (!w.m_address) {
      return { outcome: 'blocked', funds_moved: false, rule: 'NO_PROTECTED_ADDRESS',
        reasons: ['This trade needs approval but no Ledger is enrolled, so there is nowhere to escalate to.'] }
    }
    let escalated: FrozenTx
    try {
      escalated = await buildSwap(w.m_address, pool, args.amount_sui, minOut)
    } catch (e) {
      return { outcome: 'blocked', funds_moved: false, rule: 'PROTECTED_UNFUNDED',
        reasons: [
          e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e),
          `Escalated trades are sent from the protected address (${w.m_address}), which needs its own funds.`,
        ] }
    }
    // Score the bytes that will actually be signed, not the ones we replaced.
    const sim2 = await simulate(escalated.bytes, w.m_address)
    const verdict2 = sim2.kind === 'ok'
      ? evaluate({ ...policy, walletAddress: w.m_address }, sim2.evidence, (ct) => spentLast7d(accountId, ct))
      : null
    const decision2 = gate(sim2, verdict2, ballot)

    const id = record(accountId, escalated, decision2, sim2, intent, w, 'pending')
    return {
      outcome: 'awaiting_approval', funds_moved: false, approval_id: id,
      rule: decision.rule, reasons: decision.reasons, expires_in_seconds: APPROVAL_TTL_MS / 1000,
      quote: { pool, in_sui: args.amount_sui, expected_out: quote.quoteOut, min_out: minOut },
      risk: decision2.ballotRisk, risk_score: decision2.ballotScore,
      from: w.m_address,
      note: 'NOTHING WAS SWAPPED. This was re-issued from the protected address, which needs the owner\'s Ledger as a second signature. Poll wallet_approval_status.',
    }
  }

  try {
    const exec = await executeFromSpending(accountId, frozen)
    for (const o of verdict!.outflows) recordSpend(accountId, o.coinType, o.principal, exec.digest)
    const id = record(accountId, frozen, decision, sim, intent, w, 'executed')
    getDb().prepare('UPDATE decisions SET digest=? WHERE id=?').run(exec.digest, id)
    return {
      outcome: 'executed', funds_moved: true, digest: exec.digest,
      explorer: `https://suiscan.xyz/testnet/tx/${exec.digest}`,
      quote: { pool, in_sui: args.amount_sui, expected_out: quote.quoteOut, min_out: minOut },
      risk: decision.ballotRisk, risk_score: decision.ballotScore,
      gonka_request_id: decision.gonkaRequestId,
    }
  } catch (e) {
    return { outcome: 'blocked', funds_moved: false, rule: 'EXECUTION_FAILED',
      reasons: [e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e)] }
  }
}
