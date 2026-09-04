"use client";

import { useState } from "react";
import Image from "next/image";
import { IntegrationsSection } from "./landing/IntegrationsSection";
import WorkflowSection from "./landing/WorkflowSection";
import { FinalCtaSection, PufferChecksSection } from "./landing/ProtectionSections";

// Retained as a vector fallback for future responsive variants.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function Puffer({ className = "" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 800 560" aria-hidden="true"><g fill="currentColor"><path d="M145 262c-23-11-37-30-38-58 30 10 56 28 76 50l-38 8Z"/><path d="m209 175 12-78 63 58-75 20Z"/><path d="m302 125 36-86 42 84-78 2Z"/><path d="m408 125 70-80 16 90-86-10Z"/><path d="m514 170 96-64-9 98-87-34Z"/><path d="m615 250 102-32-37 88-65-56Z"/><path d="m654 344 116 5-71 69-45-74Z"/><path d="m644 433 105 52-85 36-20-88Z"/><path d="M683 500c62 10 97 43 103 92-48 3-82-14-110-51l7-41Z"/><path d="M170 298c86-117 221-157 362-122 104 26 184 99 225 199l-24 9c-40-90-112-153-206-177-129-32-250 4-329 110l-28-19Z"/><path d="M174 296c-17 33-21 61-4 85 19-7 32-20 39-38l-35-47Z"/><circle cx="290" cy="297" r="38"/><circle cx="290" cy="297" r="13" fill="#08206d"/></g></svg>;
}
function MiniPuffer() { return <Image className="mini-puffer" src="/assets/puffer/puffer-calm-small.png" alt="" width={48} height={48} />; }
const prompts = [<>Pay 0.002 SUI to a friend</>, <>Trade 2 SUI for DBUSDC <span className="dbusdc-logo" aria-label="DBUSDC" /></>, <>Send all SUI to an unknown wallet <span className="warning-logo" aria-label="Warning" /></>];

export default function Home() {
  const [sent, setSent] = useState(false);
  return <><main className="wallet-hero"><nav className="hero-nav" aria-label="Main navigation"><a className="brand" href="#top" aria-label="Puffer home">puffer</a><div className="nav-actions"><a className="nav-cta" href="#start">GET STARTED</a><button className="menu-button" aria-label="Open menu"><i/><i/></button></div></nav><section className="hero-copy" id="top"><h1><span>PUFFER</span><span>AGENT WALLET</span></h1><p>Let your agent run on Sui.<br/>Puffer checks every move before it leaves the water.</p><a className="start-button" id="start" href="#prompt">GET STARTED</a></section><div className="hero-art" aria-label="Puffer wallet prompt preview"><Image className="hero-puffer" src="/assets/puffer/puffer-large-hero.png" alt="" width={900} height={560} priority/><section className="prompt-window" id="prompt"><div className="window-bar"><div className="window-dots"><b/><b/><b/></div><div className="bar-mark"><strong>⋮</strong></div></div><div className="prompt-list">{prompts.map((prompt, index) => <div className="prompt-row" key={index}><MiniPuffer/><span>{prompt}</span></div>)}</div><button className="send-button" onClick={() => setSent(true)}>{sent ? "PROMPT SENT" : "SEND PROMPT"}<span className="cursor"/></button></section></div></main><IntegrationsSection/><WorkflowSection/><PufferChecksSection/><FinalCtaSection/></>;
}
