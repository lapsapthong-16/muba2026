import OpenAI from 'openai'
import fs from 'node:fs'
import path from 'node:path'

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env')
  if (fs.existsSync(envPath)) {
    if (typeof process.loadEnvFile === 'function') {
      try {
        process.loadEnvFile(envPath)
        return
      } catch {}
    }
    // Fallback .env parser
    try {
      const content = fs.readFileSync(envPath, 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim()
          let value = trimmed.slice(eqIdx + 1).trim()
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1)
          }
          if (!process.env[key]) {
            process.env[key] = value
          }
        }
      }
    } catch {}
  }
}

loadDotEnv()

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
  model: string
  content: string | null
  usage?: OpenAI.Completions.CompletionUsage
  raw: OpenAI.Chat.Completions.ChatCompletion
}

function resolveModelId(model: ModelInput): string {
  if (model in GONKA_MODELS) {
    return GONKA_MODELS[model as GonkaModelKey]
  }
  return model
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

  const response = await client.chat.completions.create({
    model: modelId,
    messages,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
  })

  return {
    model: modelId,
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

async function main() {
  console.log('==================================================')
  console.log(' Gonka Router Multi-Model Calling Test')
  console.log('==================================================\n')

  const testPrompt = 'Say hello and give one fun fact in 1 sentence!'

  try {
    // Calling Method 1: DeepSeek
    console.log('👉 [1/3] Calling DeepSeek...')
    const deepseekOutput = await callDeepSeek(testPrompt)
    console.log('🤖 Model:', deepseekOutput.model)
    console.log('💬 Response:', deepseekOutput.content)
    console.log('--------------------------------------------------\n')

    // Calling Method 2: Kimi
    console.log('👉 [2/3] Calling Kimi...')
    const kimiOutput = await callKimi(testPrompt)
    console.log('🤖 Model:', kimiOutput.model)
    console.log('💬 Response:', kimiOutput.content)
    console.log('--------------------------------------------------\n')

    // Calling Method 3: MiniMax
    console.log('👉 [3/3] Calling MiniMax...')
    const minimaxOutput = await callMiniMax(testPrompt)
    console.log('🤖 Model:', minimaxOutput.model)
    console.log('💬 Response:', minimaxOutput.content)
    console.log('--------------------------------------------------\n')

    // Unified Method: Calling directly via callGonka()
    console.log('👉 [Bonus] Calling via generic `callGonka()` method...')
    const genericOutput = await callGonka({
      model: 'DEEPSEEK', // or GONKA_MODELS.DEEPSEEK
      prompt: 'What is 2 + 2? Reply with just the number.',
    })
    console.log('💬 Generic Call Response:', genericOutput.content)
    console.log('==================================================')
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error('\n❌ Execution Error:', err.message)
    } else {
      console.error('\n❌ Unknown error occurred:', err)
    }
  }
}

// Execute test when run directly
if (process.env.NODE_ENV !== 'production') {
  main()
}