import { MultiSigPublicKey } from '@mysten/sui/multisig'
import { publicKeyFromSuiBytes } from '@mysten/sui/verify'
import type { PublicKey } from '@mysten/sui/cryptography'

/**
 * Two committees over the SAME keys. The risk verdict picks which one sends.
 *
 *   H (Spending)  1-of-2  {platform, ledger}                    low risk  -> platform alone
 *   M (Protected) 2-of-2  {platform, ledger, recovery(w2)}      suspicious -> platform + ledger
 *
 * A Sui multisig threshold CANNOT be conditional: the keys, weights and threshold are
 * blake2b-hashed into the address, and the protocol sums supplied weights against that one
 * fixed integer with no reference to the amount, recipient or call target. So the
 * conditionality lives in WHICH ADDRESS SENDS, not in a threshold that flips.
 *
 * `recovery` carries weight 2 so it alone satisfies M. Without it, a dead Ledger bricks the
 * protected balance forever — a larger expected loss than the attack being prevented.
 */

export interface CommitteeMember {
  /** Sui-serialised public key, base64. Persisted; the committee is rebuilt from these. */
  suiPublicKey: string
  weight: number
}

export interface Committee {
  threshold: number
  /** ORDER IS LOAD-BEARING — see rebuildCommittee. */
  members: CommitteeMember[]
}

export interface WalletCommittees {
  /** The derivation path the Ledger public key was read at. Pinned forever. */
  derivationPath: string
  spending: Committee
  protected: Committee
}

export function makeCommittees(
  platform: PublicKey,
  ledger: PublicKey,
  recovery: PublicKey,
  derivationPath: string
): { committees: WalletCommittees; H: string; M: string } {
  // Member ORDER is hashed into the address. Verified: {platform,ledger,recovery} and the same
  // three keys reordered produce DIFFERENT addresses. Build these arrays literally, in this
  // order, and persist them — never from a Set, an unordered query, or Object.keys().
  const spending: Committee = {
    threshold: 1,
    members: [
      { suiPublicKey: platform.toSuiPublicKey(), weight: 1 },
      { suiPublicKey: ledger.toSuiPublicKey(), weight: 1 },
    ],
  }
  const prot: Committee = {
    threshold: 2,
    members: [
      { suiPublicKey: platform.toSuiPublicKey(), weight: 1 },
      { suiPublicKey: ledger.toSuiPublicKey(), weight: 1 },
      { suiPublicKey: recovery.toSuiPublicKey(), weight: 2 },
    ],
  }
  const committees: WalletCommittees = { derivationPath, spending, protected: prot }
  return {
    committees,
    H: rebuildCommittee(spending).toSuiAddress(),
    M: rebuildCommittee(prot).toSuiAddress(),
  }
}

/** Rehydrate a persisted committee. Preserves order, which is what preserves the address. */
export function rebuildCommittee(c: Committee): MultiSigPublicKey {
  return MultiSigPublicKey.fromPublicKeys({
    threshold: c.threshold,
    publicKeys: c.members.map((m) => ({
      publicKey: publicKeyFromSui(m.suiPublicKey),
      weight: m.weight,
    })),
  })
}

/** flag byte -> concrete key class. Round-trip with toSuiPublicKey() is verified. */
function publicKeyFromSui(suiPublicKey: string): PublicKey {
  return publicKeyFromSuiBytes(suiPublicKey)
}

/**
 * combinePartialSignatures fails SILENTLY in two different ways, both verified:
 *   wrong member order -> 320-char signature, verify() false, NO throw
 *   under threshold    -> 232-char signature, verify() false, NO throw
 * Never broadcast its output unverified.
 */
export async function combineAndVerify(
  committee: Committee,
  partials: string[],
  txBytes: Uint8Array
): Promise<string> {
  const pk = rebuildCommittee(committee)
  const combined = pk.combinePartialSignatures(partials)
  const ok = await pk.verifyTransaction(txBytes, combined)
  if (!ok) {
    throw new Error(
      'Combined multisig signature did not verify. Almost always the partials were combined ' +
        'in the wrong order, or their total weight is under the threshold — neither of which ' +
        'combinePartialSignatures reports. Partials must be ordered to match committee.members.'
    )
  }
  return combined
}
