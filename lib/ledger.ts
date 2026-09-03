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

  // NOTE: do not add a broad /hid/ catch-all here. Almost every WebHID error mentions "HID"
  // ("Failed to execute 'requestDevice' on 'HID'"), so a loose match reports every cancelled
  // picker and every locked device as "your browser is unsupported" — which sends people off to
  // install a different browser when the real problem is that Ledger Live is still running.
  // Browser support is feature-detected separately via navigator.hid before the button renders.

  if (/no device selected|the user (?:cancell?ed|aborted)/i.test(msg))
    return 'No device was selected. If the picker was empty: quit Ledger Live (it holds an exclusive USB claim), unlock the device, and open the Sui app.'
  if (/securityerror|user gesture|transient activation/i.test(msg))
    return 'The browser blocked the device prompt because the click was not treated as a direct user action. Click the button again.'
  if (sw === '5515' || /locked/i.test(msg))
    return 'Your Ledger is locked. Unlock it with your PIN, then try again.'
  if (sw === '6808')
    return 'The Sui app refused this because blind signing is off. This wallet never needs blind signing — if you see this, the transaction was not the shape we expected.'
  // 0x6e01 CLA_NOT_SUPPORTED_BOOTLOADER, 0x6e00 CLA_NOT_SUPPORTED, 0x6d00 INS_NOT_SUPPORTED,
  // 0x6511 no app running. All mean the same thing in practice: the APDU reached the DASHBOARD
  // rather than the Sui app, because no app is open. This is by far the most common failure and it
  // must not fall through to a generic message.
  if (sw === '6e01' || sw === '6e00' || sw === '6d00' || sw === '6511' || /cla_not_supported|app.*not.*open|ins_not_supported/i.test(msg))
    return 'Your Ledger is on its home screen, not in the Sui app. Open the Sui app on the device — the screen should read "Sui is ready" — then click again. If Sui is not in your app list, install it from Ledger Live under My Ledger.'
  if (sw === '6985' || /denied|rejected by user/i.test(msg))
    return 'You declined on the device. Nothing was sent.'
  if (/already open|failed to open the device|in use/i.test(msg))
    return 'Something else is holding the device — usually Ledger Live. Quit it completely and try again.'
  return `Ledger error: ${msg.slice(0, 200)}`
}
