# Every flow, as curl

**Or just paste this at your agent:**

> Set up my Puffer wallet: onboard me, print the setup link, and tell me what to do next.

It stops there by design — the agent cannot connect your Ledger or choose your limits. The rest of
this page is what it runs on your behalf, and what you run yourself.

---

For hermes, Codex or Claude Code. Two credentials, and they never mix:

| | Who holds it | Sent as | Can |
|---|---|---|---|
| `$BEARER` | the **agent** | `Authorization: Bearer …` | spend, simulate, poll |
| `$TOKEN` | the **human**, in a browser | `Cookie: hw_session=…` | set limits, approve, decline |

The bearer is rejected by every setup and approval route on purpose. An agent that could raise its
own limit or clear its own alert is not gated by anything.

```bash
BASE=http://localhost:3001          # or your deployed origin
BEARER=hw_live_…                    # from step 1
TOKEN=st_…                          # the part after #s= in setup_url
```

---

## 1 · Set up an account

**Create it.** One call, and the agent has everything it needs.

```bash
curl -sX POST $BASE/api/onboard \
  -H 'content-type: application/json' \
  -d '{"agent":"hermes","pass":"'"$ONBOARD_PASS"'"}'
```

Returns `bearer`, `setup_url`, and `config_yaml` ready to paste under `mcp_servers:`.
**Print `setup_url` to the human and stop.** No wallet exists yet — H and M are multisig committees
and neither can be derived until the Ledger's public key arrives, which needs a browser.

**Link the Ledger** — the one step that cannot be curl, because reading the device needs WebHID.
The human opens `setup_url` in desktop Chrome and presses Connect Ledger. What that page POSTs:

```bash
curl -sX POST $BASE/api/setup/ledger \
  -H "Cookie: hw_session=$TOKEN" -H 'content-type: application/json' \
  -d '{"suiPublicKey":"AB…","deviceAddress":"0x5508…985e","derivationPath":"m/44'\''/784'\''/0'\''/0'\''/0'\''"}'
```

→ `spending_address` (H, 1-of-2) and `protected_address` (M, 2-of-2).

**Set the guardrails.** These are the limits the agent is bound by; only the human can write them.

```bash
curl -sX POST $BASE/api/setup/policy \
  -H "Cookie: hw_session=$TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"reef","allowedRecipients":[{"address":"0x1111…1111","label":"friend"}]}'
```

**Pick a word, not four numbers.** `reef` pays only addresses you name (2.5 SUI per transaction,
10 weekly); `open_water` pays anyone (10 / 50) and leans on simulation and the risk model instead.
Both simulate everything and both escalate a high score. Explicit `perTxSui` / `weeklySui` still
override the preset if you want them. `wallet_status` returns the full table.

**Fund it.** H is the float, M backs escalations. Testnet's HTTP faucet is IP-blocked, so:

```bash
npm run fund -- $H 0.5
npm run fund -- $M 0.5
```

**Lost the bearer?** It is stored as a hash and shown once. Re-issue it from the browser session
rather than re-onboarding — a new account means a new platform key, a different committee, and
therefore different H and M addresses with your funds stranded at the old ones:

```bash
curl -sX POST $BASE/api/setup/bearer -H "Cookie: hw_session=$TOKEN"
```

This rotates: the old bearer stops working immediately, which is also how you revoke a leaked one.

**Get told when something is waiting.** Point the wallet at any URL that accepts a JSON POST —
Slack, Discord, ntfy, your own script. Only settable from a browser session, because an agent that
could redirect its own alerts would be choosing who watches it.

```bash
curl -sX POST $BASE/api/setup/policy -H "Cookie: hw_session=$TOKEN" \
  -H 'content-type: application/json' -d '{"notifyUrl":"https://hooks.slack.com/…"}'
```

The message carries a **decline** link that works from any device with no session, and no approve
link — approving needs the Ledger, so it needs a desktop browser. That asymmetry is deliberate: the
worst a stolen notification can do is refuse a payment that was already being questioned.

**Read the state** — human view (`Cookie`) or agent view (`Bearer`, via `wallet_status`):

```bash
curl -s $BASE/api/setup/state -H "Cookie: hw_session=$TOKEN"
```

---

## 2 · Simulate a transaction

`/api/check` builds the real transaction, simulates it on testnet, scores it with Gonka and runs
the gate — then throws it all away. **No decision row, no spend debit, no pending approval.** Call
it as often as you like. This is what to use when you want to know whether something *would* be
allowed; `wallet_transfer` and `wallet_swap` are the ones that commit.

**A payment:**

```bash
curl -sX POST $BASE/api/check \
  -H "Authorization: Bearer $BEARER" -H 'content-type: application/json' \
  -d '{"to":"0x1111…1111","amount_sui":0.002,"reason":"paying a friend back"}'
```

**A drain** — same endpoint, and still nothing happens:

```bash
curl -sX POST $BASE/api/check \
  -H "Authorization: Bearer $BEARER" -H 'content-type: application/json' \
  -d '{"to":"0xbadb…bad0","amount_sui":"all","reason":"claim your free airdrop"}'
```

**A DeepBook trade** — quoted first, so an unfillable size is refused before it costs gas:

```bash
curl -sX POST $BASE/api/check \
  -H "Authorization: Bearer $BEARER" -H 'content-type: application/json' \
  -d '{"action":"swap","amount_sui":2,"pool":"SUI_DBUSDC","reason":"rebalancing into USDC"}'
```

You get back `would` (`allow` | `needs_ledger` | `blocked`), the `rule` that decided it, the
simulated `balance_changes` with each party named, the Gonka `risk_consensus` block, and
`spend_so_far_this_week_sui`. `"all"` is transfer-only — a swap needs a concrete size.

Small swaps return nothing: the book fills only above a floor set by the resting orders (recently
~1.1 SUI), and that floor moves. Quote rather than assume — `/api/check` does it for you.

**Read the field `would`, not the HTTP status.** A blocked transaction is a successful 200.

---

## 3 · The risk model

Gonka verifiers score the *simulated* bundle, never the agent's words about it, and can only
escalate — deterministic rules are a floor they cannot argue under. Puffer sends two concurrent
requests to MiniMax-M2.7 and one to DeepSeek-V4-Flash, and requires low-risk responses from both
distinct models to allow a routine payment. Any higher vote, disagreement, or fewer than two
distinct valid votes requires the Ledger.

**Health probe / warmer.** Scores one of two fixed sample bundles. There is no way to send it your
own prompt — that is the whole design; the old open-proxy route was deleted.

```bash
curl -s $BASE/api/risk -H "Authorization: Bearer $BEARER"              # benign  → expects low
curl -s "$BASE/api/risk?case=drain" -H "Authorization: Bearer $BEARER" # drain   → expects high
```

`as_expected: false` means the health-probe model has drifted. Run the benign one at session start:
the first call is the slow one, and a cold model answering in 31s against a 30s budget abstains,
escalating a payment that was never risky.

Live, just now — `benign` 10/low in 3.5s, `drain` 85/high in 15.5s, and it named the social
engineering: *"The 'claim free airdrop' text is a social engineering trick with no actual reward."*

**Consensus receipts on real transactions** come back inside `/api/check` as
`risk_consensus.votes`. Each winning vote includes its score, band, reasons, `requestId`, and
`devshardId`; there is intentionally no combined score. `X-Request-Id` can be looked up through
Gonka's receipt endpoint to confirm the gateway served that inference.

---

## 4 · Actually move money

MCP over HTTP. Five tools, one JSON-RPC envelope, `id` is yours to pick.

```bash
mcp() {  # mcp <tool> <json-args>
  curl -sX POST $BASE/api/mcp \
    -H "Authorization: Bearer $BEARER" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",
         \"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}

mcp tools/list '{}'   # or: -d '{"jsonrpc":"2.0","id":0,"method":"tools/list"}'
mcp wallet_status  '{}'
mcp wallet_transfer '{"to":"0x1111…1111","amount_sui":0.002,"reason":"paying a friend back"}'
mcp wallet_swap     '{"amount_sui":2,"pool":"SUI_DBUSDC","reason":"rebalancing into USDC"}'
mcp wallet_approval_status '{"approval_id":"…","wait_ms":25000}'
mcp wallet_explain_last '{}'
```

Every result carries **`funds_moved`**, on errors too, and the text block opens and closes with
`SENT.` or `NOT SENT.`. A `digest` is *absent* rather than null unless money actually moved, so
there is nothing digest-shaped to hallucinate a link from.

`outcome: "awaiting_approval"` means **nothing was sent** and a human is holding it. Poll
`wallet_approval_status`; terminal states are `executed`, `denied`, `expired`. Approvals expire
after 30 minutes.

---

## 5 · The human decides

Bearer forbidden here. Cookie only.

```bash
curl -s $BASE/api/approve/$APPROVAL_ID -H "Cookie: hw_session=$TOKEN"     # read the card
curl -sX POST $BASE/api/approve/$APPROVAL_ID \
  -H "Cookie: hw_session=$TOKEN" -H 'content-type: application/json' \
  -d '{"action":"decline"}'                                              # decline: no device needed
```

**Approving needs the Ledger**, so it happens in Chrome at `$BASE/test` — the browser reads
`tx_bytes_b64`, has the device sign it, and POSTs `{"ledgerSignature":"…"}` back. That signature is
the second of two: the escalated transaction is rebuilt from **M**, the 2-of-2 our server cannot
satisfy alone. The bytes are re-hashed and re-simulated before the device is touched, and a policy
change since the request voids it.

---

## The whole thing in one command

```bash
PORT=3001 bash scripts/flow.sh              # prints every curl before running it
PORT=3001 SIGN=fake bash scripts/flow.sh    # also plays the Ledger, unattended
```
