import { getDb } from '../lib/db'
const rows = getDb().prepare("SELECT id, account_id, state, intent, sender, policy_version, created_at, expires_at FROM decisions ORDER BY created_at DESC LIMIT 40").all() as any[]
for (const r of rows) {
  console.log([r.created_at, new Date(r.created_at).toISOString(), r.account_id.slice(0,8), r.state, r.sender?.slice(0,10), JSON.stringify(r.intent).slice(0,70)].join(' | '))
}
console.log('--- swap-ish rows ---')
const s = getDb().prepare("SELECT id, account_id, state, intent, sender FROM decisions WHERE intent LIKE '%swap%'").all() as any[]
console.log(JSON.stringify(s, null, 1))
