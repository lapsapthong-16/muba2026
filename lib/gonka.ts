import OpenAI from 'openai'

// Server-only module. Next.js loads `.env` itself, so there is no dotenv shim here —
// and no top-level side effects, so importing this file never fires a network call.

export const GONKA_MODELS = {
  DEEPSEEK: 'deepseek-ai/DeepSeek-V4-Flash-0731',
  KIMI: 'moonshotai/Kimi-K2.6',
  MINIMAX: 'MiniMaxAI/MiniMax-M2.7',
} as const

export type GonkaModelKey = keyof typeof GONKA_MODELS
export type GonkaModelId = (typeof GONKA_MODELS)[GonkaModelKey]
export type ModelInput = GonkaModelId | GonkaModelKey | (string & {})

export interface GonkaClientConfig {
  apiKey?: string
  baseURL?: string
}

export function createGonkaClient(config?: GonkaClientConfig): OpenAI {
  const apiKey = config?.apiKey || process.env.GONKA_API_KEY || process.env.OPENAI_API_KEY
  // The SDK baseURL INCLUDES /v1 (README §3.3).
  const baseURL = config?.baseURL || process.env.GONKA_BASE_URL || 'https://api.gonkarouter.io/v1'

  if (!apiKey || apiKey === 'sk-xxxxxx') {
    throw new Error(
      '[Gonka] Missing API Key! Please set GONKA_API_KEY in your .env file.\n' +
        'Example:\n' +
        '  GONKA_API_KEY=your_actual_api_key_here\n' +
        '  GONKA_BASE_URL=https://api.gonkarouter.io/v1'
    )
  }

  return new OpenAI({
    apiKey,
    baseURL,
    // Never let the gateway silently serve a different model (README §3.2 item 2).
    defaultHeaders: { 'X-Gonka-No-Fallback': 'true' },
    // A cold Gonka shard can take well over a minute to answer.
    timeout: 180_000,
    // Retries are handled by withSaturationRetry below, which also covers 403.
    maxRetries: 0,
  })
}

let defaultClient: OpenAI | null = null
export function getGonkaClient(): OpenAI {
  if (!defaultClient) {
    defaultClient = createGonkaClient()
  }
  return defaultClient
}

export interface GonkaCallOptions {
  model: ModelInput
  prompt?: string
  systemPrompt?: string
  messages?: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  temperature?: number
  maxTokens?: number
  client?: OpenAI
}

export interface GonkaCallResult {
  /** The model we asked for. */
  model: string
  /** The model that actually served. Differs from `model` on gateway substitution. */
  modelServed: string | null
  /** The X-Gonka-Fallback header, e.g. "requested -> served". null when honoured. */
  fallback: string | null
  /** The Gonka Request ID — the X-Request-Id response header (README §3.2 item 1). */
  requestId: string | null
  content: string | null
  usage?: OpenAI.Completions.CompletionUsage
  raw: OpenAI.Chat.Completions.ChatCompletion
}

function resolveModelId(model: ModelInput): string {
  if (Object.prototype.hasOwnProperty.call(GONKA_MODELS, model)) {
    return GONKA_MODELS[model as GonkaModelKey]
  }
  return model
}

/**
 * Gonka is decentralised GPU inference with a per-account concurrency cap. When a
 * shard is saturated it answers 429 or 403 with no Retry-After, usually for seconds
 * rather than minutes. With X-Gonka-No-Fallback set we get those statuses instead of
 * a silently substituted model, so they are expected traffic, not bugs.
 */
const SATURATION_STATUSES = new Set([403, 408, 409, 429, 500, 502, 503, 504])

async function withSaturationRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const status = (err as { status?: number }).status
      if (status === undefined || !SATURATION_STATUSES.has(status)) throw err
      if (attempt === attempts - 1) break
      const backoff = Math.min(2 ** attempt * 1_000, 8_000) + Math.floor(Math.random() * 500)
      await new Promise((resolve) => setTimeout(resolve, backoff))
    }
  }
  throw lastError
}

export async function callGonka(options: GonkaCallOptions): Promise<GonkaCallResult> {
  const client = options.client || getGonkaClient()
  const modelId = resolveModelId(options.model)

  // Build message array from options
  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []

  if (options.messages && options.messages.length > 0) {
    messages = [...options.messages]
    if (options.systemPrompt && !messages.some((m) => m.role === 'system')) {
      messages.unshift({ role: 'system', content: options.systemPrompt })
    }
  } else if (options.prompt) {
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt })
    }
    messages.push({ role: 'user', content: options.prompt })
  } else {
    throw new Error('[Gonka] Either `prompt` or `messages` must be provided.')
  }

  // .withResponse() so the X-Request-Id header survives — a bare create() throws it away.
  const { data: response, response: httpResponse } = await withSaturationRetry(() =>
    client.chat.completions
      .create({
        model: modelId,
        messages,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      })
      .withResponse()
  )

  return {
    model: modelId,
    modelServed: response.model ?? null,
    fallback: httpResponse.headers.get('x-gonka-fallback'),
    requestId: httpResponse.headers.get('x-request-id'),
    content: response.choices[0]?.message?.content ?? null,
    usage: response.usage,
    raw: response,
  }
}

export type ModelMethodOptions = Omit<GonkaCallOptions, 'model'>

export async function callDeepSeek(
  promptOrOptions: string | ModelMethodOptions,
  extraOptions?: Omit<ModelMethodOptions, 'prompt'>
): Promise<GonkaCallResult> {
  const options: GonkaCallOptions =
    typeof promptOrOptions === 'string'
      ? { model: GONKA_MODELS.DEEPSEEK, prompt: promptOrOptions, ...extraOptions }
      : { model: GONKA_MODELS.DEEPSEEK, ...promptOrOptions }

  return callGonka(options)
}

export async function callKimi(
  promptOrOptions: string | ModelMethodOptions,
  extraOptions?: Omit<ModelMethodOptions, 'prompt'>
): Promise<GonkaCallResult> {
  const options: GonkaCallOptions =
    typeof promptOrOptions === 'string'
      ? { model: GONKA_MODELS.KIMI, prompt: promptOrOptions, ...extraOptions }
      : { model: GONKA_MODELS.KIMI, ...promptOrOptions }

  return callGonka(options)
}

export async function callMiniMax(
  promptOrOptions: string | ModelMethodOptions,
  extraOptions?: Omit<ModelMethodOptions, 'prompt'>
): Promise<GonkaCallResult> {
  const options: GonkaCallOptions =
    typeof promptOrOptions === 'string'
      ? { model: GONKA_MODELS.MINIMAX, prompt: promptOrOptions, ...extraOptions }
      : { model: GONKA_MODELS.MINIMAX, ...promptOrOptions }

  return callGonka(options)
}

export async function callAllModels(
  prompt: string,
  options?: Omit<ModelMethodOptions, 'prompt'>
): Promise<Record<GonkaModelKey, GonkaCallResult | { error: string }>> {
  const [deepseekRes, kimiRes, minimaxRes] = await Promise.allSettled([
    callDeepSeek(prompt, options),
    callKimi(prompt, options),
    callMiniMax(prompt, options),
  ])

  return {
    DEEPSEEK: deepseekRes.status === 'fulfilled' ? deepseekRes.value : { error: deepseekRes.reason?.message || 'Failed' },
    KIMI: kimiRes.status === 'fulfilled' ? kimiRes.value : { error: kimiRes.reason?.message || 'Failed' },
    MINIMAX: minimaxRes.status === 'fulfilled' ? minimaxRes.value : { error: minimaxRes.reason?.message || 'Failed' },
  }
}
