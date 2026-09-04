import type { ReactNode } from "react";
import Image from "next/image";

type ActionButtonProps = {
  children: ReactNode;
  className?: string;
};

function ActionButton({ children, className = "" }: ActionButtonProps) {
  return <button className={`landing-action ${className}`.trim()} type="button">{children}</button>;
}

function PufferGlyph({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`puffer-glyph ${className}`.trim()}>☀</span>;
}

function ProtectionIcon({ children, tone = "lime" }: { children: ReactNode; tone?: "lime" | "coral" }) {
  return <span aria-hidden="true" className={`protection-icon protection-icon--${tone}`}>{children}</span>;
}

const integrations = [
  { name: "Codex", detail: "Run Puffer actions inside Codex.", icon: ">_" },
  { name: "Claude Code", detail: "Native Puffer support in Claude Code.", icon: "✳" },
  { name: "Hermes", detail: "Autonomous trading with Hermes.", icon: "➤" },
  { name: "MCP", detail: "Plug into any MCP compatible stack.", icon: "〽" },
  { name: "OpenClaw", detail: "Secure execution via OpenClaw.", icon: "◖" },
];

export function IntegrationsSection() {
  return <section className="landing-section integrations-section" aria-labelledby="integrations-heading">
    <div className="landing-section__inner">
      <div className="integrations-heading-row">
        <div>
          <h2 id="integrations-heading" className="landing-display-heading">BUILT FOR<br />YOUR AGENT</h2>
          <p className="landing-intro">Puffer Agent Wallet connects with the tools<br className="desktop-break" /> your agent already uses.</p>
        </div>
        <div className="integration-swim" aria-hidden="true"><PufferGlyph /><span className="integration-swim__trail">- - - - - -</span></div>
      </div>
      <div className="integration-grid">
        {integrations.map((integration) => <article className="integration-card" key={integration.name}>
          <span aria-hidden="true" className={`integration-card__icon integration-card__icon--${integration.name.toLowerCase().replace(" ", "-")}`}>{integration.icon}</span>
          <h3>{integration.name}</h3><p>{integration.detail}</p>
          <ActionButton className="integration-card__action">INTEGRATION</ActionButton>
        </article>)}
      </div>
      <ActionButton className="explore-integrations">EXPLORE INTEGRATIONS <span aria-hidden="true">→</span></ActionButton>
    </div>
  </section>;
}

const workflow = [
  { number: "1", title: "CONNECT", copy: <>Connect your wallet<br />to Puffer Agent.</>, visual: <div className="terminal-card"><span className="terminal-card__dots"><i /><i /><i /></span><p><b>&gt;_ &nbsp;wallet connected</b><br /><br />&nbsp;&nbsp;&nbsp;network: sui mainnet</p><strong>✓</strong></div> },
  { number: "2", title: "SET RULES", copy: <>Define spend limits<br />and allowlists.</>, visual: <div className="rules-card"><p>Spend limit (24h)</p><div className="rules-card__input">💧 2 SUI <span>⌕</span></div><p>Allowlist</p><div className="allow-list"><b>◉ Scallop</b><b>◉ Cetus</b><b>◉ Turbos</b></div><small>＋ Add address</small></div> },
  { number: "3", title: "LET IT RUN", copy: <>Puffer monitors every move.<br />You stay protected.</>, visual: <div className="alert-card"><p>Transaction detected</p><div className="alert-card__warning">⚠ <span>Unrecognized address<br /><small>sui_unknown...9f2a</small></span></div><ActionButton className="alert-card__action">BLOCK / ALERT</ActionButton></div> },
];

export function HowItWorksSection() {
  return <section className="landing-section workflow-section" aria-labelledby="workflow-heading">
    <div className="landing-section__inner"><h2 id="workflow-heading" className="landing-display-heading workflow-heading">HOW PUFFER WORKS</h2>
      <div className="workflow-grid">{workflow.map((step) => <article className="workflow-step" key={step.number}>
        <div className="workflow-step__copy"><strong>{step.number}</strong><div><h3>{step.title}</h3><p>{step.copy}</p></div></div>
        <PufferGlyph className="workflow-step__fish" />{step.visual}
      </article>)}</div>
    </div>
  </section>;
}

const reefRows = [["♟", "Recipients", "Allowlisted only", "✓"], ["♨", "Per payment", "2.5 SUI", "2.5 SUI"], ["▣", "Weekly cap", "10 SUI", "10 SUI"]] as const;
const waterRows = [["♟", "Recipients", "Any recipient", "✓"], ["♨", "Per payment", "10 SUI", "10 SUI"], ["▣", "Weekly cap", "50 SUI", "50 SUI"]] as const;

type ModeRows = readonly (readonly [string, string, string, string])[];

function ModeCard({ mode, rows }: { mode: "reef" | "water"; rows: ModeRows }) {
  const open = mode === "water";
  return <article className={`mode-card mode-card--${mode}`}>
    <header><div><ProtectionIcon tone={open ? "coral" : "lime"}>{open ? "≋" : "♣"}</ProtectionIcon><h3>{open ? "OPEN WATER" : "REEF"}</h3><p>{open ? "More power, more risk" : "Safe by default"}</p></div><PufferGlyph /></header>
    <div className="mode-card__body">{rows.map(([icon, label, detail, value]) => <div className="mode-row" key={label}><ProtectionIcon tone={open ? "coral" : "lime"}>{icon}</ProtectionIcon><p><b>{label}</b><br />{detail}</p><span className="mode-value">{value}</span></div>)}</div>
    <footer>{open ? <><ProtectionIcon tone="coral">⚠</ProtectionIcon><span>Use with caution</span><b>▣ &nbsp; Needs Ledger</b></> : <><ProtectionIcon>⬟</ProtectionIcon><span>Great for everyday automation</span></>}</footer>
  </article>;
}

export function ProtectionSection() {
  return <section className="landing-section protection-section" aria-labelledby="protection-heading">
    <div className="landing-section__inner"><div className="protection-lead"><div><h2 id="protection-heading" className="landing-display-heading">YOUR AGENT<br />STAYS IN LINE</h2><p className="landing-intro">Two modes. Built-in guardrails.</p></div><Image className="protection-lead__fish" src="/assets/puffer/puffer-path.png" alt="" width={620} height={420} priority /></div>
      <div className="mode-grid"><ModeCard mode="reef" rows={reefRows} /><ModeCard mode="water" rows={waterRows} /></div>
      <p className="guardrails-note"><ProtectionIcon>⬟</ProtectionIcon> Guardrails keep your agent helpful — not harmful.</p>
    </div>
  </section>;
}

export function PufferChecksSection() {
  return <section className="landing-section checks-section" aria-labelledby="checks-heading">
    <div className="landing-section__inner"><div className="checks-top"><h2 id="checks-heading" className="landing-display-heading">PUFFER CHECKS<br />EVERY MOVE</h2><div aria-hidden="true" className="checks-fish"><Image src="/assets/puffer/puffer-alert-hd.png" alt="" width={900} height={450} priority /></div></div>
      <div className="checks-grid"><article className="checks-card"><h3><b>1</b> SIMULATE</h3><p>See the impact before you approve.</p><ul><li>💧 <span>SUI Balance</span><strong>-0.002 SUI</strong></li><li>💧 <span>wSUI Balance</span><strong>+0.010 wSUI</strong></li><li>💲 <span>DBUSDC Balance</span><strong>+2.000 DBUSDC</strong></li><li>☆ <span>Point Balance</span><strong>+15.2 PTS</strong></li></ul></article><article className="checks-card risk-card"><h3><b>2</b> SCORE RISK</h3><p>Puffer scores risk from 0 (safe) to 100 (risky).</p><div className="risk-meter" aria-label="Risk score: 87 out of 100"><span>87<small>HIGH RISK</small></span></div></article><article className="checks-card ledger-card"><h3><b>3</b> APPROVE OR STOP</h3><p>Use your Ledger to continue safely.</p><div className="ledger-logo">⌗ &nbsp; LEDGER</div><ActionButton className="approve-action">✓ &nbsp; APPROVE WITH LEDGER</ActionButton><ActionButton className="stop-action">× &nbsp; STOP TRANSACTION</ActionButton></article></div>
    </div>
  </section>;
}

export function FinalCtaSection() {
  return <section className="landing-section final-cta-section" aria-labelledby="final-cta-heading"><div className="landing-section__inner final-cta"><div><h2 id="final-cta-heading" className="landing-display-heading">LET YOUR<br />AGENT RUN.</h2><p className="landing-intro">You keep the final say when Puffer puffs.</p><ActionButton className="setup-puffer">SET UP PUFFER</ActionButton></div><div aria-hidden="true" className="final-cta__art"><Image src="/assets/puffer/puffer-calm-to-alert.png" alt="" width={900} height={450} priority /><svg className="growth-arrow" viewBox="0 0 240 120"><path d="M18 104C40 35 75 15 133 22c28 3 52 12 72 1"/><path d="m183 12 24 11-22 15"/></svg></div></div></section>;
}
