'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * The hero: a pufferfish that inflates, and the receipt for whichever transaction it is reacting to.
 *
 * The fish is drawn procedurally rather than swapped between two pictures, because the point is the
 * TRANSITION — t=0 is a small smooth fish, t=1 is a sphere with every spine out, and the wallet
 * moving between 1-of-2 and 2-of-2 is exactly that. A pair of images could not show the in-between.
 *
 * Colours are read from the CSS custom properties and re-read when the OS theme flips, so the
 * canvas stays in the same palette as the page instead of quietly becoming light-mode art on a
 * dark ground.
 */

type Mode = 'hold' | 'pass'

const DATA = {
  hold: {
    title: 'Approval required',
    chip: 'Held',
    cls: 'hold',
    state: 'Inflated',
    badge: '2-of-2',
    rows: [
      ['Agent said', '“Claim the airdrop before it expires”', false],
      ['Sending', '1.000000 SUI', true],
      ['To', '0xbadb0000…0000bad0', false],
      ['From', '0x03303456…c0533e46 · 2-of-2', false],
      ['Rule', 'UNKNOWN_RECIPIENT', false],
      ['Risk', '85 / 100 · high', false],
      ['Agent was told', 'NOT SENT · poll for the outcome', false],
    ] as [string, string, boolean][],
    src: 'Risk model · 85 / 100 · high',
    quote:
      'The “claim free airdrop” text is a social engineering trick with no actual reward. Funds leave to an unknown address with nothing coming back.',
    acts: [
      ['Decline', ''],
      ['Approve on Ledger', 'go'],
    ] as [string, string][],
  },
  pass: {
    title: 'Settled',
    chip: 'Cleared',
    cls: 'pass',
    state: 'At rest',
    badge: '1-of-2',
    rows: [
      ['Agent said', '“Rebalance 2 SUI into USDC”', false],
      ['Out', '1.902375 SUI', true],
      ['Back', '1.3756 DBUSDC', false],
      ['Venue', 'DeepBook v3 · SUI_DBUSDC', false],
      ['Gas', 'sponsored · the wallet paid 0', false],
      ['Risk', '20 / 100 · low', false],
      ['Digest', 'GbCZqDq1wW31HrPRPnsgw8FMRUFffrseFacoNruLPCKV', false],
    ] as [string, string, boolean][],
    src: 'Risk model · 20 / 100 · low',
    quote:
      'Normal swap on DeepBook. Value leaving is matched by DBUSDC arriving back in the same transaction.',
    acts: [['Settled on chain', 'solo']] as [string, string][],
  },
}

/* ---------- colour helpers ---------- */
function parse(c: string): [number, number, number] {
  const s = c.trim()
  if (s[0] === '#') {
    const h = s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
  }
  const m = s.match(/(\d+(\.\d+)?)/g)
  return m ? [+m[0], +m[1], +m[2]] : [136, 136, 136]
}
const mix = (a: string, b: string, t: number) => {
  const x = parse(a)
  const y = parse(b)
  return `rgb(${Math.round(x[0] + (y[0] - x[0]) * t)},${Math.round(x[1] + (y[1] - x[1]) * t)},${Math.round(x[2] + (y[2] - x[2]) * t)})`
}
const shade = (c: string, amt: number) =>
  `rgb(${parse(c)
    .map((v) => Math.max(0, Math.min(255, Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt)))))
    .join(',')})`
const alpha = (c: string, a: number) => {
  const x = parse(c)
  return `rgba(${x[0]},${x[1]},${x[2]},${a})`
}

export default function PufferDemo() {
  const [mode, setMode] = useState<Mode>('hold')
  const stage = useRef<HTMLCanvasElement>(null)
  const target = useRef(1)
  const cur = useRef(1)

  useEffect(() => {
    target.current = mode === 'hold' ? 1 : 0
  }, [mode])

  useEffect(() => {
    const root = document.querySelector('.pf') as HTMLElement | null
    if (!root) return
    let P: Record<string, string> = {}
    const readPalette = () => {
      const cs = getComputedStyle(root)
      P = Object.fromEntries(
        ['--calm', '--alert', '--ink', '--ink-3', '--surface'].map((n) => [n, cs.getPropertyValue(n).trim() || '#888'])
      )
    }
    readPalette()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', readPalette)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    function draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, time: number, scale: number) {
      const cx = w / 2
      const cy = h / 2 + Math.sin(time / 1400) * 2.5 * scale * (reduce ? 0 : 1)
      const r = (34 + 30 * t) * scale
      const squash = 1 - 0.14 * (1 - t)
      const body = mix(P['--calm'], P['--alert'], t)
      ctx.clearRect(0, 0, w, h)

      // tail — attached at the body EDGE so inflation never swallows it
      const tailR = r * 0.93
      const tailW = (15 + 7 * (1 - t)) * scale
      const tailL = (34 - 4 * t) * scale
      ctx.beginPath()
      ctx.moveTo(cx - tailR * 0.86, cy - tailW * 0.35)
      ctx.quadraticCurveTo(cx - tailR - tailL * 0.6, cy - tailW, cx - tailR - tailL, cy - tailW * 0.55)
      ctx.lineTo(cx - tailR - tailL, cy + tailW * 0.55)
      ctx.quadraticCurveTo(cx - tailR - tailL * 0.6, cy + tailW, cx - tailR * 0.86, cy + tailW * 0.35)
      ctx.closePath()
      ctx.fillStyle = shade(body, -0.12)
      ctx.fill()

      // spines — length rides t, so at rest they vanish into the skin
      const n = 34
      const spine = (2 + 20 * t) * scale
      if (t > 0.02) {
        ctx.fillStyle = shade(body, -0.24)
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + (reduce ? 0 : Math.sin(time / 2600) * 0.02)
          const wob = 1 + 0.12 * Math.sin(i * 2.4)
          const ex = cx + Math.cos(a) * (r * 0.97)
          const ey = cy + Math.sin(a) * (r * 0.97) * squash
          const tx = cx + Math.cos(a) * (r + spine * wob)
          const ty = cy + Math.sin(a) * (r + spine * wob) * squash
          const pa = a + Math.PI / 2
          const bw = 3.4 * scale * (0.6 + 0.4 * t)
          ctx.beginPath()
          ctx.moveTo(ex + Math.cos(pa) * bw, ey + Math.sin(pa) * bw * squash)
          ctx.lineTo(tx, ty)
          ctx.lineTo(ex - Math.cos(pa) * bw, ey - Math.sin(pa) * bw * squash)
          ctx.closePath()
          ctx.fill()
        }
      }

      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.42, r * 0.1, cx, cy, r * 1.15)
      g.addColorStop(0, shade(body, 0.2))
      g.addColorStop(1, body)
      ctx.beginPath()
      ctx.ellipse(cx, cy, r, r * squash, 0, 0, Math.PI * 2)
      ctx.fillStyle = g
      ctx.fill()

      ctx.beginPath()
      ctx.ellipse(cx + r * 0.06, cy + r * squash * 0.42, r * 0.62, r * squash * 0.44, 0, 0, Math.PI * 2)
      ctx.fillStyle = alpha(shade(body, 0.42), 0.55)
      ctx.fill()

      ctx.beginPath()
      ctx.ellipse(cx + r * 0.3, cy + r * squash * 0.44, r * 0.2, r * 0.105, 0.42, 0, Math.PI * 2)
      ctx.fillStyle = alpha(shade(body, -0.22), 0.85)
      ctx.fill()

      // eye — the pupil widens with the threat
      const ex2 = cx + r * 0.46
      const ey2 = cy - r * squash * 0.24
      const er = r * 0.17
      ctx.beginPath()
      ctx.arc(ex2, ey2, er, 0, Math.PI * 2)
      ctx.fillStyle = P['--surface']
      ctx.fill()
      ctx.lineWidth = 1.2 * scale
      ctx.strokeStyle = alpha(P['--ink'], 0.25)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(ex2 + er * 0.16, ey2, er * (0.42 + 0.2 * t), 0, Math.PI * 2)
      ctx.fillStyle = P['--ink']
      ctx.fill()

      ctx.strokeStyle = shade(body, -0.42)
      ctx.lineWidth = 2.2 * scale
      ctx.lineCap = 'round'
      ctx.beginPath()
      const mx = cx + r * 0.9
      const my = cy + r * squash * 0.1
      if (t < 0.5) ctx.arc(mx, my, r * 0.09, 0, Math.PI * 2)
      else {
        ctx.moveTo(mx - r * 0.07, my - r * 0.04)
        ctx.lineTo(mx + r * 0.05, my + r * 0.02)
      }
      ctx.stroke()
    }

    function fit(cv: HTMLCanvasElement | null) {
      if (!cv) return null
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const r = cv.getBoundingClientRect()
      if (!r.width) return null
      cv.width = Math.round(r.width * dpr)
      cv.height = Math.round(r.height * dpr)
      return { ctx: cv.getContext('2d')!, w: cv.width, h: cv.height }
    }
    let S = fit(stage.current)
    const onResize = () => {
      S = fit(stage.current)
    }
    window.addEventListener('resize', onResize)

    let raf = 0
    const frame = (time: number) => {
      cur.current += (target.current - cur.current) * (reduce ? 1 : 0.075)
      if (Math.abs(target.current - cur.current) < 0.0015) cur.current = target.current
      if (S) draw(S.ctx, S.w, S.h, cur.current, time, Math.min(S.w, S.h) / 330)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      mq.removeEventListener('change', readPalette)
    }
  }, [])

  const d = DATA[mode]

  return (
    <div className="demo">
        <div className="stage">
          <div className="stage-label">
            <span className="stage-state">{d.state}</span>
            <span className={`chip ${d.cls}`}>
              <i className="dot" />
              {d.badge}
            </span>
          </div>
          <canvas
            ref={stage}
            role="img"
            aria-label={
              mode === 'hold'
                ? 'A pufferfish inflated with spines out, the wallet in its protected two-of-two state.'
                : 'A pufferfish at rest, the wallet in its everyday one-of-two state.'
            }
          />
          <div className="switch">
            <button aria-pressed={mode === 'pass'} onClick={() => setMode('pass')}>
              Rebalance 2 SUI<small>routine · settles</small>
            </button>
            <button aria-pressed={mode === 'hold'} onClick={() => setMode('hold')}>
              Claim the airdrop<small>unknown payee · held</small>
            </button>
          </div>
        </div>

        <div className="receipt">
          <div className="receipt-hd">
            <b>{d.title}</b>
            <span className={`chip ${d.cls}`}>
              <i className="dot" />
              {d.chip}
            </span>
          </div>
          <div className="receipt-body">
            <dl style={{ margin: 0 }}>
              {d.rows.map(([k, v, lg]) => (
                <div className="rrow" key={k}>
                  <dt>{k}</dt>
                  <dd className={lg ? 'lg' : undefined}>{v}</dd>
                </div>
              ))}
            </dl>
            <div className={`quote ${d.cls}`}>
              <span className="src">{d.src}</span>
              <span className="txt">{d.quote}</span>
            </div>
          </div>
          <div className="acts">
            {d.acts.map(([label, cls]) => (
              <div className={`act ${cls}`} key={label}>
                {label}
              </div>
            ))}
          </div>
        </div>
    </div>
  )
}
