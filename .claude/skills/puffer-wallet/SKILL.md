---
name: puffer-wallet
description: Use when the user asks to set up, fund, configure or spend from the Puffer agent wallet on Sui — sending SUI, trading on DeepBook, checking guardrails, or resolving a transaction that is waiting for their Ledger.
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
