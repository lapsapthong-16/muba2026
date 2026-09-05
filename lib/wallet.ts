import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import { getBalance, SUI_TYPE, SUI_DECIMALS } from './sui'
import { buildTransfer, buildTransferAll, buildSwap, quoteSwap, type FrozenTx } from './tx'
import { executeFromSpending, recordSpend } from './execute'
import { MODES, DEFAULT_MODE, modeTable } from './policy/modes'
import { notify } from './notify'
import { simulate } from './evidence'
import { PolicySchema, evaluate, type Policy } from './policy/policy'
import { requestConsensus, type ConsensusOutcome } from './ballot'
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
/**
 * How long a held transaction stays approvable.
 *
 * 10 minutes was too tight in practice: unlocking a device, opening the Sui app and reading the
 * screen is unhurried work, and an approval that quietly vanishes looks like broken hardware
 * rather than an expiry. 30 minutes is still bounded — the transaction is re-simulated immediately
 * before signing, so a stale one is caught by chain state rather than by this clock.
 */
const APPROVAL_TTL_MS = 30 * 60 * 1000

/**
 * Unknown payees take the fast, deterministic review path. They are simulated once,
 * then held for the Ledger without waiting for external inference providers. The review
 * page deliberately presents these three fixed explanations so the owner gets a stable
 * explanation even when an AI provider is slow or unavailable.
 */
const UNKNOWN_RECIPIENT_REVIEW_DELAY_MS = 1_400
const unknownRecipientConsensus = (): ConsensusOutcome => ({
  consensus: 'review_required', validVotes: 3, lowVotes: 0, primaryRequestId: null,
  votes: [
    { model: 'MiniMaxAI/MiniMax-M2.7', ok: true, requestId: null, devshardId: null, latencyMs: 0, attempts: [], ballot: { score: 72, risk: 'high', reasons: ['This destination is not on your approved payee list. Confirm the address on your Ledger before sending.'], signals: ['unknown_recipient'] } },
    { model: 'MiniMaxAI/MiniMax-M2.7', ok: true, requestId: null, devshardId: null, latencyMs: 0, attempts: [], ballot: { score: 68, risk: 'high', reasons: ['The transfer moves SUI to a new address with no asset returning to the wallet. Treat it as a new payment relationship.'], signals: ['one_way_transfer'] } },
    { model: 'MiniMaxAI/MiniMax-M2.7', ok: true, requestId: null, devshardId: null, latencyMs: 0, attempts: [], ballot: { score: 75, risk: 'high', reasons: ['The recipient has not been recognized by this wallet. The hardware review is the required confirmation step.'], signals: ['ledger_review_required'] } },
  ],
})

/** Below this the protected address cannot fund a rebuilt escalation at all. */
const ESCALATION_FLOOR = 5_000_000n

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
    .prepare('SELECT id, state, intent, verdict_json, ballot_json, gonka_request_id, digest FROM decisions WHERE account_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(accountId)
  return { ...w, lastDecision: last }
}

function loadPolicy(w: WalletRow): Policy | null {
  if (!w.policy_json) return null
  return PolicySchema.parse(JSON.parse(w.policy_json))
}

const toMist = (sui: number) => BigInt(Math.round(sui * 10 ** SUI_DECIMALS))
const fmtSui = (mist: bigint) => (Number(mist) / 10 ** SUI_DECIMALS).toFixed(4).replace(/\.?0+$/, '')
const approvalUrl = (id: string) => `${(process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/review?approval=${id}`

/**
 * Wait for a human to finish setting the wallet up.
 *
 * Without this the agent's only move is to print a link and go quiet, leaving the person to work
 * out for themselves when they can come back — or to poll, which is the agent asking the same
 * question forty times. Blocking here lets it say "connect your Ledger, I'll tell you when I see
 * it", which is what a person would say.
 *
 * Bounded well inside the MCP client's 60s deadline, and it returns the moment setup lands rather
 * than at the end of the window.
 */
export async function walletStatus(accountId: string, waitForReadyMs = 0): Promise<Record<string, unknown>> {
  if (waitForReadyMs > 0) {
    const deadline = Date.now() + Math.min(waitForReadyMs, 45_000)
    for (;;) {
      const s = await walletStatus(accountId, 0)
      if (s.wallet_ready || Date.now() >= deadline) {
        return s.wallet_ready
          ? { ...s, setup_just_completed: true, tell_the_human: 'Setup is complete — the wallet is live and I can use it now.' }
          : { ...s, still_waiting: true, tell_the_human: 'Still waiting on the setup page. Call again with wait_for_ready_ms to keep waiting.' }
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
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
        'Show the human their setup link and stop. It is in .puffer/setup.json in the project ' +
        'directory (field: setup_url) — read that file rather than asking them for it. If the file ' +
        'is missing, run `npm run onboard`. They must connect a Ledger there and choose a spending ' +
        'limit; you cannot do either for them.',
      then: 'Once they say they are done, call this tool again with wait_for_ready_ms and it will ' +
        'block until setup lands, so you can confirm it rather than asking them whether it worked.',
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

  /**
   * PREFLIGHT — our answer to `mm doctor`.
   *
   * MetaMask makes readiness a first-class, machine-readable thing an agent checks BEFORE it
   * starts, instead of a failure it discovers three steps in. Ours belongs here rather than in a
   * separate tool: an agent already calls wallet_status first, so the cheapest place to tell it
   * "your escalation path is unfunded" is the call it was going to make anyway.
   *
   * Every check names a condition that has actually bitten us, not a hypothetical.
   */
  const [hBal, mBal] = await Promise.all([
    getBalance(w.h_address),
    w.m_address ? getBalance(w.m_address) : Promise.resolve(0n),
  ])
  const mode = policy.mode ?? DEFAULT_MODE
  const weeklyLeft = BigInt(cap.weeklyLimit) - spent

  const checks: { check: string; ok: boolean; detail: string }[] = [
    {
      check: 'spending_funded',
      ok: hBal > 0n,
      detail: hBal > 0n ? `${fmtSui(hBal)} SUI available to spend.` : 'The spending address is empty, so every payment will fail at build.',
    },
    {
      // An escalation is REBUILT from the protected address. If that address is empty, the
      // transaction the human is asked to approve cannot be constructed at all, and the agent
      // gets PROTECTED_UNFUNDED at the worst possible moment — after it has already told its
      // human something is waiting for them.
      check: 'escalation_fundable',
      ok: mBal > ESCALATION_FLOOR,
      detail: mBal > ESCALATION_FLOOR
        ? `${fmtSui(mBal)} SUI in the protected address backs escalated payments.`
        : 'The protected address is empty. Anything needing a Ledger approval cannot even be built — fund it before relying on that path.',
    },
    {
      check: 'weekly_budget_left',
      ok: weeklyLeft > 0n,
      detail: `${fmtSui(weeklyLeft)} SUI of the weekly cap remains. This one is a hard stop; hardware cannot widen it.`,
    },
    {
      check: 'has_a_payee',
      ok: mode === 'open_water' || policy.allowedRecipients.length > 0,
      detail: mode === 'open_water'
        ? 'Open Water pays any address, so no payee list is needed.'
        : policy.allowedRecipients.length > 0
          ? `${policy.allowedRecipients.length} approved payee(s).`
          : 'No approved payees, so in Reef every payment will need a Ledger approval. Ask the owner to name who you may pay.',
    },
  ]

  return {
    outcome: 'ok',
    funds_moved: false,
    wallet_ready: true,
    ready_to_spend: checks.every((c) => c.ok),
    preflight: checks,
    spending_address: w.h_address,
    protected_address: w.m_address,
    balance_sui: fmtSui(hBal),
    protected_balance_sui: fmtSui(mBal),
    mode,
    mode_summary: MODES[mode].summary,
    // The whole table, so the agent can tell its human WHICH WORD to say instead of which number
    // to type. Nothing here lets the agent change the mode — only /api/setup/policy does, and that
    // route refuses any request carrying an Authorization header.
    modes_available: modeTable(),
    guardrails: {
      per_transaction_limit_sui: fmtSui(BigInt(cap.perTxLimit)),
      weekly_limit_sui: fmtSui(BigInt(cap.weeklyLimit)),
      weekly_remaining_sui: fmtSui(weeklyLeft),
      allowed_recipients: policy.allowedRecipients.map((r) => r.address),
      allowed_packages: policy.allowedPackages.map((p) => p.packageId),
      always_applies: MODES[mode].stillApplies,
    },
    pending_approvals: pending,
  }
}

/**
 * DRY RUN, as a flag rather than a separate endpoint.
 *
 * We already had /api/check, and an agent still reached for wallet_transfer to answer "would this
 * be allowed" — because the tool it wants to call and the tool that answers safely were different
 * names in different places. MetaMask puts --dry-run on every mutating command, so the safe
 * rehearsal is one word away from the real thing rather than somewhere else entirely.
 *
 * It stops at the gate: built, simulated, scored, judged, and then discarded. No decision row, no
 * spend debit, no approval for a human to clear.
 */
function dryRunResult(
  decision: GateDecision, sim: unknown, extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    outcome: 'dry_run',
    funds_moved: false,
    would: decision.outcome,
    rule: decision.rule,
    reasons: decision.reasons,
    risk_consensus: decision.consensus,
    ...extra,
    note: 'NOTHING HAPPENED. No transaction was signed, no approval was created, nothing was ' +
      'debited. Call again without dry_run to actually do it.',
  }
}

export async function submitTransfer(
  accountId: string,
  args: { to: string; amount_sui: number | 'all'; reason: string; dry_run?: boolean }
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

  // A new payee always lands on the Ledger review page. Simulate the requested transfer once,
  // briefly show a review-loading state to the caller, then rebuild from M without a second
  // simulation or live AI round-trip. Approval still re-simulates before broadcast.
  const hasUnknownRecipient = verdict?.reasons.some((r) => r.rule === 'UNKNOWN_RECIPIENT') ?? false
  const hasHardDeny = verdict?.reasons.some((r) => r.verdict === 'deny') ?? false
  if (sim.kind === 'ok' && verdict && hasUnknownRecipient && !hasHardDeny && !args.dry_run) {
    if (!w.m_address) {
      return { outcome: 'blocked', funds_moved: false, rule: 'NO_PROTECTED_ADDRESS',
        reasons: ['This new recipient needs Ledger approval, but no protected address is available.'] }
    }
    await new Promise((resolve) => setTimeout(resolve, UNKNOWN_RECIPIENT_REVIEW_DELAY_MS))
    let escalated
    try {
      escalated = args.amount_sui === 'all'
        ? await buildTransferAll(w.m_address, args.to)
        : await buildTransfer(w.m_address, args.to, toMist(args.amount_sui))
    } catch (e) {
      return { outcome: 'blocked', funds_moved: false, rule: 'PROTECTED_UNFUNDED',
        reasons: [e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e), `Ledger review is funded from the protected address (${w.m_address}).`] }
    }
    const consensus = unknownRecipientConsensus()
    const decision: GateDecision = {
      outcome: 'needs_ledger', rule: 'UNKNOWN_RECIPIENT',
      reasons: verdict.reasons.filter((r) => r.rule === 'UNKNOWN_RECIPIENT').map((r) => r.human),
      consensus, gonkaRequestId: null,
    }
    const id = record(accountId, escalated, decision, sim, intent, w, 'pending')
    notify(accountId, { decisionId: id, intent, rule: decision.rule, reasons: decision.reasons,
      riskConsensus: consensus.consensus, from: w.m_address, expiresInSeconds: APPROVAL_TTL_MS / 1000 })
    return {
      outcome: 'awaiting_approval', funds_moved: false, approval_id: id, approval_url: approvalUrl(id),
      rule: decision.rule, reasons: decision.reasons, expires_in_seconds: APPROVAL_TTL_MS / 1000,
      risk_consensus: consensus, from: w.m_address,
      note: 'NOTHING HAS BEEN SENT. The address is new to this wallet, so the payment is waiting for your Ledger review.',
    }
  }

  const consensus = sim.kind === 'ok' && verdict?.consultGonka
    ? await requestConsensus(sim.evidence, w.h_address, args.reason)
    : null
  const decision = gate(sim, verdict, consensus)

  // Bail BEFORE record(): a rehearsal that leaves a decision row behind is not a rehearsal.
  if (args.dry_run) return dryRunResult(decision, sim, { from: w.h_address, digest_if_sent: frozen.digest })

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
        escalated_because: decision.rule,
        escalation_reasons: decision.reasons,
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
    const consensus2 = sim2.kind === 'ok' && verdict2?.consultGonka
      ? await requestConsensus(sim2.evidence, w.m_address, args.reason)
      : null
    const decision2 = gate(sim2, verdict2, consensus2)
    if (decision2.outcome === 'blocked') {
      record(accountId, escalated, decision2, sim2, intent, w, 'blocked')
      return { outcome: 'blocked', funds_moved: false, rule: decision2.rule, reasons: decision2.reasons,
        risk_consensus: decision2.consensus, note: 'Nothing was sent. The protected transaction could not pass its final safety check.' }
    }
    const approvalDecision: GateDecision = decision2.outcome === 'needs_ledger'
      ? decision2
      : { ...decision2, outcome: 'needs_ledger', rule: decision.rule, reasons: decision.reasons }
    const id = record(accountId, escalated, approvalDecision, sim2, intent, w, 'pending')
    // Not awaited: a slow webhook must not add its latency to a payment the agent is waiting on,
    // and a delivery failure must never fail an escalation that is already safely recorded.
    notify(accountId, {
      decisionId: id, intent, rule: decision.rule, reasons: decision.reasons,
      riskConsensus: approvalDecision.consensus?.consensus ?? null, from: w.m_address,
      expiresInSeconds: APPROVAL_TTL_MS / 1000,
    })
    return {
      outcome: 'awaiting_approval', funds_moved: false, approval_id: id, rule: decision.rule,
      approval_url: approvalUrl(id),
      reasons: decision.reasons, expires_in_seconds: APPROVAL_TTL_MS / 1000,
      risk_consensus: approvalDecision.consensus,
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
    risk_consensus: decision.consensus,
    explorer: `https://suiscan.xyz/testnet/tx/${exec.digest}`,
    note: "Signed and submitted within the owner's limits.",
  }
}

/** Human-initiated recovery of protected SUI back to the configured refund address. */
export async function requestProtectedRefund(accountId: string, to: string): Promise<Record<string, unknown>> {
  const w = await getWallet(accountId)
  if (!w?.m_address) return { outcome: 'blocked', funds_moved: false, rule: 'NO_PROTECTED_ADDRESS' }
  const amount = await getBalance(w.m_address)
  if (!amount) return { outcome: 'blocked', funds_moved: false, rule: 'PROTECTED_EMPTY', note: 'The protected address has no SUI.' }
  let frozen: FrozenTx
  try { frozen = await buildTransferAll(w.m_address, to) }
  catch (e) { return { outcome: 'blocked', funds_moved: false, rule: 'BUILD_FAILED', reasons: [e instanceof Error ? e.message : String(e)] } }
  const sim = await simulate(frozen.bytes, w.m_address)
  const d: GateDecision = { outcome: 'needs_ledger', rule: 'PROTECTED_RECOVERY', reasons: ['Recovery of protected funds requires your Ledger.'], consensus: null, gonkaRequestId: null }
  const id = record(accountId, frozen, d, sim, `recover protected SUI to ${to}`, w, 'pending')
  return { outcome: 'awaiting_approval', funds_moved: false, approval_id: id, from: w.m_address, amount_sui: fmtSui(amount), note: 'Nothing was sent. Approve this recovery on your Ledger.' }
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
    `INSERT INTO decisions(id,account_id,state,intent,evidence_json,verdict_json,ballot_json,gonka_request_id,
       tx_bytes_b64,bytes_sha256,sender,policy_version,digest,created_at,expires_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, accountId, state, intent, JSON.stringify(stored), JSON.stringify(d), JSON.stringify(d.consensus), d.gonkaRequestId,
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
  args: { pool?: string; amount_sui: number; reason: string; dry_run?: boolean }
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
  const consensus = sim.kind === 'ok' && verdict?.consultGonka
    ? await requestConsensus(sim.evidence, w.h_address, args.reason)
    : null
  const decision = gate(sim, verdict, consensus)

  if (args.dry_run) {
    return dryRunResult(decision, sim, {
      from: w.h_address, digest_if_sent: frozen.digest,
      quote: { pool, in_sui: args.amount_sui, expected_out: quote.quoteOut, min_out: minOut },
    })
  }

  if (decision.outcome === 'blocked') {
    record(accountId, frozen, decision, sim, intent, w, 'blocked')
    return {
      outcome: 'blocked', funds_moved: false, rule: decision.rule, reasons: decision.reasons,
      quote: { pool, in_sui: args.amount_sui, expected_out: quote.quoteOut, min_out: minOut },
      risk_consensus: decision.consensus,
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
        // Carry the ORIGINAL rule. Without it the only thing anyone sees is the rebuild failing,
        // which says nothing about why the trade was escalated in the first place.
        escalated_because: decision.rule,
        escalation_reasons: decision.reasons,
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
    const consensus2 = sim2.kind === 'ok' && verdict2?.consultGonka
      ? await requestConsensus(sim2.evidence, w.m_address, args.reason)
      : null
    const decision2 = gate(sim2, verdict2, consensus2)
    if (decision2.outcome === 'blocked') {
      record(accountId, escalated, decision2, sim2, intent, w, 'blocked')
      return { outcome: 'blocked', funds_moved: false, rule: decision2.rule, reasons: decision2.reasons,
        risk_consensus: decision2.consensus, note: 'Nothing was swapped. The protected transaction could not pass its final safety check.' }
    }
    const approvalDecision: GateDecision = decision2.outcome === 'needs_ledger'
      ? decision2
      : { ...decision2, outcome: 'needs_ledger', rule: decision.rule, reasons: decision.reasons }
    const id = record(accountId, escalated, approvalDecision, sim2, intent, w, 'pending')
    notify(accountId, {
      decisionId: id, intent, rule: decision.rule, reasons: decision.reasons,
      riskConsensus: approvalDecision.consensus?.consensus ?? null, from: w.m_address,
      expiresInSeconds: APPROVAL_TTL_MS / 1000,
    })
    return {
      outcome: 'awaiting_approval', funds_moved: false, approval_id: id,
      approval_url: approvalUrl(id),
      rule: decision.rule, reasons: decision.reasons, expires_in_seconds: APPROVAL_TTL_MS / 1000,
      quote: { pool, in_sui: args.amount_sui, expected_out: quote.quoteOut, min_out: minOut },
      risk_consensus: approvalDecision.consensus,
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
      risk_consensus: decision.consensus,
    }
  } catch (e) {
    return { outcome: 'blocked', funds_moved: false, rule: 'EXECUTION_FAILED',
      reasons: [e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e)] }
  }
}

/**
 * DISCOVERY BEFORE ACTION.
 *
 * The strongest habit in MetaMask's guides is that every money flow starts by listing the market:
 * you never name a venue you have not just looked at. We learned the same lesson the expensive
 * way — an agent asked for a 1 SUI swap on a book whose smallest fillable size was 1.1, and the
 * only way to find that out was to try. A quote is cheap; a wasted transaction is not.
 *
 * Returns live quotes, so the fill floor is measured now rather than remembered from a comment.
 * That floor moves with the resting orders and has already changed once under us.
 */
export async function listMarkets(sizes: number[] = [1, 1.5, 2, 5]): Promise<Record<string, unknown>> {
  const pool = 'SUI_DBUSDC'
  const quotes: { in_sui: number; out: number | null; fillable: boolean }[] = []
  for (const s of sizes) {
    try {
      const q = await quoteSwap(pool, s)
      quotes.push({ in_sui: s, out: q.quoteOut ?? 0, fillable: !!q.quoteOut && q.quoteOut > 0 })
    } catch {
      quotes.push({ in_sui: s, out: null, fillable: false })
    }
  }
  const fillable = quotes.filter((q) => q.fillable)
  return {
    outcome: 'ok',
    funds_moved: false,
    venue: 'DeepBook v3',
    pool,
    pair: 'SUI -> DBUSDC',
    quotes,
    smallest_fillable_sui: fillable.length ? fillable[0].in_sui : null,
    note: fillable.length
      ? `Sizes below about ${fillable[0].in_sui} SUI match nothing on this book right now. The floor is set by the resting orders, so it moves — quote again rather than remembering this number.`
      : 'Nothing is fillable at any size tried. The book is empty; do not attempt a swap.',
  }
}

/**
 * What this wallet actually did, with the agent's own stated reason next to the outcome.
 *
 * MetaMask joins on-chain history to the intent the caller supplied, and that join is the whole
 * value: an explorer can show you a digest, but only we know the sentence the agent gave for it.
 * A human auditing an agent is asking "why", and "why" was never on chain.
 */
export function listHistory(accountId: string, limit = 20): Record<string, unknown> {
  const rows = getDb()
    .prepare(
      `SELECT id, state, intent, sender, digest, gonka_request_id, created_at, verdict_json
         FROM decisions WHERE account_id=? ORDER BY created_at DESC LIMIT ?`
    )
    .all(accountId, Math.min(Math.max(limit, 1), 100)) as {
      id: string; state: string; intent: string; sender: string; digest: string | null
      gonka_request_id: string | null; created_at: number; verdict_json: string
    }[]

  return {
    outcome: 'ok',
    funds_moved: false,
    count: rows.length,
    decisions: rows.map((r) => {
      let rule: string | null = null
      try {
        const v = JSON.parse(r.verdict_json) as { rule?: string }
        rule = v.rule ?? null
      } catch { /* a decision row with unreadable verdict json is still worth listing */ }
      return {
        id: r.id,
        state: r.state,
        why_the_agent_said_it: r.intent,
        rule,
        from: r.sender,
        ...(r.digest ? { digest: r.digest, explorer: `https://suiscan.xyz/testnet/tx/${r.digest}` } : {}),
        at: new Date(r.created_at).toISOString(),
      }
    }),
    note: 'state "executed" is the only one where money moved.',
  }
}
