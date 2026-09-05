import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { getSuiClient, getBalance, NETWORK } from './sui'

/**
 * Put a starting balance into a brand-new wallet, from the operator's own funding key.
 *
 * Sui testnet's HTTP faucet is IP-blocked — measured 429 across a dozen attempts with backoff — so
 * "connect your Ledger, now go find some SUI" is a dead end for anyone trying this for the first
 * time. A wallet that cannot pay for anything is not a wallet yet.
 *
 * WHY BOTH ADDRESSES. The spending address gets most of it, because that is where routine payments
 * come from. The protected address gets a share too, and that is not optional: an escalated
 * transaction is REBUILT from it, so an empty protected address means the approval a human is asked
 * for cannot even be constructed — a failure that only appears at the worst possible moment,
 * after the agent has already said something is waiting.
 *
 * BEST EFFORT, ALWAYS. Every failure is swallowed. A dry funding key, a network blip, or no key at
 * all must never fail wallet creation: the wallet is real and correct either way, and the human can
 * fund it themselves. Refusing to create it would be worse than creating an empty one.
 *
 * TESTNET ONLY, and asserted rather than assumed. lib/sui.ts pins the network and boot-asserts the
 * chain identifier; this refuses to run anywhere else, because an operator-funded wallet is a
 * demo convenience and nothing about it should quietly become a mainnet code path.
 */

/**
 * Total handed to a new wallet, split between the two addresses.
 *
 * Sized to the whole demo rather than to one transaction: a payment, a 2 SUI trade, and an
 * escalation big enough to be worth approving. At 2 SUI the spending address ran dry after the
 * trade and the next request failed at BUILD before the gate ever saw it — which answers a
 * question about plumbing when the human asked one about security.
 */
const SPENDING_MIST = 5_000_000_000n
const PROTECTED_MIST = 3_000_000_000n
const PREFUND_TOTAL_MIST = SPENDING_MIST + PROTECTED_MIST
/** Leave the funder able to pay for its own next transaction. */
const FUNDER_RESERVE = 5_000_000n

export interface PrefundResult {
  funded: boolean
  spending_sui?: string
  protected_sui?: string
  digest?: string
  note: string
}

export async function prefund(spending: string, protectedAddr: string): Promise<PrefundResult> {
  if (NETWORK !== 'testnet') {
    return { funded: false, note: 'Automatic funding is testnet-only.' }
  }
  const sk = process.env.PRIVATE_KEY
  if (!sk) {
    return { funded: false, note: 'No funding key configured, so the wallet starts empty. Use: npm run fund -- <address> <amount>' }
  }

  try {
    const kp = Ed25519Keypair.fromSecretKey(sk.trim())
    const from = kp.toSuiAddress()
    const have = await getBalance(from)
    const need = PREFUND_TOTAL_MIST + FUNDER_RESERVE
    if (have < need) {
      return {
        funded: false,
        note: `The funding wallet holds ${(Number(have) / 1e9).toFixed(3)} SUI, short of the ${(Number(need) / 1e9).toFixed(3)} needed. Top it up, or fund the wallet by hand.`,
      }
    }

    // ONE transaction, two recipients. Two separate transfers would leave a window where the
    // spending address is funded and the protected one is not — which is exactly the half-funded
    // state that breaks escalations, and the state a crash between two calls would leave behind.
    const client = getSuiClient()
    const tx = new Transaction()
    tx.setSender(from)
    const [a, b] = tx.splitCoins(tx.gas, [SPENDING_MIST, PROTECTED_MIST])
    tx.transferObjects([a], spending)
    tx.transferObjects([b], protectedAddr)

    const bytes = await tx.build({ client })
    const { signature } = await kp.signTransaction(bytes)
    const res = await client.core.executeTransaction({ transaction: bytes, signatures: [signature] })
    const digest = (res as { Transaction?: { digest?: string } }).Transaction?.digest

    return {
      funded: true,
      spending_sui: (Number(SPENDING_MIST) / 1e9).toString(),
      protected_sui: (Number(PROTECTED_MIST) / 1e9).toString(),
      digest,
      note: 'Funded from the operator wallet. The protected address is funded too, so escalated payments can actually be built.',
    }
  } catch (e) {
    return {
      funded: false,
      note: `Automatic funding did not go through (${e instanceof Error ? e.message.split('\n')[0].slice(0, 120) : String(e)}). The wallet is still valid — fund it with: npm run fund -- <address> <amount>`,
    }
  }
}
