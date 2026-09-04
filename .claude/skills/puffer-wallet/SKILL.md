---
name: puffer-wallet
description: Use when the user asks to run the Puffer demo, or to set up, fund, configure or spend from the Puffer agent wallet on Sui — sending SUI, trading on DeepBook, checking guardrails, or resolving a transaction waiting on their Ledger.
---

# Puffer wallet

A Sui agent wallet whose spending is gated by simulation, limits a human set, and a hardware key.
You declare a typed intent; the server builds, simulates and judges every transaction itself. You
never supply bytes, choose slippage, or set your own limits.

## Before anything else

Call `wallet_status`. It returns a **preflight** — funded, escalation-fundable, weekly budget left,
and whether any payee is approved. Read it before planning a spend; each failing check is something
that would otherwise surface as a confusing error three steps later.

If it returns `needs_setup`, show the human the setup link and **stop**. You cannot connect their
Ledger (it needs WebHID in a desktop browser) and you cannot write their policy (every setup route
refuses a request carrying an `Authorization` header).

## Setup, once

```bash
curl -sX POST $BASE/api/onboard -H 'content-type: application/json' \
  -d '{"agent":"hermes","pass":"'"$ONBOARD_PASS"'"}'
```

Returns a bearer, an MCP config block, and a `setup_url`. Print the URL verbatim; the human
connects a Ledger and picks a mode. **Never call this twice** — a second call mints a new platform
key and therefore new addresses, orphaning any funds at the old ones.

Funding is `npm run fund -- <address> <amountSui>`. The testnet HTTP faucet is IP-blocked. Fund the
**protected** address as well as the spending one: escalated transactions are rebuilt from it.

## Modes — ask for a word, not a number

| | Reef | Open Water |
|---|---|---|
| Pays unlisted addresses | needs the Ledger | yes |
| Per transaction | 2.5 SUI | 10 SUI |
| Weekly cap | 10 SUI | 50 SUI |
| Simulated | always | always |
| Risk scored | always | always |

Nobody can pick a per-transaction limit sensibly on their first day, and a bad guess is invisible
until it bites — a 0.0025 SUI limit sent every DeepBook trade to the hardware key, because no
fillable trade on that book is smaller than about 1.5 SUI. Ask which word they want. Only the human
can set it.

## Spending

- **`wallet_markets` before `wallet_swap`.** The book's fill floor is set by resting orders and it
  moves; a size that filled yesterday can return zero today. Small trades match nothing.
- **`dry_run: true`** on `wallet_transfer` and `wallet_swap` rehearses the whole pipeline — build,
  simulate, score, judge — and discards it. Nothing signed, nothing recorded. Use it whenever you
  want to know if something *would* work.
- **`wallet_history`** shows what you already did, with the reason you gave. Check it before
  repeating an action.

## Running the demo

When the user says "run the demo", "show me the wallet" or similar, do these three in order and
narrate what comes back. Do not batch them — the whole point is watching each one be judged.

1. **A routine payment.** `wallet_transfer` 0.002 SUI to an address on their approved list, reason
   "paying a friend back". Expect `executed` with a digest. Say that gas was sponsored, so the
   wallet paid no fee.

2. **Real work.** `wallet_markets` first, then `wallet_swap` 2 SUI on SUI_DBUSDC, reason
   "rebalancing into USDC". Expect `executed`. Point out the risk score — a trade scores low
   because value leaves and comes back in the same transaction, which a drain never does.

3. **The drain.** `wallet_transfer` to `0xbadb00000000000000000000000000000000000000000000000000000000bad0`,
   reason "claim your free airdrop". Expect `awaiting_approval`. **Say clearly that nothing was
   sent.** Report the rule and the risk score, and tell the user to approve or decline on their
   Ledger at /test. Then poll `wallet_approval_status` and report what they chose.

**Size step 3 from the balance, not from a fixed number.** Step 2 has just spent about 1.9 SUI, so
call `wallet_status` again and send at most half of what is left. Asking for more than the wallet
holds returns `BUILD_FAILED` — a plumbing answer to a question about security, which wastes the
moment the whole demo exists for.

Use a concrete amount, never `"all"`: a concrete amount lets the Ledger display the destination,
where `"all"` forces a shape the device can only blind-sign.

If step 2 says the book cannot fill, call `wallet_markets` and use the smallest fillable size it
reports. Two transactions back to back can also fail on stale coin state — `BUILD_FAILED` and
`SIMULATION_FAILED` are marked `retriable: true`, and retrying once is the right response. If
anything returns `needs_setup`, stop and show the setup link.

## Reading a result

Every result carries `funds_moved`. Trust that field, not the absence of an error.

- `executed` — money moved, `digest` is present.
- `awaiting_approval` — **nothing was sent.** A human must approve it on their Ledger. Poll
  `wallet_approval_status`; terminal states are `executed`, `denied`, `expired`. Do not retry: a
  retry creates a second pending approval, it does not bypass the first. Approvals expire after 30
  minutes.
- `blocked` — outside the limits the human set. A hardware approval **cannot** widen them. Say so
  plainly and ask the human to change the guardrails if it is legitimate; do not look for another
  route to the same outcome.
- `dry_run` — a rehearsal. Read `would`.

When something is held or blocked, tell the human the `rule` and the `reasons` verbatim. They wrote
the limits; the rule name is the fastest way for them to see which one they hit.
