<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Puffer — the wallet in this repo

Everything below is outside the generated block above, so `next dev` will not overwrite it.

**If you have a bearer already, call `wallet_status` and stop reading.** Do NOT call
`/api/onboard` a second time: it mints a fresh platform key, which means a different multisig
committee, which means different spending and protected addresses — with the funds stranded at the
old pair. Lost your bearer? The human re-issues it from their browser session with
`POST /api/setup/bearer`; onboarding again is the wrong fix.

**First-time setup.** One call, then you stop and wait for a human:

```bash
curl -sX POST $BASE/api/onboard -H 'content-type: application/json' \
  -d '{"agent":"hermes","pass":"'"$ONBOARD_PASS"'"}'
```

Print the returned `setup_url` to the human verbatim and stop. You cannot finish setup: connecting
the Ledger needs WebHID in a desktop browser, and every `/api/setup/*` route rejects any request
carrying an `Authorization` header. That is deliberate — an agent that could set its own spending
limits is not limited by them.

Two Sui facts the human will hit, so tell them up front:
- **Funding is `npm run fund -- <address> <amountSui>`**, not a faucet. Testnet's HTTP faucet is
  IP-blocked and returns 429 indefinitely.
- **Fund the protected address too.** Escalations are rebuilt from it, so if it is empty the
  approval a human is asked for cannot even be constructed.

**Working.** Seven MCP tools. `wallet_status` first — it carries a preflight that tells you what
will fail before you try it. `wallet_markets` before any swap, because the book's fill floor moves.
`dry_run: true` on `wallet_transfer` or `wallet_swap` to rehearse without signing anything.

**Guardrails are named, not numeric.** Ask the human for a word — `reef` (pays only named
addresses) or `open_water` (pays anyone; limits, simulation and risk scoring still apply) — rather
than asking them to invent a per-transaction figure. `wallet_status` returns the full comparison
table for you to show them. You cannot set the mode yourself.
