type Integration = {
  name: string;
  description: string;
  icon: "codex" | "claude" | "hermes" | "mcp" | "openclaw";
};

const integrations: Integration[] = [
  { name: "Codex", description: "Run Puffer actions inside Codex.", icon: "codex" },
  { name: "Claude Code", description: "Native Puffer support in Claude Code.", icon: "claude" },
  { name: "Hermes", description: "Autonomous trading with Hermes.", icon: "hermes" },
  { name: "MCP", description: "Plug into any MCP compatible stack.", icon: "mcp" },
  { name: "OpenClaw", description: "Secure execution via OpenClaw.", icon: "openclaw" },
];

function IntegrationIcon({ kind }: { kind: Integration["icon"] }) {
  if (kind === "codex") {
    return <svg viewBox="0 0 100 100" aria-hidden="true"><rect x="15" y="13" width="70" height="72" rx="15" fill="none" stroke="currentColor" strokeWidth="8"/><path d="m33 35 14 15-14 15M54 65h16" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  }
  if (kind === "claude") {
    return <svg viewBox="0 0 100 100" aria-hidden="true"><g fill="currentColor"><path d="m42 10 10 28 20-20-12 31 31-5-29 14 21 19-30-10 1 29-13-27-15 25 4-31-29 8 25-20-26-13 32 4-7-31 19 24Z"/></g></svg>;
  }
  if (kind === "hermes") {
    return <svg viewBox="0 0 120 80" aria-hidden="true"><path d="M9 50h33l-17-12h48l-8-11h38L89 40l23 4-21 5 7 13H64L50 75H32l6-14H18Z" fill="currentColor"/><circle cx="84" cy="35" r="3" fill="#1b1b1b"/></svg>;
  }
  if (kind === "mcp") {
    return <svg viewBox="0 0 100 100" aria-hidden="true"><g fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"><path d="m24 70 42-48a12 12 0 0 1 17 17L60 62"/><path d="m17 52 39 40a12 12 0 0 0 17-17L35 37"/><path d="m42 17 41 40"/></g></svg>;
  }
  return <svg viewBox="0 0 100 100" aria-hidden="true"><path d="M27 88 9 72l15-12-7-23 23-17 19 4 15-14 13 21-2 25-17 23-22 7-19-2Z" fill="currentColor"/><path d="M43 26c-3 15-1 24 7 29 8 5 18 2 28-8-1 20-10 33-26 37-16 5-29-4-36-25 9 4 17 2 24-5 5-5 6-14 3-28Z" fill="#1c1d1c"/></svg>;
}

export function IntegrationsSection() {
  return (
    <section className="integrations-section" id="integrations" aria-labelledby="integrations-title">
      <header className="integrations-heading">
        <div>
          <h2 id="integrations-title">BUILT FOR<br />YOUR AGENT</h2>
          <p>Puffer Agent Wallet connects with the tools<br className="integrations-copy-break" /> your agent already uses.</p>
        </div>
        <div className="integrations-swimmer" aria-hidden="true"><Image src="/assets/puffer/puffer-path.png" alt="" width={620} height={420} priority /></div>
      </header>
      <div className="integration-grid">
        {integrations.map((integration) => (
          <article className="integration-card" key={integration.name}>
            <div className={`integration-icon integration-icon--${integration.icon}`}><IntegrationIcon kind={integration.icon} /></div>
            <h3>{integration.name}</h3>
            <p>{integration.description}</p>
            <span className="integration-link">{integration.name === "Hermes" || integration.name === "MCP" || integration.name === "OpenClaw" ? "COMING SOON" : "INTEGRATION"}</span>
          </article>
        ))}
      </div>
    </section>
  );
}
import Image from "next/image";
