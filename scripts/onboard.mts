/**
 * Onboard an agent, WIRE IT UP, and print what only a human can do.
 *
 *   npm run onboard              # against http://localhost:3000
 *   PORT=3001 npm run onboard
 *   npm run onboard -- --global  # also install the skill for every project
 *
 * This is what hermes would do on first run. It writes .mcp.json so Claude Code picks the wallet
 * up on its next start with no copy-paste, and prints the equivalent for Codex and hermes.
 *
 * .mcp.json HOLDS A BEARER, so it is written to .gitignore before it is written to disk. A demo
 * credential is still a credential, and the difference between a testnet key and a mainnet one is
 * one careless commit.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

/* ---------- wire Claude Code up, rather than asking you to ---------- */
const ignore = '.gitignore'
const ignoreTxt = existsSync(ignore) ? readFileSync(ignore, 'utf8') : ''
if (!ignoreTxt.includes('.mcp.json')) {
  writeFileSync(ignore, ignoreTxt.replace(/\n*$/, '\n') + '\n# holds a wallet bearer\n.mcp.json\n')
}
// Merge rather than overwrite: this is a shared file and clobbering someone else's server would be
// a rude way to install a wallet.
const mcpPath = '.mcp.json'
const existing = existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, 'utf8')) : {}
existing.mcpServers = {
  ...(existing.mcpServers ?? {}),
  puffer: {
    type: 'http',
    url: `${base}/api/mcp`,
    headers: { Authorization: `Bearer ${b.bearer}` },
  },
}
writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n')

let skillNote = '   .claude/skills/puffer-wallet/ — active in this project already.'
if (process.argv.includes('--global')) {
  const dest = join(homedir(), '.claude', 'skills', 'puffer-wallet')
  mkdirSync(dest, { recursive: true })
  cpSync('.claude/skills/puffer-wallet', dest, { recursive: true })
  skillNote = `   Installed to ${dest} — available in every project.`
}

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
 4. CONNECT YOUR AGENT — pick the one you use
──────────────────────────────────────────────────────────────────────
 CLAUDE CODE  — done. .mcp.json written in this directory.
   Restart Claude Code here and approve the server when it asks.
${skillNote}

 CODEX  — ~/.codex/config.toml:
   [mcp_servers.hermes_wallet]
   url = "${base}/api/mcp"
   http_headers = { Authorization = "Bearer ${b.bearer}" }

 HERMES  — ~/.hermes/config.yaml:
${b.config_yaml.split('\n').map((l) => (l ? '   ' + l : l)).join('\n')}
 ANY AGENT that speaks plain HTTP can skip MCP entirely and POST to
 ${base}/api/check with that same bearer.

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
