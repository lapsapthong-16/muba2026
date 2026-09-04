import type { Metadata } from 'next'
import { CSS } from '../landing/style'
import Mark from '../landing/mark'

export const metadata: Metadata = {
  title: 'Puffer docs',
  description: 'Set up the wallet, connect an agent, and read what each rule and error code means.',
}

/**
 * Documentation, sharing the landing page's tokens so the two read as one product.
 *
 * Written for two readers at once — the human setting limits and the agent spending inside them —
 * because in this product they are looking at the same objects from opposite sides. Every code and
 * limit here is the one the server actually applies; nothing is illustrative.
 */

const TOOLS: [string, string, string][] = [
  ['wallet_status', 'reads', 'Address, balance, guardrails, and a preflight of what will fail before you try it. Takes wait_for_ready_ms to block until a human finishes setup.'],
  ['wallet_markets', 'reads', 'Live quotes across several sizes, and the smallest the book will fill right now. Call before any swap — the floor moves with the resting orders.'],
  ['wallet_transfer', 'commits', 'Send SUI. Pass dry_run: true to rehearse the whole pipeline and discard it.'],
  ['wallet_swap', 'commits', 'Trade on DeepBook. Quoted first; the slippage floor is set by the wallet, never by the agent.'],
  ['wallet_approval_status', 'reads', 'Poll a held decision. Terminal states are executed, denied, expired.'],
  ['wallet_history', 'reads', 'Past decisions, each with the reason the agent gave and a digest where money moved.'],
  ['wallet_explain_last', 'reads', 'Which rules fired on the most recent decision, and why.'],
]

const CODES: [string, string, string][] = [
  ['WEEKLY_CAP', 'no', 'Over the weekly budget. Cannot be approved away — hardware cannot create budget.'],
  ['PER_TX_LIMIT', 'no', 'Over the single-payment limit. A human can approve it, and raise the limit with the same tap.'],
  ['UNKNOWN_RECIPIENT', 'no', 'The payee is not on the approved list. A human can approve and optionally add them.'],
  ['CAPABILITY_TRANSFER', 'no', 'A permission object is leaving the wallet. Always needs a human.'],
  ['AWAITING_APPROVAL', 'no', 'Nothing was sent. Poll rather than resubmit — a retry creates a second approval, it does not bypass the first.'],
  ['BELOW_MARKET_MINIMUM', 'yes', 'The book fills nothing at this size. Call wallet_markets and try larger.'],
  ['BUILD_FAILED', 'yes', 'Could not be constructed, usually insufficient balance. Check wallet_status.'],
  ['SIMULATION_FAILED', 'yes', 'It fails when test-run against the live chain. Often a stale balance or a changed pool.'],
  ['RISK_MODEL_UNAVAILABLE', 'yes', 'The model did not answer in time, so this escalated rather than passed. Not a refusal.'],
]

function Code({ children }: { children: React.ReactNode }) {
  return <span className="mono" style={{ fontSize: '.82rem' }}>{children}</span>
}

export default function Docs() {
  return (
    <div className="pf">
      <style dangerouslySetInnerHTML={{ __html: CSS + EXTRA }} />

      <div className="wrap">
        <header className="mast">
          <div className="wordmark">
            <Mark />
            Puffer
          </div>
          <nav>
            <a href="/landing">Overview</a>
            <a href="/dashboard" className="hide-sm">Dashboard</a>
            <span className="net">Docs</span>
          </nav>
        </header>

        <div style={{ padding: '54px 0 20px' }}>
          <span className="eyebrow">Documentation</span>
          <h1 style={{ fontSize: 'clamp(2rem,4vw,3rem)', fontWeight: 900, margin: '12px 0 14px', lineHeight: 1.02 }}>
            Set it up, connect an agent, read the rules.
          </h1>
          <p className="lede">
            Two readers, one page: the human who sets the limits and the agent that spends inside
            them. Every code and number here is the one the server actually applies.
          </p>
        </div>
      </div>

      {/* ---------- 1 · setup ---------- */}
      <section id="setup">
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">1 · Setup</span>
            <h2>One call from the agent, then one thing only you can do.</h2>
            <p>
              The agent creates the account and gets its own credentials. It cannot finish setup:
              deriving the addresses needs a public key that exists only on your hardware, and every
              setup route refuses a request carrying an <Code>Authorization</Code> header at all.
            </p>
          </div>

          <div className="term">
            <div className="term-hd">Terminal</div>
            <pre>
{`# the agent's first and only setup call
curl -sX POST $BASE/api/onboard \\
  -H 'content-type: application/json' \\
  -d '{"agent":"hermes","pass":"'"$ONBOARD_PASS"'"}'

# → bearer, MCP config, and a setup link for you.
#   The agent prints the link and stops.

# already have a wallet? point the config at it —
# onboarding again mints a new key and new addresses
npm run connect -- hw_live_…`}
            </pre>
          </div>

          <div className="doc-grid">
            <div className="doc-card">
              <h3>Connect the Ledger</h3>
              <p>
                Desktop Chrome or Edge, because reading the device needs WebHID. Both addresses are
                derived from your device key plus ours, and the wallet is funded in the same step.
              </p>
            </div>
            <div className="doc-card">
              <h3>Pick a limit, in dollars</h3>
              <p>
                Say <Code>$30</Code> a payment rather than inventing a SUI figure. The rate is taken
                from the DeepBook mid and pinned when you set it, so the limit stays a fixed number
                the gate applies in microseconds.
              </p>
            </div>
            <div className="doc-card">
              <h3>Get told when something waits</h3>
              <p>
                Point <Code>notifyUrl</Code> at any webhook you own. The message carries a decline
                link that works from any device, and no approve link &mdash; approving needs the
                Ledger.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- 2 · modes ---------- */}
      <section id="modes">
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">2 · Modes</span>
            <h2>Pick a word, not four numbers.</h2>
            <p>
              Nobody can choose a per-transaction limit sensibly on their first day, and a bad guess
              is invisible until it bites. A mode widens <em>who</em> you can pay and{' '}
              <em>how much at once</em>. It never removes a check.
            </p>
          </div>

          <div className="tablewrap">
            <table className="doc-table">
              <thead>
                <tr><th></th><th>Reef</th><th>Open Water</th></tr>
              </thead>
              <tbody>
                <tr><td>Pays unlisted addresses</td><td>needs your Ledger</td><td>yes</td></tr>
                <tr><td>Per transaction</td><td>2.5 SUI</td><td>10 SUI</td></tr>
                <tr><td>Weekly cap</td><td>10 SUI</td><td>50 SUI</td></tr>
                <tr><td>Simulated</td><td>always</td><td>always</td></tr>
                <tr><td>Risk scored</td><td>always</td><td>always</td></tr>
              </tbody>
            </table>
          </div>
          <p className="fine">
            Explicit figures still override a preset, and a dollar limit overrides both. There is
            deliberately no mode that signs whatever it is handed.
          </p>
        </div>
      </section>

      {/* ---------- 3 · tools ---------- */}
      <section id="tools">
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">3 · Tools</span>
            <h2>Seven, and the list is the whole capability surface.</h2>
            <p>
              Note what is absent: nothing writes policy, nothing approves an approval, and there is
              no <Code>network</Code> parameter anywhere &mdash; a field that does not exist cannot be
              prompt-injected or defaulted wrong.
            </p>
          </div>

          <div className="tablewrap">
            <table className="doc-table">
              <thead><tr><th>Tool</th><th>Effect</th><th>What it does</th></tr></thead>
              <tbody>
                {TOOLS.map(([name, effect, body]) => (
                  <tr key={name}>
                    <td><Code>{name}</Code></td>
                    <td>
                      <span className={`chip ${effect === 'commits' ? 'hold' : 'pass'}`}>{effect}</span>
                    </td>
                    <td>{body}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---------- 4 · outcomes ---------- */}
      <section id="codes">
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">4 · Outcomes</span>
            <h2>Read the field, not the status line.</h2>
            <p>
              Every result carries <Code>funds_moved</Code>, on errors too, and a{' '}
              <Code>digest</Code> is absent rather than null unless money actually moved. A blocked
              transaction is a successful 200.
            </p>
          </div>

          <div className="tablewrap">
            <table className="doc-table">
              <thead><tr><th>Code</th><th>Retry?</th><th>What to do</th></tr></thead>
              <tbody>
                {CODES.map(([code, retriable, body]) => (
                  <tr key={code}>
                    <td><Code>{code}</Code></td>
                    <td className={retriable === 'yes' ? 'yes' : 'no'}>{retriable}</td>
                    <td>{body}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fine">
            Retriable means the same call, unchanged, could succeed later. A busy risk model
            qualifies; a payment over your limit does not &mdash; it needs a human, not patience.
          </p>
        </div>
      </section>

      {/* ---------- 5 · approving ---------- */}
      <section id="approving">
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">5 · Approving</span>
            <h2>The tap that sends it can also stop it asking again.</h2>
            <p>
              A held payment shows what would keep this class of transaction from stopping next time
              &mdash; raise the limit, or add the payee &mdash; and the tick rides along with the
              hardware signature.
            </p>
          </div>
          <div className="doc-grid">
            <div className="doc-card">
              <h3>The server proposes the number</h3>
              <p>
                Derived from the transaction already in front of you. The request carries booleans
                only, so a compromised page has no amount or address to inflate.
              </p>
            </div>
            <div className="doc-card">
              <h3>Hardware must be present</h3>
              <p>
                Which makes this a harder way to widen a limit than the settings page, not a shortcut
                around one.
              </p>
            </div>
            <div className="doc-card">
              <h3>The weekly cap is the ceiling</h3>
              <p>
                A per-transaction limit can rise to meet it and no further. The floor is re-checked
                at the moment the money moves, not only when the hold was created.
              </p>
            </div>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <span>Puffer &mdash; an agent wallet gated by simulation, limits and a hardware key.</span>
          <span className="mono">
            <a href="/landing">Overview</a> · <a href="/dashboard">Dashboard</a> · Sui testnet
          </span>
        </div>
      </footer>
    </div>
  )
}

/** Docs-only additions on top of the shared tokens. */
const EXTRA = `
.pf .doc-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:28px}
@media(max-width:820px){.pf .doc-grid{grid-template-columns:1fr}}
.pf .doc-card{border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:20px}
.pf .doc-card h3{font-size:1rem;font-weight:700;margin-bottom:8px}
.pf .doc-card p{font-size:.94rem;color:var(--ink-2)}
.pf .tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.pf .doc-table{width:100%;border-collapse:collapse;font-size:.94rem;min-width:560px}
.pf .doc-table th{text-align:left;font-family:var(--mono);font-size:.64rem;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-3);padding:12px 16px;border-bottom:1px solid var(--line);font-weight:500}
.pf .doc-table td{padding:12px 16px;border-bottom:1px solid var(--line);color:var(--ink-2);vertical-align:top}
.pf .doc-table tr:last-child td{border-bottom:none}
.pf .doc-table td:first-child{color:var(--ink);white-space:nowrap}
.pf .doc-table td.yes{color:var(--calm);font-family:var(--mono);font-size:.8rem}
.pf .doc-table td.no{color:var(--alert);font-family:var(--mono);font-size:.8rem}
.pf .fine{margin-top:14px;font-size:.92rem;color:var(--ink-2);max-width:70ch}
.pf .term pre{white-space:pre}
.pf footer a,.pf .mast nav a{text-decoration:none}
.pf footer a:hover{text-decoration:underline}
`
