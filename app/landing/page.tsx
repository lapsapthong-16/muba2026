import type { Metadata } from 'next'
import PufferDemo from './demo'
import Mark from './mark'
import { CSS } from './style'

export const metadata: Metadata = {
  title: 'Puffer — an agent wallet on Sui',
  description:
    'Your agent spends inside limits you set. When a transaction falls outside them, it re-forms at an address our key cannot move alone — and waits for your Ledger.',
}

/**
 * The landing page, as a real route.
 *
 * The CSS is injected verbatim and scoped to `.pf`, rather than converted to Tailwind: the palette
 * and type here are a deliberate visual identity, and translating it into utility classes would
 * lose the token structure that makes both themes work — every colour is defined once on the
 * scope and redefined for dark, so nothing can end up as one theme's text on the other's ground.
 */
export default function Landing() {
  return (
    <div className="pf">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div className="wrap">
        <header className="mast">
          <div className="wordmark">
            <Mark />
            Puffer
          </div>
          <nav>
            <a href="#custody" className="hide-sm">Custody</a>
            <a href="#gate" className="hide-sm">The gate</a>
            <a href="#automations" className="hide-sm">Automations</a>
            <a href="/docs">Docs</a>
            <span className="net">Sui testnet</span>
          </nav>
        </header>

        <div className="hero">
          <div className="hero-top">
            <div>
              <span className="eyebrow">Agent wallet · Sui</span>
              <h1>Most of the time, it&rsquo;s just a wallet.</h1>
            </div>
            <div>
              <p className="lede">
                Puffer lets your agent spend inside limits you set. The moment a transaction falls
                outside them, it re-forms at an address our key cannot move alone &mdash; and waits
                for your Ledger.
              </p>
              <div className="cta-row">
                <a className="btn primary" href="/docs">Get started</a>
                <a className="btn ghost" href="#automations">See it run on a schedule</a>
              </div>
            </div>
          </div>

          <PufferDemo />
        </div>
      </div>

      <div className="strip">
        <div className="wrap">
          <span className="lbl">Speaks MCP, so it plugs into</span>
          <span>Claude&nbsp;Code</span>
          <span>Codex</span>
          <span>hermes</span>
          <span>anything that speaks MCP</span>
        </div>
      </div>

      <section id="custody">
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">Custody</span>
            <h2>Two addresses, one Ledger, and a threshold that is real.</h2>
            <p>
              A Sui multisig threshold is hashed into the address itself, so it can never be
              conditional. Puffer uses that rather than fighting it: routine spending lives where our
              key alone suffices, and everything else is re-issued where it does not.
            </p>
          </div>

          <div className="custody">
            <div className="addr spending">
              <div className="addr-hd"><h3>Spending</h3><span className="thresh">1&#8202;/&#8202;2</span></div>
              <p>
                Holds the float. Our server key satisfies it alone, so a payment inside your limits
                settles in about two seconds with nobody woken up.
              </p>
              <table className="weights">
                <thead><tr><th>Signer</th><th>Weight</th></tr></thead>
                <tbody>
                  <tr><td>Platform key</td><td>1</td></tr>
                  <tr><td>Your Ledger</td><td>1</td></tr>
                  <tr><td>Threshold</td><td>1</td></tr>
                </tbody>
              </table>
              <div className="hash">0xc370d09a630f416b68d96197d6ee9d4f94ef16bb834b4ec6844c50db2307bf37</div>
            </div>

            <div className="addr protected">
              <div className="addr-hd"><h3>Protected</h3><span className="thresh">2&#8202;/&#8202;2</span></div>
              <p>
                Holds the bulk and receives every escalation. Validators reject our signature on its
                own &mdash; <span className="mono" style={{ fontSize: '.82rem' }}>Insufficient weight=1 threshold=2</span>{' '}
                &mdash; so the hardware approval is load-bearing, not ceremonial.
              </p>
              <table className="weights">
                <thead><tr><th>Signer</th><th>Weight</th></tr></thead>
                <tbody>
                  <tr><td>Platform key</td><td>1</td></tr>
                  <tr><td>Your Ledger</td><td>1</td></tr>
                  <tr><td>Recovery key</td><td>2</td></tr>
                  <tr><td>Threshold</td><td>2</td></tr>
                </tbody>
              </table>
              <div className="hash">0x033034563fc5765283e23f23fcc962180f5298acdfe209b9ca94b16ac0533e46</div>
            </div>
          </div>

          <div className="note">
            <b>Why the recovery key carries weight 2.</b> A plain 2-of-2 turns a lost or dead Ledger
            into permanent loss of everything protected &mdash; a larger expected loss than the
            attack being prevented. At weight 2 it can stand in alone, and it never touches a
            routine spend.
          </div>
        </div>
      </section>

      <section id="gate">
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">The gate</span>
            <h2>Simulation is the truth. The model only translates.</h2>
            <p>
              Your agent declares a typed intent &mdash; never raw bytes &mdash; and Puffer builds
              the transaction itself. A prompt-injected agent cannot smuggle a Move call past this,
              because it never had a way to write one.
            </p>
          </div>

          <div className="pipe">
            <div className="step">
              <span className="n">Build</span>
              <h3>From intent, never bytes</h3>
              <p>
                Recipient and amount are fields in a schema. There is no{' '}
                <span className="mono" style={{ fontSize: '.82rem' }}>network</span> parameter and no
                raw-transaction tool, so neither can be defaulted wrong or talked into changing.
              </p>
              <span className="meta">Gas sponsored · the wallet pays no fees</span>
            </div>
            <div className="step">
              <span className="n">Simulate</span>
              <h3>Ask the chain, not the agent</h3>
              <p>
                The exact bytes run against the live network. Balance changes per address, every
                package called, and any object leaving the wallet &mdash; including capabilities,
                which move no balance at all.
              </p>
              <span className="meta">≈100 ms · native simulateTransaction</span>
            </div>
            <div className="step">
              <span className="n">Judge</span>
              <h3>Rules first, model second</h3>
              <p>
                Deterministic limits decide, then the risk model scores what they cleared. It can
                escalate and never de-escalate, and an abstention escalates too &mdash; a model that
                is down cannot let anything through.
              </p>
              <span className="meta">MiniMax-M2.7 via Gonka · receipt kept</span>
            </div>
            <div className="step">
              <span className="n">Sign</span>
              <h3>Or don&rsquo;t</h3>
              <p>
                Cleared, it is signed and broadcast. Held, it is rebuilt from the protected address,
                re-simulated, and left for you &mdash; the bytes re-hashed and re-checked the moment
                before your device sees them.
              </p>
              <span className="meta">Approvals expire after 30 minutes</span>
            </div>
          </div>

          <div className="note">
            <b>The ordering is the security property.</b> The bytes that were simulated are the bytes
            that get hashed, the bytes your Ledger displays, and the bytes that execute. A sponsored
            transaction is rewritten when the gas station signs it, so the freeze happens after
            sponsorship &mdash; not before, which would bind us to bytes the network never sees.
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">Guardrails</span>
            <h2>Limits a hardware tap cannot widen.</h2>
            <p>
              You set these in a browser, in dollars if you like. Nothing in the agent&rsquo;s
              vocabulary can write them &mdash; if the agent could raise its own cap, the cap would be
              decorative. Some rules hold a transaction for you; others stop it outright, because
              hardware cannot create budget.
            </p>
          </div>

          <div className="rules">
            {[
              ['WEEKLY_CAP', 'Stops', 'stops', 'Spending past a rolling seven-day budget. Not escalatable: no tap creates money you did not budget.'],
              ['PER_TX_LIMIT', 'Holds', 'holds', 'A single payment over your ceiling. You can approve it — and raise the limit with the same tap.'],
              ['UNKNOWN_RECIPIENT', 'Holds', 'holds', 'Money reaching an address you never allow-listed, at any size. The gas sponsor is correctly not counted as a payee.'],
              ['UNKNOWN_PACKAGE', 'Holds', 'holds', 'A Move call into a contract outside your list. Object and type arguments don’t count — only real call targets.'],
              ['CAPABILITY_TRANSFER', 'Holds', 'holds', 'A permission object leaving the wallet. Balance changes cannot see this: handing over total authority moves zero coins.'],
              ['SIMULATION_FAILED', 'Stops', 'stops', 'We could not establish what the transaction does. Unknown is never treated as safe.'],
            ].map(([code, verdict, cls, body]) => (
              <div className={`rule ${cls}`} key={code}>
                <div className="tag">
                  <code>{code}</code>
                  <span className="verdict">{verdict}</span>
                </div>
                <p>{body}</p>
              </div>
            ))}
          </div>

          <div className="note">
            <b>Co-signed on a Ledger Flex, on-chain.</b> The trade settled at{' '}
            <span className="mono" style={{ fontSize: '.82rem' }}>GbCZqDq1wW31HrPRPnsgw8FMRUFffrseFacoNruLPCKV</span>{' '}
            &mdash; 2.531500 to 0.629125 SUI, 1.3756 DBUSDC back, gas paid by the sponsor. The
            escalation settled at{' '}
            <span className="mono" style={{ fontSize: '.82rem' }}>4XMjg6B8syvRAL97hNucgxY7sb8btAuPiNWgU1Q5nD4g</span>{' '}
            &mdash; sender the 2-of-2, two signatures, one of them from a device that rendered the
            amount and destination in full rather than a bare hash.
          </div>
        </div>
      </section>

      <section id="automations">
        <div className="wrap">
          <div className="head">
            <span className="eyebrow">Automations</span>
            <h2>A scheduler for intents, not a way around the gate.</h2>
            <p>
              Draw what should happen and when: a trigger, what must be true, and what to do. Every
              action is an ordinary wallet call, so it is still built, still simulated, still checked
              &mdash; an automation can never do something your agent was not already allowed to do.
            </p>
          </div>

          <div className="auto">
            <div className="flow">
              <div className="flow-row">
                <div className="step-card t"><span className="w">When</span><b>Every morning</b><span className="d">09:00, your timezone</span></div>
                <span className="arr">&rarr;</span>
                <div className="step-card c"><span className="w">Only if</span><b>Price below</b><span className="d">SUI under $0.70</span></div>
              </div>
              <div className="acts">
                <div className="flow-row">
                  <span className="arr" style={{ visibility: 'hidden' }}>&rarr;</span>
                  <div className="step-card a"><span className="w">Then</span><b>Swap on DeepBook</b><span className="d">2 SUI &rarr; DBUSDC</span></div>
                </div>
                <div className="flow-row">
                  <span className="arr" style={{ visibility: 'hidden' }}>&rarr;</span>
                  <div className="step-card a"><span className="w">Then</span><b>Tell me</b><span className="d">post to your webhook</span></div>
                </div>
              </div>
              <p className="flow-foot">
                <b>In words.</b> Every morning, only if SUI is under $0.70, swap 2 SUI on DeepBook,
                then tell me.
              </p>
            </div>

            <div>
              <div className="note" style={{ marginTop: 0 }}>
                <b>The limits still bind.</b> An automation that tries to pay someone you never
                approved gets held, exactly as if your agent had typed it. One that exceeds the
                weekly cap is refused outright, and no tap can widen that.
              </div>
              <div className="note">
                <b>You can watch it think.</b> Each run leaves a decision with the reason it gave,
                the rule that decided it, and a digest where money moved &mdash; so &ldquo;what did my
                agent do overnight&rdquo; has an answer you can read.
              </div>
              <div className="note">
                <b>Draft.</b> The canvas is built and the shape is settled; nothing is scheduled yet.
                Try it on the <a href="/dashboard" style={{ textDecoration: 'underline' }}>dashboard</a>.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="limits">
            <span className="eyebrow">Read this before you trust it</span>
            <h2>What Puffer does not protect you from.</h2>
            <p>A security product that lists only its strengths is telling you half of something.</p>
            <div className="limit-list">
              <div className="limit">
                <b>Us</b>
                <p>
                  The signing key for the spending address lives on our server. Puffer protects you
                  from your agent, not from us. The protected address is the part we cannot move
                  alone.
                </p>
              </div>
              <div className="limit">
                <b>A transaction your rules allow</b>
                <p>
                  Allow-list an address, set a high enough cap, and an agent talked into paying that
                  address will pay it. The guardrails are yours; so are their gaps.
                </p>
              </div>
              <div className="limit">
                <b>Anything the device cannot render</b>
                <p>
                  The Sui app clear-signs a small set of transaction shapes. We build the readable
                  shape whenever the wallet&rsquo;s funds allow &mdash; but a wallet funded in a way
                  that forces a Move call shows your Ledger a hash, and a hash is not informed
                  consent.
                </p>
              </div>
              <div className="limit">
                <b>A risk model having an off day</b>
                <p>
                  Which is why it can only ever escalate. Every deterministic limit is checked before
                  the model is asked, and it is never consulted to overturn one.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <span>Puffer &mdash; an agent wallet gated by simulation, limits and a hardware key.</span>
          <span className="mono">
            <a href="/docs">Docs</a> · <a href="/dashboard">Dashboard</a> · Sui testnet
          </span>
        </div>
      </footer>
    </div>
  )
}
