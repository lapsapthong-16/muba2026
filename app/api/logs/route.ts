import { authErrorResponse, requireHuman } from '@/lib/auth'
import { getDb } from '@/lib/db'

export function GET(req: Request) {
  try {
    requireHuman(req)
    const url = new URL(req.url)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500)
    const rows = getDb().prepare(`SELECT id, model, model_served, request_id, devshard_id, outcome, status_code, latency_ms, total_tokens, created_at FROM gonka_calls ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit)
    return Response.json({ calls: rows })
  } catch (error) {
    return authErrorResponse(error)
  }
}
