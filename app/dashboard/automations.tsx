'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The automation canvas.
 *
 * UI ONLY. Nothing here schedules anything or touches a key — every automation is a draft, and the
 * page says so plainly rather than implying a runtime that does not exist yet. What it does settle
 * is the SHAPE: an automation is a trigger, optional conditions, and actions that are ordinary
 * wallet intents. That matters, because it means an automation can never do something the agent
 * could not already do by hand — every action still goes through build, simulate, the deterministic
 * rules and the risk model, and an action outside the limits still stops at the Ledger. An
 * automation is a scheduler for intents, not a bypass around the gate.
 *
 * Hand-rolled rather than pulled from a graph library: three node kinds and a linear-ish flow do
 * not justify a dependency, and drag plus an SVG path is a hundred lines.
 */

type Kind = 'trigger' | 'condition' | 'action'

interface Node {
  id: string
  kind: Kind
  label: string
  detail: string
  x: number
  y: number
}

interface Edge {
  from: string
  to: string
}

/** What you can drop on the canvas. Every action maps to a tool the wallet already exposes. */
const PALETTE: { kind: Kind; label: string; detail: string; tool?: string }[] = [
  { kind: 'trigger', label: 'Every morning', detail: '09:00, your timezone' },
  { kind: 'trigger', label: 'Every hour', detail: 'on the hour' },
  { kind: 'trigger', label: 'When SUI moves', detail: 'price changes by 5%' },
  { kind: 'condition', label: 'If price below', detail: 'SUI under $0.70' },
  { kind: 'condition', label: 'If balance above', detail: 'spending over 5 SUI' },
  { kind: 'condition', label: 'If book can fill', detail: 'wallet_markets says yes', tool: 'wallet_markets' },
  { kind: 'action', label: 'Swap on DeepBook', detail: '2 SUI to DBUSDC', tool: 'wallet_swap' },
  { kind: 'action', label: 'Send SUI', detail: 'to an approved payee', tool: 'wallet_transfer' },
  { kind: 'action', label: 'Check first', detail: 'dry run, commit nothing', tool: 'dry_run' },
  { kind: 'action', label: 'Tell me', detail: 'post to your webhook', tool: 'notify' },
]

/** An example that is worth reading, so the canvas is never an empty invitation. */
const SEED: { nodes: Node[]; edges: Edge[] } = {
  nodes: [
    { id: 'n1', kind: 'trigger', label: 'Every morning', detail: '09:00, your timezone', x: 18, y: 66 },
    { id: 'n2', kind: 'condition', label: 'If price below', detail: 'SUI under $0.70', x: 232, y: 66 },
    { id: 'n3', kind: 'action', label: 'Swap on DeepBook', detail: '2 SUI to DBUSDC', x: 446, y: 18 },
    { id: 'n4', kind: 'action', label: 'Tell me', detail: 'post to your webhook', x: 446, y: 152 },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
    { from: 'n2', to: 'n4' },
  ],
}

const STYLE: Record<Kind, { ring: string; chip: string; dot: string; word: string }> = {
  trigger: { ring: 'border-sky-300', chip: 'bg-sky-50 text-sky-800', dot: 'bg-sky-500', word: 'When' },
  condition: { ring: 'border-amber-300', chip: 'bg-amber-50 text-amber-800', dot: 'bg-amber-500', word: 'Only if' },
  action: { ring: 'border-emerald-300', chip: 'bg-emerald-50 text-emerald-800', dot: 'bg-emerald-600', word: 'Then' },
}

const W = 190
const H = 76

export default function Automations() {
  const [nodes, setNodes] = useState<Node[]>(SEED.nodes)
  const [edges, setEdges] = useState<Edge[]>(SEED.edges)
  const [sel, setSel] = useState<string | null>('n2')
  const [linking, setLinking] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(false)
  const canvas = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const seq = useRef(SEED.nodes.length)

  /* ---------- drag, on the document so a fast pointer cannot outrun the node ---------- */
  useEffect(() => {
    function move(e: PointerEvent) {
      const d = drag.current
      const box = canvas.current?.getBoundingClientRect()
      if (!d || !box) return
      const x = Math.max(0, Math.min(box.width - W, e.clientX - box.left - d.dx))
      const y = Math.max(0, Math.min(box.height - H, e.clientY - box.top - d.dy))
      setNodes((ns) => ns.map((n) => (n.id === d.id ? { ...n, x, y } : n)))
    }
    function up() { drag.current = null }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    return () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }
  }, [])

  const startDrag = useCallback((e: React.PointerEvent, n: Node) => {
    const box = canvas.current?.getBoundingClientRect()
    if (!box) return
    drag.current = { id: n.id, dx: e.clientX - box.left - n.x, dy: e.clientY - box.top - n.y }
    setSel(n.id)
  }, [])

  function add(p: (typeof PALETTE)[number]) {
    const id = `n${++seq.current}`
    const box = canvas.current?.getBoundingClientRect()
    setNodes((ns) => [
      ...ns,
      { id, kind: p.kind, label: p.label, detail: p.detail, x: 40 + ((ns.length * 30) % 320), y: Math.min((box?.height ?? 400) - H - 20, 260) },
    ])
    setSel(id)
  }

  function remove(id: string) {
    setNodes((ns) => ns.filter((n) => n.id !== id))
    setEdges((es) => es.filter((e) => e.from !== id && e.to !== id))
    if (sel === id) setSel(null)
  }

  function link(to: string) {
    if (!linking || linking === to) return setLinking(null)
    setEdges((es) =>
      es.some((e) => e.from === linking && e.to === to) ? es : [...es, { from: linking, to }]
    )
    setLinking(null)
  }

  const byId = (id: string) => nodes.find((n) => n.id === id)
  const selected = sel ? byId(sel) : null

  /** The graph, in a sentence — the check that it says what you meant. */
  const sentence = (() => {
    const t = nodes.find((n) => n.kind === 'trigger')
    if (!t) return 'Add a trigger to start.'
    const conds = nodes.filter((n) => n.kind === 'condition')
    const acts = nodes.filter((n) => n.kind === 'action')
    if (!acts.length) return `${t.label.toLowerCase()}, then… add an action.`
    return (
      `${t.label}${conds.length ? ', only if ' + conds.map((c) => c.detail).join(' and ') : ''}, ` +
      `then ${acts.map((a) => a.label.toLowerCase()).join(', then ')}.`
    )
  })()

  return (
    <section className="rounded-xl border border-zinc-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold">Automations</h2>
          <p className="mt-0.5 text-sm text-zinc-500">
            A trigger, what must be true, and what to do. Drag to arrange; click ⊕ then another node to connect.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={() => setEnabled((v) => !v)} />
          <span className={enabled ? 'font-medium text-zinc-900' : 'text-zinc-500'}>Enable</span>
        </label>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[190px_minmax(0,1fr)_240px]">
        {/* palette */}
        <div className="border-b border-zinc-200 p-3 lg:border-b-0 lg:border-r">
          {(['trigger', 'condition', 'action'] as Kind[]).map((k) => (
            <div key={k} className="mb-3">
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                {STYLE[k].word}
              </p>
              <div className="flex flex-col gap-1">
                {PALETTE.filter((p) => p.kind === k).map((p) => (
                  <button
                    key={p.label}
                    onClick={() => add(p)}
                    className={`flex items-center gap-2 rounded-md border border-zinc-200 px-2.5 py-1.5 text-left text-[13px] hover:border-zinc-400 hover:bg-zinc-50`}
                  >
                    <span className={`h-1.5 w-1.5 flex-none rounded-full ${STYLE[k].dot}`} />
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* canvas */}
        <div
          ref={canvas}
          onClick={() => setLinking(null)}
          className="relative h-[420px] overflow-auto bg-[radial-gradient(circle,rgb(212_212_216)_1px,transparent_1px)] [background-size:18px_18px]"
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full">
            {edges.map((e, i) => {
              const a = byId(e.from)
              const b = byId(e.to)
              if (!a || !b) return null
              const x1 = a.x + W
              const y1 = a.y + H / 2
              const x2 = b.x
              const y2 = b.y + H / 2
              const c = Math.max(40, Math.abs(x2 - x1) / 2)
              return (
                <g key={i}>
                  <path
                    d={`M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="rgb(161 161 170)"
                    strokeWidth="1.5"
                  />
                  <circle cx={x2} cy={y2} r="3" fill="rgb(161 161 170)" />
                </g>
              )
            })}
          </svg>

          {nodes.map((n) => {
            const s = STYLE[n.kind]
            const isSel = sel === n.id
            return (
              <div
                key={n.id}
                onPointerDown={(e) => startDrag(e, n)}
                onClick={(e) => { e.stopPropagation(); if (linking) link(n.id); else setSel(n.id) }}
                style={{ left: n.x, top: n.y, width: W, height: H }}
                className={`absolute cursor-grab select-none rounded-lg border bg-white px-3 py-2 shadow-sm active:cursor-grabbing
                  ${isSel ? 'border-zinc-900 ring-2 ring-zinc-900/10' : s.ring}
                  ${linking && linking !== n.id ? 'ring-2 ring-sky-400' : ''}`}
              >
                <div className="flex items-center justify-between">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${s.chip}`}>
                    {s.word}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      title="Connect to another node"
                      onClick={(e) => { e.stopPropagation(); setLinking(linking === n.id ? null : n.id) }}
                      className={`rounded px-1 text-xs ${linking === n.id ? 'bg-sky-500 text-white' : 'text-zinc-400 hover:text-zinc-900'}`}
                    >
                      ⊕
                    </button>
                    <button
                      title="Remove"
                      onClick={(e) => { e.stopPropagation(); remove(n.id) }}
                      className="rounded px-1 text-xs text-zinc-400 hover:text-red-600"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <p className="mt-1 truncate text-[13px] font-medium">{n.label}</p>
                <p className="truncate font-mono text-[11px] text-zinc-500">{n.detail}</p>
              </div>
            )
          })}

          {linking && (
            <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-sky-600 px-3 py-1 text-xs text-white">
              Now click the node it should flow into
            </p>
          )}
        </div>

        {/* inspector */}
        <div className="border-t border-zinc-200 p-4 lg:border-l lg:border-t-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
            {selected ? 'Selected step' : 'Nothing selected'}
          </p>
          {selected ? (
            <div className="mt-2 space-y-3">
              <div>
                <label className="text-xs text-zinc-500">Name</label>
                <input
                  value={selected.label}
                  onChange={(e) =>
                    setNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, label: e.target.value } : n)))
                  }
                  className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-500">Detail</label>
                <input
                  value={selected.detail}
                  onChange={(e) =>
                    setNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, detail: e.target.value } : n)))
                  }
                  className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 font-mono text-xs"
                />
              </div>
              <p className="text-xs text-zinc-500">
                {selected.kind === 'action'
                  ? 'Runs as an ordinary wallet intent — simulated, checked against your limits, and stopped at your Ledger if it falls outside them.'
                  : selected.kind === 'trigger'
                    ? 'Starts the automation. Nothing is signed at this point.'
                    : 'The automation stops here unless this is true.'}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">Click a step to rename it or change what it does.</p>
          )}

          <div className="mt-5 border-t border-zinc-200 pt-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">In words</p>
            <p className="mt-1.5 text-sm text-zinc-700">{sentence}</p>
          </div>
        </div>
      </div>

      <footer className="border-t border-zinc-200 bg-zinc-50 px-5 py-3">
        <p className="text-xs text-zinc-600">
          <b className="font-medium text-zinc-900">Draft — nothing runs yet.</b> Automations are a
          scheduler for intents, not a way around your guardrails: every action still gets built,
          simulated and checked, and anything outside your limits still waits for your Ledger. An
          automation can never do something you have not already allowed your agent to do.
        </p>
      </footer>
    </section>
  )
}
