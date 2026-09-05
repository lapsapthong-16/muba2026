import { authErrorResponse, requireHuman } from '@/lib/auth'

export async function GET(req: Request, { params }: { params: Promise<{ requestId: string }> }) {
  try {
    requireHuman(req)
    const { requestId } = await params
    if (!/^[-_a-zA-Z0-9]+$/.test(requestId)) return Response.json({ error: 'Invalid request ID' }, { status: 400 })
    const response = await fetch(`https://api.gonkarouter.io/v1/receipts/${encodeURIComponent(requestId)}`, { cache: 'no-store' })
    return Response.json(await response.json(), { status: response.status })
  } catch (error) {
    return authErrorResponse(error)
  }
}
