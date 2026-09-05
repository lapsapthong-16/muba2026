import { requireHuman, authErrorResponse } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { requestProtectedRefund } from '@/lib/wallet'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const accountId = requireHuman(req).accountId
    const refund = process.env.REFUND
    if (!refund) return Response.json({ error: 'REFUND is not configured.' }, { status: 503 })
    const wallet = getDb().prepare('SELECT m_address FROM wallets WHERE account_id=?').get(accountId) as { m_address?: string } | undefined
    if (!wallet?.m_address) return Response.json({ error: 'Connect your Ledger first.' }, { status: 409 })
    return Response.json(await requestProtectedRefund(accountId, refund))
  } catch (e) {
    try { return authErrorResponse(e) }
    catch (err) { return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 }) }
  }
}
