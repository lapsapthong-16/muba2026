import { callAllModels, callGonka, GONKA_MODELS } from '@/lib/gonka'
import type { GonkaModelKey } from '@/lib/gonka'

// The Gonka API sends no CORS headers, so the browser can never call it directly.
// Every call goes through here, where GONKA_API_KEY stays server-side.
export const runtime = 'nodejs'
// Cold Gonka shards can take a minute-plus to answer. (Vercel: Hobby caps this at 60.)
export const maxDuration = 300

interface GonkaRequestBody {
  prompt?: string
  model?: GonkaModelKey | 'ALL' | string
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
}

export async function POST(request: Request) {
  let body: GonkaRequestBody
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Body must be JSON.' }, { status: 400 })
  }

  const prompt = body.prompt?.trim()
  if (!prompt) {
    return Response.json({ error: 'Field `prompt` is required.' }, { status: 400 })
  }

  const model = body.model || 'KIMI'
  const options = {
    systemPrompt: body.systemPrompt,
    temperature: body.temperature,
    maxTokens: body.maxTokens ?? 512,
  }

  try {
    if (model === 'ALL') {
      return Response.json({ results: await callAllModels(prompt, options) })
    }
    return Response.json({ result: await callGonka({ model, prompt, ...options }) })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error calling Gonka.'
    console.error('[/api/gonka]', message)
    return Response.json({ error: message }, { status: 502 })
  }
}

/** Sanity check in the browser: which models this route knows about. */
export async function GET() {
  return Response.json({ models: GONKA_MODELS })
}
