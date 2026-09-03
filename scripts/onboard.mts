/**
 * Onboard an agent and print everything you need, in order.
 *
 *   npm run onboard              # against http://localhost:3000
 *   PORT=3001 npm run onboard
 *
 * This is what hermes would do on first run. It prints the setup URL for you to open,
 * and the MCP config to paste into your agent.
 */
const port = process.env.PORT ?? '3000'
const base = process.env.BASE_URL ?? `http://localhost:${port}`
const pass = process.env.ONBOARD_PASS ?? 'demo'

const res = await fetch(`${base}/api/onboard`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ agent: 'hermes', pass }),
})
if (!res.ok) {
  console.error(`Onboarding failed (${res.status}):`, (await res.text()).slice(0, 300))
  console.error(`\nIs the server running? ONBOARD_PASS=${pass} npm run dev`)
  process.exit(1)
}
const b = (await res.json()) as { bearer: string; setup_url: string; config_yaml: string; account_id: string }

console.log(`
──────────────────────────────────────────────────────────────────────
 1. OPEN THIS IN DESKTOP CHROME OR EDGE
──────────────────────────────────────────────────────────────────────
${b.setup_url}

   Connect your Ledger there. Your wallet does not exist until you do —
   both addresses are derived from your device's key plus ours.

──────────────────────────────────────────────────────────────────────
 2. FUND BOTH ADDRESSES (the page shows them after you connect)
──────────────────────────────────────────────────────────────────────
   npm run fund -- <spending address>  0.05     # twice
   npm run fund -- <protected address> 0.05     # twice

   H (spending, 1-of-2)  the float your agent spends unattended
   M (protected, 2-of-2) where escalated payments come from — needs
                         your Ledger as a second signature

──────────────────────────────────────────────────────────────────────
 3. SET GUARDRAILS at ${base}/guardrails
──────────────────────────────────────────────────────────────────────
   Keep the weekly cap ABOVE your balance, or a large payment hits the
   hard cap and is blocked outright instead of escalating to your device.

──────────────────────────────────────────────────────────────────────
 4. AGENT CONFIG  (~/.hermes/config.yaml)
──────────────────────────────────────────────────────────────────────
${b.config_yaml}
──────────────────────────────────────────────────────────────────────
 5. OR DRIVE IT BY HAND
──────────────────────────────────────────────────────────────────────
   export B=${base} T='${b.bearer}'

   # status
   curl -s -X POST $B/api/mcp -H "Authorization: Bearer $T" \\
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wallet_status","arguments":{}}}'

   # a payment over your limit -> should hold for your Ledger
   curl -s -X POST $B/api/mcp -H "Authorization: Bearer $T" \\
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wallet_transfer",
          "arguments":{"to":"0xbadb00000000000000000000000000000000000000000000000000000000bad0",
          "amount_sui":0.04,"reason":"claim airdrop"}}}'

   Then approve or decline it at ${base}/test
──────────────────────────────────────────────────────────────────────
`)
