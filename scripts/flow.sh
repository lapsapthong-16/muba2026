#!/usr/bin/env bash
# The whole wallet flow, as curl. Every step prints the command before running it, so you can
# lift any single line straight into hermes.
#
#   bash scripts/flow.sh                 # against http://localhost:3000
#   PORT=3001 bash scripts/flow.sh
#   PORT=3001 SIGN=fake bash scripts/flow.sh    # also plays the Ledger, for unattended runs
#
# The one step that CANNOT be a curl is reading the public key off your Ledger — that needs
# WebHID in a browser. Everything downstream of it, including enrolment itself, is plain HTTP.
set -euo pipefail
B="${BASE_URL:-http://localhost:${PORT:-3000}}"
PASS="${ONBOARD_PASS:-demo}"
ATTACKER=0xbadb00000000000000000000000000000000000000000000000000000000bad0
FRIEND=0x1111111111111111111111111111111111111111111111111111111111111111

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
run()  { printf '\033[2m$ %s\033[0m\n' "$1"; eval "$1"; }
jq_()  { python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d,indent=1)[:$1])"; }

step "1 · CREATE ACCOUNT — the agent's first call. Returns a bearer and a setup link."
run "curl -sX POST $B/api/onboard -H 'content-type: application/json' -d '{\"agent\":\"hermes\",\"pass\":\"$PASS\"}' -o /tmp/onboard.json"
BEARER=$(python3 -c "import json;print(json.load(open('/tmp/onboard.json'))['bearer'])")
SETUP=$(python3 -c "import json;print(json.load(open('/tmp/onboard.json'))['setup_url'])")
TOKEN="${SETUP##*#s=}"
echo "   bearer    : ${BEARER:0:22}…"
echo "   setup url : $SETUP"

step "2 · LINK LEDGER — the ONLY browser step. Reading the device needs WebHID."
echo "   Open the setup URL above in desktop Chrome and press Connect Ledger."
if [ "${SIGN:-}" = "fake" ]; then
  echo "   SIGN=fake: standing in for the device with a throwaway key."
  npx tsx -e "
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { writeFileSync } from 'node:fs'
const k = Ed25519Keypair.generate(); writeFileSync('/tmp/fakeledger.key', k.getSecretKey())
const p = k.getPublicKey()
writeFileSync('/tmp/enrol.json', JSON.stringify({suiPublicKey:p.toSuiPublicKey(),deviceAddress:p.toSuiAddress(),derivationPath:\"m/44'/784'/0'/0'/0'\"}))" >/dev/null 2>&1
  run "curl -sX POST $B/api/setup/ledger -H 'Cookie: hw_session=$TOKEN' -H 'content-type: application/json' -d @/tmp/enrol.json -o /tmp/enrol-res.json"
  H=$(python3 -c "import json;print(json.load(open('/tmp/enrol-res.json'))['spending_address'])")
  M=$(python3 -c "import json;print(json.load(open('/tmp/enrol-res.json'))['protected_address'])")
else
  read -rp "   Press enter once your Ledger is linked… "
  run "curl -s $B/api/setup/state -H 'Cookie: hw_session=$TOKEN' -o /tmp/state.json"
  H=$(python3 -c "import json;print(json.load(open('/tmp/state.json'))['spending_address'] or '')")
  M=$(python3 -c "import json;print(json.load(open('/tmp/state.json'))['protected_address'] or '')")
  [ -n "$H" ] || { echo "   No wallet yet — link the Ledger first."; exit 1; }
fi
echo "   H (spending, 1-of-2)  $H"
echo "   M (protected, 2-of-2) $M"

step "3 · FUND both addresses — H is the float, M backs escalations."
# Funding is best-effort: a dry funder must not abort the flow, because every step after this
# still demonstrates something on an already-funded wallet.
AMT="${FUND_SUI:-0.01}"
for a in "$H" "$H" "$M" "$M"; do
  out=$(npm run fund --silent -- "$a" "$AMT" 2>&1 || true)
  echo "$out" | grep -E '^digest|Not enough' | sed 's/^/   /' || true
done
echo "   (if this said 'Not enough', top up your funder: it is the PRIVATE_KEY in .env)"

step "4 · SET GUARDRAILS — the limits that bind the agent."
run "curl -sX POST $B/api/setup/policy -H 'Cookie: hw_session=$TOKEN' -H 'content-type: application/json' -d '{\"perTxSui\":0.005,\"weeklySui\":5,\"allowedRecipients\":[{\"address\":\"$FRIEND\",\"label\":\"friend\"}]}' | $(printf %s 'python3 -c "import sys,json;print(\" policy v\"+str(json.load(sys.stdin)[\"policy_version\"]))"')"

step "5 · WALLET STATUS — what the agent sees."
run "curl -s $B/api/setup/state -H 'Cookie: hw_session=$TOKEN' | jq_ 700" || true

step "6a · GONKA HEALTH — score two fixed sample bundles. Warms the model so the first real"
echo "     transaction does not pay the cold-start latency and abstain."
run "curl -s $B/api/risk -H 'Authorization: Bearer $BEARER' | jq_ 600"
run "curl -s '$B/api/risk?case=drain' -H 'Authorization: Bearer $BEARER' | jq_ 600"

step "6 · SIMULATE ONLY — build, simulate, score with Gonka, apply the gate. Nothing is created."
run "curl -sX POST $B/api/check -H 'Authorization: Bearer $BEARER' -H 'content-type: application/json' -d '{\"to\":\"$FRIEND\",\"amount_sui\":0.002,\"reason\":\"paying a friend back\"}' | jq_ 1600"

step "7 · SIMULATE A DRAIN — same endpoint, still nothing created."
run "curl -sX POST $B/api/check -H 'Authorization: Bearer $BEARER' -H 'content-type: application/json' -d '{\"to\":\"$ATTACKER\",\"amount_sui\":\"all\",\"reason\":\"claim your free airdrop\"}' | jq_ 1600"

step "7b · SIMULATE A DEEPBOOK TRADE — the agent's real work, quoted before it is built."
run "curl -sX POST $B/api/check -H 'Authorization: Bearer $BEARER' -H 'content-type: application/json' -d '{\"action\":\"swap\",\"amount_sui\":2,\"pool\":\"SUI_DBUSDC\",\"reason\":\"rebalancing into USDC\"}' | jq_ 1600"
echo "   (needs >= 2 SUI in H: below that the book fills nothing and this returns BELOW_MARKET_MINIMUM)"

step "8 · ACTUALLY SEND a safe payment — this one commits."
run "curl -sX POST $B/api/mcp -H \"Authorization: Bearer $BEARER\" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"wallet_transfer\",\"arguments\":{\"to\":\"$FRIEND\",\"amount_sui\":0.002,\"reason\":\"paying a friend back\"}}}' | python3 -c \"import sys,json;r=json.load(sys.stdin)['result'];print(json.dumps(r.get('structuredContent',r),indent=1)[:700])\""

step "8b · ACTUALLY TRADE on DeepBook — commits, and only if the book can fill it."
run "curl -sX POST $B/api/mcp -H \"Authorization: Bearer $BEARER\" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"wallet_swap\",\"arguments\":{\"amount_sui\":2,\"pool\":\"SUI_DBUSDC\",\"reason\":\"rebalancing into USDC\"}}}' | python3 -c \"import sys,json;r=json.load(sys.stdin)['result'];print(json.dumps(r.get('structuredContent',r),indent=1)[:700])\""

step "9 · ATTEMPT A DRAIN — held for the Ledger, re-issued from the protected address."
run "curl -sX POST $B/api/mcp -H \"Authorization: Bearer $BEARER\" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"wallet_transfer\",\"arguments\":{\"to\":\"$ATTACKER\",\"amount_sui\":\"all\",\"reason\":\"claim your free airdrop\"}}}' -o /tmp/drain.json"
python3 -c "import json;d=json.load(open('/tmp/drain.json'))['result'];print(json.dumps(d.get('structuredContent',d),indent=1)[:900])"
APPROVAL=$(python3 -c "import json;d=json.load(open('/tmp/drain.json'))['result'].get('structuredContent',{});print(d.get('approval_id',''))")

if [ -n "$APPROVAL" ]; then
  step "10 · READ THE HELD DECISION — what the human is asked to approve."
  run "curl -s $B/api/approve/$APPROVAL -H 'Cookie: hw_session=$TOKEN' | jq_ 1200"

  step "11 · RESOLVE IT — decline needs no device; approve needs the Ledger's signature."
  echo "   decline:  curl -sX POST $B/api/approve/$APPROVAL -H 'Cookie: hw_session=$TOKEN' -H 'content-type: application/json' -d '{\"action\":\"decline\"}'"
  echo "   approve:  open $B/test in Chrome and press Approve on Ledger"
  if [ "${SIGN:-}" = "fake" ]; then
    echo "   SIGN=fake: signing with the stand-in key."
    npx tsx --env-file=.env -e "
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { readFileSync } from 'node:fs'
const kp = Ed25519Keypair.fromSecretKey(readFileSync('/tmp/fakeledger.key','utf8').trim())
const g = await fetch('$B/api/approve/$APPROVAL', { headers: { Cookie: 'hw_session=$TOKEN' } })
const d = await g.json()
const { signature } = await kp.signTransaction(Uint8Array.from(Buffer.from(d.tx_bytes_b64,'base64')))
const r = await fetch('$B/api/approve/$APPROVAL', { method:'POST',
  headers:{'content-type':'application/json', Cookie:'hw_session=$TOKEN'},
  body: JSON.stringify({ ledgerSignature: signature }) })
console.log('   ', JSON.stringify(await r.json()))"
  fi
fi

step "AGENT POLLS FOR THE OUTCOME"
echo "   curl -sX POST $B/api/mcp -H 'Authorization: Bearer $BEARER' \\"
echo "     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\"
echo "     -d '{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"wallet_approval_status\",\"arguments\":{\"approval_id\":\"$APPROVAL\"}}}'"
printf '\n\033[1mbearer for reuse:\033[0m %s\n\n' "$BEARER"
