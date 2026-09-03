/**
 * Ledger constants shared by the browser component and the server route.
 *
 * THE DERIVATION PATH IS PINNED AND MUST NEVER CHANGE. The Sui app accepts both 3-level
 * (m/44'/784'/0') and 5-level (m/44'/784'/0'/0'/0') paths and they derive DIFFERENT keys —
 * confirmed from Ledger's own golden snapshots (0x56b19e72… vs 0x6fb21fee…). The multisig
 * committee is defined by exact public keys, so enrolling at one path and re-deriving at another
 * silently produces a different M and orphans everything in it.
 */
export const LEDGER_PATH = "m/44'/784'/0'/0'/0'"

/** What the browser POSTs back after the device confirms. */
export interface LedgerEnrolment {
  /** Sui-serialised public key, base64 — flag byte ‖ 32 key bytes. */
  suiPublicKey: string
  /** The single-sig address this key alone controls. Displayed for the human to compare. */
  deviceAddress: string
  derivationPath: string
}

/**
 * Device error taxonomy. The overwhelmingly common state is "plugged in but locked", so these are
 * recoverable prompts, not failures. Status words are matched NUMERICALLY: 0x6808 is not in
 * @ledgerhq/errors' StatusCodes table.
 */
export function explainLedgerError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const sw = msg.match(/0x([0-9a-fA-F]{4})/)?.[1]?.toLowerCase()
  if (/no device selected|cancell?ed/i.test(msg)) return 'No device was selected. Plug in your Ledger and try again.'
  if (/securityerror|user gesture/i.test(msg)) return 'The browser blocked the device prompt. Click the button directly rather than reloading.'
  if (sw === '5515' || /locked/i.test(msg)) return 'Your Ledger is locked. Unlock it with your PIN, then try again.'
  if (sw === '6808') return 'The Sui app refused this because blind signing is off. This wallet never needs blind signing — you should not see this.'
  if (sw === '6e00' || sw === '6d00' || /app.*not.*open/i.test(msg)) return 'Open the Sui app on your Ledger, then try again.'
  if (/denied|0x6985/i.test(msg)) return 'You declined on the device.'
  if (/support|hid/i.test(msg)) return 'This browser cannot talk to a Ledger. Use desktop Chrome, Edge or Opera.'
  return `Ledger error: ${msg.slice(0, 160)}`
}
