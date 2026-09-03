'use client'

import { useState } from 'react'

const MODEL_OPTIONS = [
  { value: 'ALL', label: 'All three (parallel)' },
  { value: 'KIMI', label: 'Kimi K2.6' },
  { value: 'DEEPSEEK', label: 'DeepSeek V4 Flash' },
  { value: 'MINIMAX', label: 'MiniMax M2.7' },
] as const

interface CallResult {
  model: string
  modelServed: string | null
  fallback: string | null
  requestId: string | null
  content: string | null
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

type ModelOutcome = CallResult | { error: string }

function isError(outcome: ModelOutcome): outcome is { error: string } {
  return 'error' in outcome
}

export default function CallGonkaPage() {
  const [prompt, setPrompt] = useState('Say hello and give one fun fact in 1 sentence!')
  const [model, setModel] = useState<string>('ALL')
  const [outcomes, setOutcomes] = useState<[string, ModelOutcome][]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function run() {
    setLoading(true)
    setError(null)
    setOutcomes([])
    try {
      const res = await fetch('/api/gonka', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, model, temperature: 0 }),
      })
      // Never res.json() blind: a restarted dev server or a dropped connection
      // returns an empty body, and "Unexpected end of JSON input" hides the real cause.
      const text = await res.text()
      let data: { error?: string; result?: ModelOutcome; results?: Record<string, ModelOutcome> }
      try {
        data = JSON.parse(text)
      } catch {
        setError(
          text.trim()
            ? `HTTP ${res.status} — non-JSON response:\n${text.slice(0, 500)}`
            : `HTTP ${res.status} — empty response. The dev server likely restarted mid-request; try again.`
        )
        return
      }
      if (!res.ok) {
        setError(data.error ?? `Request failed with ${res.status}`)
      } else if (data.results) {
        setOutcomes(Object.entries(data.results as Record<string, ModelOutcome>))
      } else {
        setOutcomes([[model, data.result as ModelOutcome]])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Gonka Router smoke test</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Calls <code className="font-mono">POST /api/gonka</code>. The key never leaves the server.
      </p>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        className="mt-6 w-full rounded-lg border border-black/10 bg-transparent p-3 font-mono text-sm dark:border-white/15"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm dark:border-white/15"
        >
          {MODEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          onClick={run}
          disabled={loading || !prompt.trim()}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background disabled:opacity-40"
        >
          {loading ? 'Calling…' : 'Call Gonka'}
        </button>
        {loading && (
          <span className="text-xs text-zinc-500">
            A cold shard can take over a minute on the first call.
          </span>
        )}
      </div>

      {error && (
        <pre className="mt-6 overflow-x-auto whitespace-pre-wrap rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-400">
          {error}
        </pre>
      )}

      {outcomes.map(([key, outcome]) => (
        <section
          key={key}
          className="mt-6 rounded-lg border border-black/10 p-4 dark:border-white/15"
        >
          <h2 className="font-mono text-sm font-semibold">{key}</h2>
          {isError(outcome) ? (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{outcome.error}</p>
          ) : (
            <>
              <p className="mt-2 whitespace-pre-wrap text-sm">{outcome.content}</p>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs text-zinc-500">
                <dt>served by</dt>
                <dd>
                  {outcome.modelServed ?? '—'}
                  {((outcome.modelServed && outcome.modelServed !== outcome.model) ||
                    outcome.fallback) && (
                    <span className="ml-2 text-amber-600">
                      ⚠ substituted{outcome.fallback ? ` (${outcome.fallback})` : ''}
                    </span>
                  )}
                </dd>
                <dt>x-request-id</dt>
                <dd>{outcome.requestId ?? '— (none returned)'}</dd>
                <dt>tokens</dt>
                <dd>{outcome.usage ? `${outcome.usage.total_tokens} total` : '—'}</dd>
              </dl>
            </>
          )}
        </section>
      ))}
    </main>
  )
}
