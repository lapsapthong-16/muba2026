import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { requireAgent, AuthError } from '@/lib/auth'
import { getWallet, walletStatus, submitTransfer, submitSwap, approvalStatus, listMarkets, listHistory } from '@/lib/wallet'
import { withCode } from '@/lib/errors'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * MCP over Streamable HTTP. The WebStandard transport's handleRequest(Request) -> Response IS the
 * Next route signature, so there is no adapter layer.
 *
 * Stateless (no sessionIdGenerator): every call re-authenticates from the bearer, so an agent
 * restart costs nothing and there is no session table to get out of sync with the account table.
 *
 * SEVEN tools, and the list IS the capability surface. Note what is absent: no tool writes policy,
 * no tool approves an approval, and there is no `network` parameter anywhere — a field that does
 * not exist in the schema cannot be prompt-injected or defaulted wrong.
 *
 * The agent declares a typed INTENT and never raw bytes. That is the load-bearing property: a
 * prompt-injected agent cannot smuggle an arbitrary Move call past the gate, because the server
 * builds every transaction itself from the declared fields.
 */

function buildServer(accountId: string): McpServer {
  const server = new McpServer({ name: 'hermes-wallet', version: '0.1.0' })

  server.registerTool(
    'wallet_status',
    {
      title: 'Wallet status',
      description:
        'START HERE. Address, balance, configured guardrails and any pending approvals. ' +
        'If it returns needs_setup, show the setup_url to the human and STOP — you cannot set the ' +
        'wallet up for them. Read the guardrails before planning any spend: staying inside them is ' +
        'the difference between a payment that settles and one that waits on a hardware key.',
      inputSchema: {},
    },
    async () => text(await walletStatus(accountId))
  )

  server.registerTool(
    'wallet_markets',
    {
      title: 'What can actually be traded',
      description:
        'Live quotes across several sizes on DeepBook, and the smallest size the book will fill ' +
        'right now. Call this BEFORE wallet_swap. Small trades match nothing, and the floor moves ' +
        'with the resting orders — a size that filled yesterday can return zero today, so quote ' +
        'rather than assume. Reads only; moves nothing.',
      inputSchema: {},
    },
    async () => text(await listMarkets())
  )

  server.registerTool(
    'wallet_transfer',
    {
      title: 'Send SUI',
      description:
        'Send SUI to an address. COMMITS: on success the money is gone. The transaction is ' +
        'simulated and checked against the owner\'s guardrails first, so it may return ' +
        'awaiting_approval — in which case NOTHING has been sent and you must poll ' +
        'wallet_approval_status. To find out whether something WOULD be allowed without doing it, ' +
        'pass dry_run: true.',
      inputSchema: {
        to: z.string().describe('Recipient Sui address, 0x-prefixed'),
        amount_sui: z
          .union([z.number().positive(), z.literal('all')])
          .describe('Amount in SUI, or the string "all" to send the entire balance'),
        reason: z.string().max(400).describe('Why you are sending this, in one sentence, for the owner to read'),
        dry_run: z.boolean().optional().describe(
          'Rehearse it: build, simulate, score and judge, then discard. Nothing is signed, no ' +
          'approval is created, nothing is debited. Use this to find out whether something WOULD ' +
          'be allowed before you commit to it.'
        ),
      },
    },
    async (args) => text(await submitTransfer(accountId, args as never))
  )

  server.registerTool(
    'wallet_swap',
    {
      title: 'Trade on DeepBook',
      description:
        'Swap SUI for another asset on DeepBook. COMMITS. Quoted first, and refused outright if ' +
        'the order book cannot fill the size — small trades match nothing, and the floor moves with ' +
        'the resting orders (recently around 1.1 SUI). The slippage floor ' +
        'is set by the wallet, not by you. Same guardrails and same risk check as a transfer; a ' +
        'trade usually scores lower than a payment because the value comes back in the same ' +
        'transaction.',
      inputSchema: {
        amount_sui: z.number().positive().describe('How much SUI to sell'),
        pool: z.string().optional().describe('Pool key, default SUI_DBUSDC'),
        reason: z.string().max(400).describe('Why you are trading, in one sentence, for the owner to read'),
        dry_run: z.boolean().optional().describe('Rehearse it and discard. Nothing is signed or recorded.'),
      },
    },
    async (args) => text(await submitSwap(accountId, args as never))
  )

  server.registerTool(
    'wallet_approval_status',
    {
      title: 'Check a pending approval',
      description:
        'Poll a decision returned by wallet_transfer or wallet_swap. Blocks briefly while waiting ' +
        'for the human, so call it in a loop rather than spinning. Terminal states are executed, ' +
        'denied and expired — anything else means the human has not answered yet and NOTHING has ' +
        'been sent. Approvals expire 30 minutes after they are raised.',
      inputSchema: {
        approval_id: z.string(),
        wait_ms: z.number().int().min(0).max(45_000).optional().describe('Long-poll budget, default 25000'),
      },
    },
    async (args) => text(await approvalStatus(accountId, (args as never as { approval_id: string }).approval_id, (args as never as { wait_ms?: number }).wait_ms ?? 25_000))
  )

  server.registerTool(
    'wallet_history',
    {
      title: 'What this wallet has done',
      description:
        'Past decisions, newest first, each with the reason the agent gave, the rule that decided ' +
        'it, the risk score and a digest where money actually moved. Use it to check whether you ' +
        'already did something before doing it again. Reads only.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('How many, default 20'),
      },
    },
    async (args) => text(listHistory(accountId, (args as never as { limit?: number }).limit ?? 20))
  )

  server.registerTool(
    'wallet_explain_last',
    {
      title: 'Explain the last decision',
      description:
        'Why the most recent transaction was allowed, held, or blocked: the rules that fired, the ' +
        'simulated balance changes, and the risk-model receipt.',
      inputSchema: {},
    },
    async () => {
      const w = await getWallet(accountId)
      return text((w.lastDecision as Record<string, unknown>) ?? { note: 'No decisions yet.' })
    }
  )

  return server
}

/**
 * ONE result envelope. There is no `success` field anywhere, because `success: false` is exactly
 * what a model skims past. Instead: a past-tense `outcome`, a required `funds_moved` boolean on
 * EVERY result including errors, and a `digest` that is ABSENT rather than null unless funds
 * actually moved — so there is nothing digest-shaped to hallucinate a link from.
 *
 * The text block opens with SENT or NOT SENT and closes by restating it, because many clients drop
 * structuredContent and models weight first and last position.
 */
function text(raw: Record<string, unknown>) {
  // Decorate HERE rather than at each call site. Every tool result passes through this function,
  // so a new tool cannot forget to carry a code, and a rule can never ship without a remedy.
  const payload = withCode(raw)
  const moved = payload.funds_moved === true
  const head = moved ? 'SENT.' : 'NOT SENT.'
  const body = JSON.stringify(payload, null, 1)
  return {
    content: [{ type: 'text' as const, text: `${head}\n${body}\n${head}` }],
    structuredContent: payload,
  }
}

export async function POST(req: Request): Promise<Response> {
  let accountId: string
  try {
    accountId = requireAgent(req).accountId
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status })
    throw e
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: re-auth from the bearer on every call
    // Materialise a JSON body instead of an SSE stream. Without this the transport returns a
    // stream that is still open when the route returns, and tearing the transport down below
    // closes it before a single byte is written — a 200 with an empty body.
    enableJsonResponse: true,
  })
  const server = buildServer(accountId)
  await server.connect(transport)
  try {
    return await transport.handleRequest(req)
  } finally {
    // Stateless: nothing survives the request, so tear both down or the process leaks a transport
    // and its keep-alive timer per call. Safe only because the body is already materialised.
    await transport.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

/**
 * A GET opens a standalone SSE stream that never settles, which hangs an agent that probes the URL
 * and, in a serverless-ish runtime, holds the invocation open until it is killed. Refuse both
 * verbs outright — this server is stateless and has no server-initiated messages to deliver.
 */
export function GET() {
  return Response.json({ error: 'This MCP endpoint is POST-only.' }, { status: 405 })
}
export const DELETE = GET
