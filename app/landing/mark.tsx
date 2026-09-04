/**
 * The masthead mark: the same fish, at rest.
 *
 * Static rather than a second canvas — one animation loop cannot cleanly drive two mount points,
 * and a wordmark that quietly burns a rAF on every page is a poor trade for a 26px drawing.
 * Spines are generated, so the mark and the hero agree on what a puffer looks like.
 */
export default function Mark({ size = 26 }: { size?: number }) {
  const c = size / 2
  const r = size * 0.3
  const spines = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2
    const x1 = c + Math.cos(a) * r
    const y1 = c + Math.sin(a) * r
    const x2 = c + Math.cos(a) * (r * 1.52)
    const y2 = c + Math.sin(a) * (r * 1.52)
    return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth={size * 0.055} strokeLinecap="round" />
  })
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ color: 'var(--alert)', flex: 'none' }}>
      {spines}
      <circle cx={c} cy={c} r={r} fill="currentColor" />
      <circle cx={c + r * 0.42} cy={c - r * 0.26} r={r * 0.2} fill="var(--surface)" />
    </svg>
  )
}
