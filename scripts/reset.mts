/**
 * Wipe every wallet so the next demo starts from nothing.
 *
 *   npm run reset          # do it
 *   npm run reset -- --dry # show what would go, change nothing
 *
 * DELETES ROWS, NOT THE DATABASE FILE. Two reasons, and both bite in practice:
 *
 *   1. The dev server memoises its connection in a module-level variable (lib/db.ts). Deleting the
 *      file out from under a running process leaves it holding a handle to an unlinked inode, so
 *      the app keeps serving a database nobody can see and the next write recreates it half-formed.
 *      Deleting rows is visible to every connection immediately, so you can reset mid-demo without
 *      restarting anything.
 *   2. WAL mode means the file is really three files — wallet.db, -wal and -shm. Removing only the
 *      first leaves a write-ahead log that can replay rows you thought were gone.
 *
 * Before clearing, it refunds spending-pocket SUI to REFUND. The protected address is a 2-of-2
 * whose recovery key we hand to the human and do not keep, so protected SUI remains there and is
 * printed rather than silently treated as recovered.
 */
import { existsSync, rmSync } from 'node:fs'
import { getDb } from '../lib/db'
import { getBalance, NETWORK, assertChain } from '../lib/sui'
import { buildTransferAll } from '../lib/tx'
import { executeFromSpending } from '../lib/execute'

const dry = process.argv.includes('--dry')
const refund = process.env.REFUND

// The one real rail. Everything below is irreversible, and "it only ever ran on testnet" is an
// assumption worth checking rather than believing.
if (NETWORK !== 'testnet') {
  console.error(`Refusing to reset: this is configured for ${NETWORK}, not testnet.`)
  process.exit(1)
}
await assertChain()

const db = getDb()
const wallets = db
  .prepare("SELECT account_id, h_address, m_address FROM wallets WHERE h_address != ''")
  .all() as { account_id: string; h_address: string; m_address: string | null }[]

const counts = Object.fromEntries(
  ['accounts', 'wallets', 'decisions', 'spend_ledger'].map((t) => [
    t,
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
  ])
)

console.log(`${dry ? 'WOULD CLEAR' : 'CLEARING'} — ${NETWORK}\n`)
console.log(`  accounts      ${counts.accounts}`)
console.log(`  wallets       ${counts.wallets}`)
console.log(`  decisions     ${counts.decisions}   (approvals, history, and the reasons the agent gave)`)
console.log(`  spend_ledger  ${counts.spend_ledger}   (the weekly-cap counter)`)

// Spell the stranded SUI out. A reset that silently abandons funds teaches you to distrust it.
let stranded = 0n
if (wallets.length) {
  console.log(`\n  SUI left behind in ${wallets.length} old wallet(s) — not swept:`)
  for (const w of wallets) {
    const h = await getBalance(w.h_address).catch(() => 0n)
    const m = w.m_address ? await getBalance(w.m_address).catch(() => 0n) : 0n
    stranded += h + m
    if (h + m > 0n) {
      console.log(`    ${w.account_id.slice(0, 8)}  spending ${(Number(h) / 1e9).toFixed(4)}  protected ${(Number(m) / 1e9).toFixed(4)}`)
    }
  }
  console.log(`    total ${(Number(stranded) / 1e9).toFixed(4)} SUI`)
}

const files = ['.mcp.json', '.puffer'].filter((f) => existsSync(f))
console.log(`\n  files         ${files.length ? files.join(', ') : '(none)'}`)

if (dry) {
  console.log('\n--dry: nothing was changed.')
  process.exit(0)
}

if (!refund?.startsWith('0x')) {
  console.error('\nREFUND is required for a real reset; set it to your testnet wallet address.')
  process.exit(1)
}

for (const w of wallets) {
  const amount = await getBalance(w.h_address)
  if (!amount) continue
  const frozen = await buildTransferAll(w.h_address, refund)
  const res = await executeFromSpending(w.account_id, frozen)
  console.log(`    refunded ${(Number(amount) / 1e9).toFixed(4)} SUI from spending pocket (${res.digest})`)
}

/**
 * Children before parents. decisions and spend_ledger both reference accounts(id), and
 * `PRAGMA foreign_keys = ON` is set at connection time — so deleting accounts first would throw
 * on the constraint rather than cascade.
 */
for (const t of ['decisions', 'spend_ledger', 'wallets', 'accounts']) {
  db.prepare(`DELETE FROM ${t}`).run()
}
for (const f of files) rmSync(f, { recursive: true, force: true })

console.log(`
Cleared. Nothing is left in the database, and the agent's credentials are gone.

Next:
  ONBOARD_PASS=demo npm run dev     (if it is not already running)
  npm run onboard                   creates a fresh account, writes .mcp.json
  restart Claude Code               so it picks up the new server
  then say: "I want to create my wallet"
`)
