import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('data/wallet.db', { readOnly: true })
for (const id of ['60e30f85-2799-4864-a908-ed158e0edb27','3dd6cf74-90c2-4890-aa86-a2ce3d060278']) {
  const w = db.prepare('SELECT policy_json, policy_version FROM wallets WHERE account_id=?').get(id) as any
  console.log(id.slice(0,8), 'v'+w.policy_version, JSON.stringify(JSON.parse(w.policy_json).caps))
}
