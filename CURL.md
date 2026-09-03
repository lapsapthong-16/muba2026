# Every flow, as curl

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
  -d '{"perTxSui":0.005,"weeklySui":5,
       "allowedRecipients":[{"address":"0x1111…1111","label":"friend"}]}'
```

**Fund it.** H is the float, M backs escalations. Testnet's HTTP faucet is IP-blocked, so:

```bash
npm run fund -- $H 0.5
npm run fund -- $M 0.5
```

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
simulated `balance_changes` with each party named, the Gonka `risk` block, and
`spend_so_far_this_week_sui`. `"all"` is transfer-only — a swap needs a concrete size.

**Read the field `would`, not the HTTP status.** A blocked transaction is a successful 200.

---

## 3 · The risk model

Gonka scores the *simulated* bundle, never the agent's words about it, and it can only escalate —
the deterministic rules are a floor it cannot argue under. An abstention (timeout, HTTP error,
substituted model, unparseable reply) escalates too. **It never passes anything on its own.**

**Health probe / warmer.** Scores one of two fixed sample bundles. There is no way to send it your
own prompt — that is the whole design; the old open-proxy route was deleted.

```bash
curl -s $BASE/api/risk -H "Authorization: Bearer $BEARER"              # benign  → expects low
curl -s "$BASE/api/risk?case=drain" -H "Authorization: Bearer $BEARER" # drain   → expects high
```

`as_expected: false` means the model has drifted. `reachable: false` means it is down and every
transaction will escalate to the Ledger until it returns. Run the benign one at session start:
the first call is the slow one, and a cold model answering in 31s against a 30s budget abstains,
escalating a payment that was never risky.

Live, just now — `benign` 10/low in 3.5s, `drain` 85/high in 15.5s, and it named the social
engineering: *"The 'claim free airdrop' text is a social engineering trick with no actual reward."*

**Scores on real transactions** come back inside `/api/check` (`risk.score`, `risk.band`,
`risk.reasons`, `risk.gonka_request_id`) and after the fact from `wallet_explain_last`. Bands are
ours and published: `<34` low, `<67` medium, else high — read the score, apply two numbers, get the
same answer the gate did.

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
