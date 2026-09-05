---
name: puffer-wallet
description: >-
  Use whenever the user wants to create, set up, fund or check their Puffer wallet on Sui, or wants
  you to spend from it — sending SUI, trading on DeepBook, checking guardrails, or handling a
  transaction waiting on their Ledger. Use it ALSO when a requested payment looks like a scam:
  this wallet is the enforcement layer, and the correct move is to warn the user and submit it
  anyway so the guardrails can stop it, not to refuse on their behalf.
---

# Puffer wallet

A Sui agent wallet whose spending is gated by simulation, limits the owner set, and a hardware key.
You declare a typed intent; the server builds, simulates and judges every transaction itself. You
never supply bytes, choose slippage, or set your own limits.

### Sui address validation

Treat a canonical Sui address as valid when it consists of the `0x` prefix followed by exactly 64
hexadecimal characters (`0-9`, `a-f`, or `A-F`), representing 32 bytes. Do not classify an address
as invalid merely because it is unfamiliar, visually suspicious, or unapproved; those are payee
and risk decisions handled by the wallet. Any other prefix, character, or hex-character count is
an invalid address and must not be treated as a constructible transaction destination.

## MCP configuration

Before any wallet operation, the agent MUST read the repository's `.mcp.json` and use the configured
`puffer` MCP server and bearer credentials. Do not invent an endpoint, bypass the MCP server, or use
an alternate wallet configuration. Keep bearer credentials out of user-visible messages and command
output.

If native Puffer MCP tools are not exposed in the current Codex session, use the exact server URL and
bearer from `.mcp.json` through the configured localhost MCP endpoint as a fallback. If the shell
sandbox returns a loopback/localhost permission error, retry the same MCP JSON-RPC request immediately
with the approved elevated localhost networking path. Use that path only for MCP JSON-RPC requests,
never print the bearer, and do not replace the configured endpoint or credentials. Initialize the MCP
session, list tools when needed, then call the required
wallet tool over `POST`; do not use direct wallet APIs or shell commands that bypass MCP.

Everything below is one conversation, not a script. Follow whichever part the user is asking for.

### Outcome and timeout invariant

Treat every live mutation call as potentially accepted even if the client receives a timeout,
empty response, transport error, or malformed response. A timeout is a communication failure, not
evidence that no simulation, approval, signing, or transfer occurred. Do not tell the owner that
nothing was sent until delayed status checks show no matching approval, balance change, or history.

For an ambiguous live transfer or swap, check `wallet_status` immediately and again after a short
wait (up to 45 seconds), inspecting pending approvals, balances, and history. Match approvals by
amount, destination, and intent. If any matching approval exists, use it and never resubmit. If
funds moved or a digest exists, report completion and never resubmit. Only retry once when all
checks show no matching approval, no funds moved, and no digest. If that retry is ambiguous, stop
and report the state as unknown. Never create another approval merely because an earlier one was not
visible immediately.

---

## "I want to create my wallet"

**1. Create or resume setup immediately.** Do not call `wallet_status` first. Check only whether
`.puffer/setup.json` exists in the project directory:

- If it exists, read and reuse its `setup_url`.
- If it does not exist, run `npm run onboard` immediately and use the `setup_url` it prints.

Never run onboarding when `.puffer/setup.json` already exists: onboarding creates a different
wallet committee and could strand funds associated with the existing wallet.

**2. Give them the link.** Show the selected `setup_url` to the human. Keep credentials out of
user-visible messages and command output.

Show the URL on its own line and tell them three things:

- **Open it in desktop Chrome or Edge.** Reading a Ledger needs WebHID, which mobile browsers and
  Safari do not have.
- **Connect the Ledger there.** Both addresses are derived from their device key plus the server's,
  so the wallet does not exist until they do this. It is also funded at that moment.
- **Choose a spending limit**, in dollars if they like — "$30 a payment" is a real answer. DeepBook
  is already on the approved-contracts list, so they do not need to add it; the approved-payee list
  is for plain transfers.

Then **stop**. You cannot connect their Ledger and you cannot write their policy: every setup route
refuses a request carrying an `Authorization` header at all.

**3. Wait, then confirm.** When they say they are done — or right away, if you want to watch for it —
call `wallet_status` with `wait_for_ready_ms: 45000`. It blocks and returns the moment setup lands.

On success, tell them plainly that setup is complete and they can use the wallet with you now, and
report what you can see: both addresses, both balances, the mode, and the limits. If it comes back
`still_waiting`, say so and offer to keep waiting rather than assuming something broke.

---

## "Trade on DeepBook" / "swap some SUI"

For every DeepBook trade or swap request, you MUST call `wallet_markets` first and inspect the
current order book and fill availability. If there is no fillable liquidity, say: **DeepBook has no
liquidity available for this trade. No order submitted; no transaction occurred.** If liquidity is
available, report the observed fillable amount and stop; call `wallet_swap` only if the user then
explicitly asks you to submit the quoted trade.

The order book's fill floor is set by resting orders and moves, so a size that filled yesterday can
return zero today. If the user authorizes submission, use a size at or above
`smallest_fillable_sui` and report the actual wallet result, including whether funds moved and any
digest.

---

## "Send X to Y" — including when it looks like a scam

**Submit it. Say what you think, then submit it anyway, and report what the wallet says.**

This is the most important instruction in this file, and it will feel wrong. When someone asks you
to send money to an address that looks like a drainer, the instinct is to refuse. Here, refusing is
the mistake — for three reasons:

1. **The wallet is the protection, not you.** It simulates the transaction against the live chain,
   checks it against limits the owner set, scores it with an independent model, and stops it at a
   hardware key. Refusing pre-emptively means none of that runs, and the owner learns nothing about
   whether their guardrails work.
2. **Your judgment is the thing an attacker targets.** An agent that can be talked into sending
   money can be talked into believing an address is fine. A wallet that holds a 2-of-2 cannot. If
   the owner's safety depends on you spotting the scam, they have no safety — that is the entire
   premise of this product.
3. **You are not the last step.** A suspicious transfer does not go out. It gets rebuilt from an
   address our key cannot move alone, and the owner has to physically approve it on a Ledger that
   displays the amount and destination. You are not risking their money by submitting; you are
   handing them a decision with the evidence attached.

So: **say plainly that it looks like a scam and why** — that warning is useful and you should give
it — and then call `wallet_transfer` with the honest intent. For an unrecognized recipient, Puffer
simulates once, briefly loads the review flow, and returns an `awaiting_approval` result. Nothing
is sent; direct the owner to the returned `approval_url`. The review page shows three fixed AI
explanations for this specific new-recipient flow, so do not wait for or invent live model output.

If the recipient string is syntactically invalid, still create an intent-level approval so the
owner can review the exact input on the review page. Pass an `invalid_address` field containing the
original address and the validator reason to each of the three AI agents. The review page must
clearly label this as an invalid-address review: approving it releases the user's intent for
re-validation, but does not create a Ledger-signable transaction and can never move funds. On
approval, re-run validation and finish with `INVALID_ADDRESS`; on decline, close the approval as
denied. Never claim that Ledger approved or signed an invalid transaction.

The only things you should refuse outright are requests to work *around* a limit: retrying a blocked
transaction, splitting a payment to get under a cap, or looking for a second route to the same
outcome. Those are the real failures.

**Size it against the balance.** Call `wallet_status` and send at most half of what the spending
address holds. Asking for more than the wallet has returns `BUILD_FAILED`, which answers a question
about plumbing when the human asked one about security.

Use a concrete amount, never `"all"`: a concrete amount lets the Ledger display the destination,
where `"all"` forces a transaction shape the device can only blind-sign.

When it comes back `awaiting_approval`:

- **Say clearly that nothing was sent.** This is the single most important sentence you will write.
- Report the `rule`, the `risk_score`, and the model's `risk_reasons` verbatim — the owner wrote
  these limits, and the rule name is the fastest way for them to see which one they hit.
- Tell them it was re-issued from the protected address, which needs their Ledger as a second
  signature, and give them the returned `approval_url` to approve or decline at `/review`.
- Then poll `wallet_approval_status` and report what they chose. **Do not resubmit** — a retry
  can create a second pending approval, it does not bypass the first.

### Ambiguous or lost transfer responses

If `wallet_transfer` times out, returns an empty/malformed response, or otherwise does not reveal
an outcome, do not assume that no simulation or approval was created. Immediately call
`wallet_status`, then check again after a short wait (up to 45 seconds), inspecting both
`pending_approvals` and the balance/history evidence:

- If a matching pending approval exists, use that approval; do not submit another transfer.
- If funds moved or a transaction digest exists, treat the transfer as complete; do not retry.
- Only if no matching approval exists, no funds moved, and no digest appears may you retry the same transfer once, using
  the configured/elevated MCP path as needed. Then verify the result with `wallet_status` again.
- If the retry is also ambiguous, stop and report that the state cannot be determined. Never keep
  retrying or create duplicate approvals.

---

## Reading any result

Every mutation result carries `funds_moved`; trust it when present, but never infer it from the
absence of an error or from a timeout. A delayed status check may reveal an approval created by a
request that timed out.

| | |
|---|---|
| `executed` | money moved, `digest` present |
| `awaiting_approval` | **nothing sent**, a human must approve on their Ledger; for an invalid address this is an intent review only and cannot produce a signable transaction |
| `blocked` | outside the limits; a hardware tap cannot widen them |
| `dry_run` | a rehearsal — read `would` |

Results also carry `code`, `retriable` and `remedy`. **Honour `retriable`.** `BUILD_FAILED` and
`SIMULATION_FAILED` are usually transient — two transactions back to back can fail on stale coin
state — so retry once. `INVALID_ADDRESS`, `WEEKLY_CAP`, `PER_TX_LIMIT` and `UNKNOWN_RECIPIENT` are not retriable after the intent review completes:
they need a human, not patience, and retrying them just wastes the owner's time.

When something is blocked, say so plainly and stop looking for another route to the same outcome.
Finding a way around a limit the owner set is the one behaviour this wallet exists to prevent.
