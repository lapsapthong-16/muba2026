/**
 * Point Claude Code at an EXISTING wallet.
 *
 *   npm run connect -- hw_live_…                       # a bearer you already have
 *   npm run connect -- 'http://localhost:3001/setup#s=st_…'   # or your setup link
 *   npm run connect -- st_…                            # or just the setup token
 *
 * `npm run onboard` creates a NEW account, which is wrong when you already have a funded,
 * Ledger-enrolled wallet — a new account means a new platform key, a different multisig committee,
 * and therefore different addresses with your funds stranded at the old ones. This points the
 * config at the wallet you already have instead.
 *
 * Given a setup link or token it re-issues the bearer through /api/setup/bearer, which is the
 * supported way back into an account whose bearer was lost: bearers are stored as a sha256 and
 * shown once.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const arg = process.argv.slice(2).find((a) => !a.startsWith('-'))
if (!arg) {
  console.error('usage: npm run connect -- <bearer | setup-url | setup-token>')
  process.exit(1)
}

const port = process.env.PORT ?? '3000'
const base = process.env.BASE_URL ?? `http://localhost:${port}`

let bearer: string
if (arg.startsWith('hw_live_')) {
  bearer = arg
} else {
  // A setup link carries its token in the FRAGMENT, which is why it never reaches a server log.
  const token = arg.includes('#s=') ? arg.split('#s=')[1].trim() : arg.trim()
  if (!token.startsWith('st_')) {
    console.error(`Not a bearer, a setup link, or a setup token: ${arg.slice(0, 24)}…`)
    process.exit(1)
  }
  const r = await fetch(`${base}/api/setup/bearer`, {
    method: 'POST',
    headers: { Cookie: `hw_session=${token}` },
  })
  if (!r.ok) {
    console.error(`Could not re-issue a bearer (${r.status}):`, (await r.text()).slice(0, 200))
    console.error('\nIs the server running, and is that setup link still the current one?')
    process.exit(1)
  }
  const j = (await r.json()) as { bearer: string; spending_address: string; protected_address: string }
  bearer = j.bearer
  console.log(`re-issued. the previous bearer no longer works.`)
  console.log(`  spending  ${j.spending_address}`)
  console.log(`  protected ${j.protected_address}`)
}

// Confirm it actually works before writing it anywhere. A config file pointing at a dead
// credential is worse than none: it fails at demo time instead of now.
const probe = await fetch(`${base}/api/mcp`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wallet_status', arguments: {} } }),
})
if (!probe.ok) {
  console.error(`That bearer does not work against ${base}/api/mcp (${probe.status}). Nothing written.`)
  process.exit(1)
}
const status = (await probe.json()) as { result?: { structuredContent?: Record<string, unknown> } }
const st = status.result?.structuredContent ?? {}

const ignore = '.gitignore'
const txt = existsSync(ignore) ? readFileSync(ignore, 'utf8') : ''
if (!txt.includes('.mcp.json')) {
  writeFileSync(ignore, txt.replace(/\n*$/, '\n') + '\n# holds a wallet bearer\n.mcp.json\n')
}
const path = '.mcp.json'
const cfg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
cfg.mcpServers = {
  ...(cfg.mcpServers ?? {}),
  puffer: { type: 'http', url: `${base}/api/mcp`, headers: { Authorization: `Bearer ${bearer}` } },
}
writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n')

console.log(`\nwrote .mcp.json -> ${base}/api/mcp   (gitignored)`)
if (st.wallet_ready) {
  console.log(`wallet ready · ${st.balance_sui} SUI spending / ${st.protected_balance_sui} SUI protected · mode ${st.mode}`)
  const failing = ((st.preflight ?? []) as { check: string; ok: boolean; detail: string }[]).filter((c) => !c.ok)
  if (failing.length) {
    console.log('\npreflight says this will bite you:')
    for (const f of failing) console.log(`  ${f.check}: ${f.detail}`)
  } else {
    console.log('preflight clean.')
  }
} else {
  console.log(`wallet NOT ready: ${JSON.stringify(st.missing ?? st.outcome)}`)
}
console.log('\nRestart Claude Code in this directory and approve the server when it asks.')
console.log('Then say: "run the puffer demo".')
