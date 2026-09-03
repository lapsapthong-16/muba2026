import { SuiGrpcClient } from '@mysten/sui/grpc'
import { normalizeStructTag } from '@mysten/sui/utils'

/**
 * The one Sui client. Testnet only — deliberately not configurable.
 *
 * Two things here are not optional:
 *  - `baseUrl` is REQUIRED. SuiGrpcClient calls .endsWith() on it internally, so omitting it
 *    throws a TypeError that reads nothing like "you forgot a config field".
 *  - JSON-RPC is DEAD on public fullnodes (verified: every method answers -32601 "has been
 *    deprecated"), so `SuiClient` — removed in @mysten/sui 2.0 anyway — is not a fallback.
 *
 * Note `movePackageService` hangs off the CLIENT, not `client.core`.
 */

export const NETWORK = 'testnet' as const
export const FULLNODE = 'https://fullnode.testnet.sui.io:443'

/** Verified live 2026-09-03 against fullnode.testnet.sui.io. */
export const TESTNET_CHAIN_ID = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD'

/**
 * NORMALISED at export, deliberately. The chain and the policy schema both canonicalise coin types
 * to the long form (0x0000…0002::sui::SUI), so a constant written as '0x2::sui::SUI' silently
 * matches nothing — a cap lookup returns undefined and, worse, a cap comparison could fail open.
 * Every comparison in this codebase is against this value.
 */
export const SUI_TYPE = normalizeStructTag('0x2::sui::SUI')
export const SUI_DECIMALS = 9

/** DeepBook v3 on testnet, read from the SDK's own testnetPackageIds. Demo 1's counterparty. */
export const DEEPBOOK_PACKAGE = '0xd874d2417a55bfa6479bffa06ad950fea144ef93a94cc6c49f32b03e386bbb24'

let client: SuiGrpcClient | null = null

export function getSuiClient(): SuiGrpcClient {
  if (!client) client = new SuiGrpcClient({ network: NETWORK, baseUrl: FULLNODE })
  return client
}

/**
 * Boot assert. A Sui address is byte-identical across networks, so pointing at the wrong chain
 * fails silently and awfully — balances read zero and transfers appear to vanish. Refuse to start.
 */
export async function assertChain(): Promise<string> {
  const { chainIdentifier } = await getSuiClient().core.getChainIdentifier()
  if (chainIdentifier !== TESTNET_CHAIN_ID) {
    throw new Error(
      `Wrong chain. Expected testnet (${TESTNET_CHAIN_ID}) but ${FULLNODE} reports ` +
        `${chainIdentifier}. Refusing to start.`
    )
  }
  return chainIdentifier
}

/** Note the doubly-nested shape: { balance: { balance, coinType, ... } }. */
export async function getBalance(owner: string, coinType = SUI_TYPE): Promise<bigint> {
  const res = await getSuiClient().core.getBalance({ owner, coinType })
  return BigInt(res.balance.balance)
}
