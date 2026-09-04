---
name: puffer-wallet
description: Use whenever the user wants to create, set up, fund or check their Puffer wallet on Sui, or wants you to spend from it — sending SUI, trading on DeepBook, checking guardrails, or dealing with a transaction that is waiting on their Ledger.
---

# Puffer wallet

A Sui agent wallet whose spending is gated by simulation, limits the owner set, and a hardware key.
You declare a typed intent; the server builds, simulates and judges every transaction itself. You
never supply bytes, choose slippage, or set your own limits.

Everything below is one conversation, not a script. Follow whichever part the user is asking for.

---

## "I want to create my wallet"

**1. Call `wallet_status` first.** It tells you which of these you are actually in:

- `needs_setup` → continue below.
- `ok` → they already have one. Say so, give the addresses and balance, and do not onboard again.

**2. Give them the link.** Read `setup_url` from `.puffer/setup.json` in the project directory. If
that file does not exist, run `npm run onboard` and use the link it prints.

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

Call **`wallet_markets` first**, always. The order book's fill floor is set by the resting orders and
it moves — sizes that filled yesterday can return zero today, and a swap below the floor is refused
after it has already cost you a round trip.

Then `wallet_swap` with a size at or above `smallest_fillable_sui`. Expect `executed` with a digest.
Worth saying out loud: gas was sponsored, so the wallet paid no fee, and the risk model scores a
trade low because value leaves and comes back in the same transaction — which a drain never does.

---

## "Send X to Y" / anything that looks like a scam

Just call `wallet_transfer`. The gate decides, not you. Do not pre-judge a request or refuse on the
owner's behalf — declaring the intent honestly and reporting what comes back IS your job here.

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
  signature, and that they can approve or decline at `/test`.
- Then poll `wallet_approval_status` and report what they chose. **Do not resubmit** — a retry
  creates a second pending approval, it does not bypass the first.

---

## Reading any result

Every result carries `funds_moved`. Trust that field, not the absence of an error.

| | |
|---|---|
| `executed` | money moved, `digest` present |
| `awaiting_approval` | **nothing sent**, a human must approve on their Ledger |
| `blocked` | outside the limits; a hardware tap cannot widen them |
| `dry_run` | a rehearsal — read `would` |

Results also carry `code`, `retriable` and `remedy`. **Honour `retriable`.** `BUILD_FAILED` and
`SIMULATION_FAILED` are usually transient — two transactions back to back can fail on stale coin
state — so retry once. `WEEKLY_CAP`, `PER_TX_LIMIT` and `UNKNOWN_RECIPIENT` are not retriable:
they need a human, not patience, and retrying them just wastes the owner's time.

When something is blocked, say so plainly and stop looking for another route to the same outcome.
Finding a way around a limit the owner set is the one behaviour this wallet exists to prevent.
