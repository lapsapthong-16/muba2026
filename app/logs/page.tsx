'use client'

import { useEffect, useState } from 'react'
import './logs.css'

type Call = { id: number; model: string; model_served: string | null; request_id: string | null; devshard_id: string | null; outcome: string; status_code: number | null; latency_ms: number; total_tokens: number | null; created_at: number }

export default function LogsPage() {
  const [calls, setCalls] = useState<Call[]>([])
  const [selected, setSelected] = useState<Call | null>(null)
  const [receipt, setReceipt] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState('')

  useEffect(() => { void fetch('/api/logs').then(async (r) => { if (!r.ok) throw new Error((await r.json()).error ?? 'Could not load logs'); return r.json() }).then((body) => setCalls(body.calls)).catch((e) => setError(e.message)) }, [])
  async function select(call: Call) {
    setSelected(call); setReceipt(null)
    if (!call.request_id) return
    const r = await fetch(`/api/logs/receipt/${encodeURIComponent(call.request_id)}`)
    setReceipt(await r.json())
  }

  return <main className="logs-page"><section className="logs-shell"><p className="logs-eyebrow">PUFFER / GONKA</p><h1>INFERENCE LOGS</h1><p className="logs-intro">Every local record is metadata only. Successful calls can be independently checked against Gonka receipts.</p>{error ? <p className="logs-error">{error}</p> : <div className="logs-grid"><div className="logs-table-wrap"><table><thead><tr><th>TIME</th><th>MODEL</th><th>STATUS</th><th>REQUEST ID</th><th>LATENCY</th><th>DEVSHARD ID</th></tr></thead><tbody>{calls.map((call) => <tr key={call.id} onClick={() => void select(call)} className={selected?.id === call.id ? 'selected' : ''}><td>{new Date(call.created_at).toLocaleString()}</td><td>{call.model}<small>{call.model_served && call.model_served !== call.model ? `served: ${call.model_served}` : ''}</small></td><td><span className={`log-status ${call.outcome}`}>{call.outcome}</span></td><td><code>{call.request_id ?? '—'}</code></td><td>{call.latency_ms} ms</td><td><code>{call.devshard_id ?? '—'}</code></td></tr>)}</tbody></table>{!calls.length && <p className="logs-empty">No Gonka calls recorded yet.</p>}</div>{selected && <aside className="logs-detail"><p className="logs-eyebrow">CALL #{selected.id}</p><h2>{selected.outcome.toUpperCase()}</h2><dl><dt>MODEL</dt><dd>{selected.model}</dd><dt>DEVSHARD</dt><dd>{selected.devshard_id ?? '—'}</dd><dt>LATENCY</dt><dd>{selected.latency_ms} ms</dd><dt>TOKENS</dt><dd>{selected.total_tokens ?? '—'}</dd><dt>REQUEST ID</dt><dd><code>{selected.request_id ?? '— none returned'}</code></dd></dl>{selected.request_id ? <><h3>GONKA RECEIPT</h3><pre>{receipt ? JSON.stringify(receipt, null, 2) : 'Loading…'}</pre></> : <p className="logs-muted">No request ID was returned, so Gonka cannot provide a receipt lookup for this attempt.</p>}</aside>}</div>}</section></main>
}
