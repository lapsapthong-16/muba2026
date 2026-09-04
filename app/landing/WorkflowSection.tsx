type WorkflowStep = {
  number: string;
  title: string;
  description: string;
  variant: "connect" | "rules" | "monitor";
};

const steps: WorkflowStep[] = [
  {
    number: "1",
    title: "CONNECT",
    description: "Connect your wallet\nto Puffer Agent.",
    variant: "connect",
  },
  {
    number: "2",
    title: "SET RULES",
    description: "Define spend limits\nand allowlists.",
    variant: "rules",
  },
  {
    number: "3",
    title: "LET IT RUN",
    description: "Puffer monitors every move.\nYou stay protected.",
    variant: "monitor",
  },
];

function BrowserChrome() {
  return (
    <header className="workflow-window-bar" aria-hidden="true">
      <span className="workflow-window-dots"><i /><i /><i /></span>
      <span className="workflow-window-puffer">☀</span>
    </header>
  );
}

function WorkflowPuffer({ variant }: { variant: WorkflowStep["variant"] }) {
  const asset = variant === "connect" ? "/assets/puffer/puffer-calm-small.png" : variant === "rules" ? "/assets/puffer/puffer-alert-large.png" : "/assets/puffer/puffer-alert-coral.png";
  return (
    <div className={`workflow-puffer workflow-puffer--${variant}`} aria-hidden="true"><Image src={asset} alt="" width={320} height={220} /></div>
  );
}

function WalletMockup() {
  return (
    <div className="workflow-window workflow-window--connect">
      <BrowserChrome />
      <div className="workflow-terminal">
        <p><strong>&gt;_</strong> <span>wallet connected</span></p>
        <p>network: sui mainnet</p>
        <b className="workflow-terminal-check">✓</b>
      </div>
    </div>
  );
}

function RulesMockup() {
  return (
    <div className="workflow-window workflow-window--rules">
      <BrowserChrome />
      <div className="workflow-rules-content">
        <p className="workflow-label">Spend limit (24h)</p>
        <div className="workflow-limit"><span>💧 2 SUI</span><b>⌕</b></div>
        <p className="workflow-label">Allowlist</p>
        <div className="workflow-chips"><span>◉ Scallop</span><span>◉ Cetus</span><span>◉ Turbos</span></div>
        <p className="workflow-add">＋ Add address</p>
      </div>
    </div>
  );
}

function MonitorMockup() {
  return (
    <div className="workflow-window workflow-window--monitor">
      <BrowserChrome />
      <div className="workflow-monitor-content">
        <p className="workflow-label">Transaction detected</p>
        <div className="workflow-danger"><b>⚠</b><span><strong>Unrecognized address</strong><small>sui_unknown...9f2a</small></span></div>
        <button type="button" className="workflow-block-button">BLOCK / ALERT</button>
      </div>
    </div>
  );
}

function StepMockup({ variant }: { variant: WorkflowStep["variant"] }) {
  if (variant === "connect") return <WalletMockup />;
  if (variant === "rules") return <RulesMockup />;
  return <MonitorMockup />;
}

/** The three-step Puffer wallet setup and monitoring workflow. */
export default function WorkflowSection() {
  return (
    <section className="workflow-section" aria-labelledby="workflow-heading">
      <div className="workflow-inner">
        <h2 id="workflow-heading">HOW PUFFER WORKS</h2>
        <ol className="workflow-steps">
          {steps.map((step) => (
            <li className={`workflow-step workflow-step--${step.variant}`} key={step.number}>
              <div className="workflow-step-copy">
                <span className="workflow-number">{step.number}</span>
                <div><h3>{step.title}</h3><p>{step.description}</p></div>
              </div>
              <WorkflowPuffer variant={step.variant} />
              <StepMockup variant={step.variant} />
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
import Image from "next/image";
