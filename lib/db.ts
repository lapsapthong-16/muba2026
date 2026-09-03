import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * One sqlite file, one long-lived process. `node:sqlite` is built into Node 24 — no native build,
 * no install step, no second service.
 *
 * The one rule that matters here: a read failure must NEVER be indistinguishable from "zero".
 * spentLast7d() throws rather than returning 0n, because a missing or corrupt file that reads as
 * zero spent silently grants the agent an unlimited weekly budget.
 */

const DB_PATH = resolve(process.env.WALLET_DB ?? './data/wallet.db')

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (db) return db
  mkdirSync(dirname(DB_PATH), { recursive: true })
  db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id               TEXT PRIMARY KEY,
      token_hash       TEXT NOT NULL UNIQUE,
      setup_token_hash TEXT,
      created_at       INTEGER NOT NULL
    );

    -- One wallet per account. Two committees over the same two keys:
    --   h_address = 1-of-2 {platform, ledger}                 low risk, platform signs alone
    --   m_address = 2-of-2 {platform, ledger, recovery(w2)}   suspicious, both must sign
    -- committees_json holds the ORDERED member arrays; order is hashed into the addresses.
    CREATE TABLE IF NOT EXISTS wallets (
      account_id      TEXT PRIMARY KEY REFERENCES accounts(id),
      h_address       TEXT NOT NULL,
      m_address       TEXT,
      enc_platform_key TEXT NOT NULL,
      ledger_address  TEXT,
      committees_json TEXT,
      policy_json     TEXT,
      policy_version  INTEGER NOT NULL DEFAULT 0
    );

    -- A pending high-risk transaction awaiting a human. tx_bytes_b64 is the FROZEN build; nothing
    -- rebuilds it, because an empty gas payment injects a random nonce and rebuilt bytes differ.
    CREATE TABLE IF NOT EXISTS decisions (
      id                TEXT PRIMARY KEY,
      account_id        TEXT NOT NULL REFERENCES accounts(id),
      state             TEXT NOT NULL,          -- pending | executed | denied | expired | blocked
      intent            TEXT NOT NULL,
      evidence_json     TEXT NOT NULL,
      verdict_json      TEXT NOT NULL,
      ballot_json       TEXT,
      gonka_request_id  TEXT,
      tx_bytes_b64      TEXT NOT NULL,
      bytes_sha256      TEXT NOT NULL,
      sender            TEXT NOT NULL,          -- h_address or m_address
      policy_version    INTEGER NOT NULL,
      digest            TEXT,
      created_at        INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS decisions_pending ON decisions(account_id, state, expires_at);

    -- Debited at SIGN time, not request time. settle() rewrites amount from executed effects.
    CREATE TABLE IF NOT EXISTS spend_ledger (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      coin_type  TEXT NOT NULL,
      amount     TEXT NOT NULL,                 -- base units, decimal string
      digest     TEXT,
      status     TEXT NOT NULL,                 -- reserved | settled | reverted
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS spend_window ON spend_ledger(account_id, coin_type, created_at);
  `)

  /**
   * Additive migrations. ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite, so each is tried
   * and its duplicate-column error swallowed — cheap, and it keeps an existing database (with a
   * real wallet and real history in it) working across a schema change instead of demanding a
   * wipe.
   */
  for (const stmt of [
    // Where to tell the human something is waiting. Any URL that accepts a JSON POST: Slack,
    // Discord, ntfy, a personal script.
    'ALTER TABLE wallets ADD COLUMN notify_url TEXT',
    // Single-use, hashed. Lets a notification carry a one-tap DECLINE from any device.
    'ALTER TABLE decisions ADD COLUMN decline_token_hash TEXT',
  ]) {
    try { d.exec(stmt) } catch { /* already applied */ }
  }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * SUM(amount) for a coin over the last 7 days. THROWS on any store failure — the caller's
 * evaluator treats a throw as deny. Never return 0n on error.
 */
export function spentLast7d(accountId: string, coinType: string): bigint {
  const rows = getDb()
    .prepare(
      `SELECT amount FROM spend_ledger
        WHERE account_id = ? AND coin_type = ? AND status != 'reverted' AND created_at >= ?`
    )
    .all(accountId, coinType, Date.now() - WEEK_MS) as { amount: string }[]
  return rows.reduce((acc, r) => acc + BigInt(r.amount), 0n)
}
