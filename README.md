# AI Guardian Wallet

## 1. Project Overview

### What It Is

AI Guardian Wallet is a smart wallet on Sui that uses AI to automatically dry-run every outgoing transaction. Clean transactions are auto-signed and submitted — the user never notices. Risky transactions are paused, the user gets a plain-English explanation of what's wrong, and they must physically sign with their Ledger hardware wallet to proceed.

### The Problem

Crypto users face two bad options:

1. **Manual hardware wallets** — sign every single transaction on your Ledger. Secure but unusable for daily DeFi activity.
2. **Autonomous AI wallets** — delegate everything to an AI agent. Convenient but one bad transaction drains you.

There's no middle ground. No wallet separates safe transactions from dangerous ones and applies different security levels to each.

### The Solution

A tiered security model where AI is the automated first pass:

```
Every transaction
       │
   AI dry-run
       │
  ┌────┴────┐
  │         │
CLEAN     RISKY
  │         │
Auto-     Pause → Explain → Ledger required
submit
```

### Value Proposition

- **For users**: DeFi at full speed with a safety net. You only touch your Ledger when it actually matters.
- **For judges**: Physical hardware demo on stage, AI solves a real emotional problem (getting scammed), novel architecture no one has built.

---

## 2. Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                             │
│                     Next.js 14 App                          │
│                                                             │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ zkLogin  │  │ Wallet       │  │ Ledger WebHID          │ │
│  │ (Google) │  │ Dashboard    │  │ Transport              │ │
│  └────┬─────┘  └──────┬───────┘  └──────────┬─────────────┘ │
│       │               │                     │               │
└───────┼───────────────┼─────────────────────┼───────────────┘
        │               │                     │
        │         ┌─────▼──────┐              │
        │         │ API Routes │              │
        │         │ /api/...   │              │
        │         └─────┬──────┘              │
        │               │                     │
        │         ┌─────▼──────────────┐      │
        │         │   AI RISK ENGINE   │      │
        │         │                    │      │
        │         │ 1. devInspect      │      │
        │         │ 2. Contract check  │      │
        │         │ 3. Pattern match   │      │
        │         │ 4. Risk scoring    │      │
        │         │ 5. LLM explain     │      │
        │         └─────┬──────────────┘      │
        │               │                     │
        │         ┌─────▼──────┐              │
        │         │  DECISION  │              │
        │         │            │              │
        │         │ Clean?─────┼──► Auto-sign (zkLogin keypair)
        │         │            │              │
        │         │ Risky?─────┼──► Escalate to Ledger ◄──────┘
        │         └─────┬──────┘
        │               │
┌───────▼───────────────▼──────────────────────────────────────┐
│                      SUI NETWORK                             │
│                                                              │
│  ┌────────────────┐  ┌────────────┐  ┌─────────────────────┐ │
│  │ GuardianWallet │  │ PolicyObj  │  │ Sponsored Tx        │ │
│  │ (Move module)  │  │ (thresholds│  │ (gas station)       │ │
│  └────────────────┘  └────────────┘  └─────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────┐
│                      WALRUS                                  │
│                                                              │
│  Audit log: every AI decision, risk score, explanation,      │
│  tx hash, timestamp, user action (auto/override/reject)      │
└──────────────────────────────────────────────────────────────┘
```

### Component Interactions

```
User clicks "Swap 100 USDC → SUI on Cetus"
  │
  ▼
Frontend builds PTB (TransactionBlock)
  │
  ▼
POST /api/analyze  ──► AI Risk Engine
  │                         │
  │                    devInspect(ptb)
  │                         │
  │                    Check signals:
  │                    - token approvals
  │                    - contract age
  │                    - balance impact
  │                    - known addresses
  │                         │
  │                    Score: 0-100
  │                         │
  │              ┌──────────┴──────────┐
  │              │                     │
  │         Score < 40            Score >= 40
  │         (CLEAN)               (RISKY)
  │              │                     │
  │         Return:               Return:
  │         { safe: true }        { safe: false,
  │              │                  score: 72,
  │              │                  reasons: [...],
  │              │                  explanation: "..." }
  │              │                     │
  ▼              ▼                     ▼
Frontend    Auto-sign with        Show warning modal
            zkLogin keypair       with explanation
                 │                     │
                 │                User plugs in Ledger
                 │                     │
                 │                Ledger signs tx
                 │                     │
                 ▼                     ▼
            Submit to Sui         Submit to Sui
                 │                     │
                 ▼                     ▼
            Log to Walrus         Log to Walrus
            (decision: auto)      (decision: override)
```

---

## 3. Smart Contract Design

### Module Structure

```
guardian_wallet/
├── sources/
│   ├── wallet.move        # Core wallet object + auth logic
│   ├── policy.move        # Risk policy thresholds
│   └── audit.move         # On-chain audit trail references
└── Move.toml
```

### Core Structs (Move)

```move
module guardian_wallet::wallet {
    use sui::object::{Self, UID};
    use sui::tx_context::TxContext;
    use sui::transfer;
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;

    /// The wallet object. Owned by the user.
    /// Contains two authorized signers:
    /// - primary_address: zkLogin-derived address (for auto-sign)
    /// - ledger_address: Ledger-derived address (for escalation)
    struct GuardianWallet has key, store {
        id: UID,
        /// zkLogin-derived address — used for auto-signed transactions
        primary_address: address,
        /// Ledger-derived address — required for risky transactions
        ledger_address: address,
        /// Whether the wallet is frozen (emergency freeze)
        frozen: bool,
        /// Reference to the policy object
        policy_id: ID,
    }

    /// Create a new guardian wallet.
    /// Called once during onboarding after zkLogin + Ledger pairing.
    public entry fun create_wallet(
        primary_address: address,
        ledger_address: address,
        ctx: &mut TxContext,
    ) {
        let policy = guardian_wallet::policy::create_default(ctx);
        let policy_id = object::id(&policy);
        transfer::public_share_object(policy);

        let wallet = GuardianWallet {
            id: object::new(ctx),
            primary_address,
            ledger_address,
            frozen: false,
            policy_id,
        };
        transfer::transfer(wallet, tx_context::sender(ctx));
    }

    /// Execute a transaction that was AI-approved (clean).
    /// Can only be called by the primary (zkLogin) address.
    public entry fun execute_clean(
        wallet: &GuardianWallet,
        ctx: &TxContext,
    ) {
        assert!(!wallet.frozen, EWalletFrozen);
        assert!(
            tx_context::sender(ctx) == wallet.primary_address,
            EUnauthorized
        );
        // The actual DeFi operations are composed in the PTB
        // alongside this call. This function just gates the auth.
    }

    /// Execute a transaction that was AI-flagged (risky).
    /// Can ONLY be called by the Ledger address.
    public entry fun execute_override(
        wallet: &GuardianWallet,
        ctx: &TxContext,
    ) {
        assert!(!wallet.frozen, EWalletFrozen);
        assert!(
            tx_context::sender(ctx) == wallet.ledger_address,
            ELedgerRequired
        );
        // Ledger-signed override. The actual operations are in the PTB.
    }

    /// Emergency freeze. Only Ledger can call.
    /// Blocks ALL transactions until unfreeze.
    public entry fun freeze(
        wallet: &mut GuardianWallet,
        ctx: &TxContext,
    ) {
        assert!(
            tx_context::sender(ctx) == wallet.ledger_address,
            ELedgerRequired
        );
        wallet.frozen = true;
    }

    /// Unfreeze. Only Ledger can call.
    public entry fun unfreeze(
        wallet: &mut GuardianWallet,
        ctx: &TxContext,
    ) {
        assert!(
            tx_context::sender(ctx) == wallet.ledger_address,
            ELedgerRequired
        );
        wallet.frozen = false;
    }

    // Error codes
    const EWalletFrozen: u64 = 0;
    const EUnauthorized: u64 = 1;
    const ELedgerRequired: u64 = 2;
}
```

### Policy Object

```move
module guardian_wallet::policy {
    use sui::object::{Self, UID};
    use sui::tx_context::TxContext;

    /// Risk policy thresholds. Only editable via Ledger.
    struct Policy has key, store {
        id: UID,
        /// Max auto-approve transaction value in USDC (base units)
        /// Transactions above this always require Ledger
        max_auto_value: u64,
        /// Max number of auto-approved txs per 24h rolling window
        daily_auto_limit: u64,
        /// Whether unlimited token approvals are auto-blocked
        block_unlimited_approvals: bool,
        /// Minimum contract age (in epochs) for auto-approve
        min_contract_age: u64,
    }

    public fun create_default(ctx: &mut TxContext): Policy {
        Policy {
            id: object::new(ctx),
            max_auto_value: 500_000_000,      // 500 USDC (6 decimals)
            daily_auto_limit: 20,
            block_unlimited_approvals: true,
            min_contract_age: 7,               // ~7 days
        }
    }

    /// Update policy. Requires Ledger signer through the wallet's
    /// execute_override path — cannot be called via zkLogin.
    public entry fun update_policy(
        policy: &mut Policy,
        max_auto_value: u64,
        daily_auto_limit: u64,
        block_unlimited_approvals: bool,
        min_contract_age: u64,
    ) {
        policy.max_auto_value = max_auto_value;
        policy.daily_auto_limit = daily_auto_limit;
        policy.block_unlimited_approvals = block_unlimited_approvals;
        policy.min_contract_age = min_contract_age;
    }
}
```

### Audit Reference

```move
module guardian_wallet::audit {
    use sui::object::{Self, UID};
    use sui::tx_context::TxContext;
    use sui::event;

    /// Emitted for every AI decision. Indexed on-chain,
    /// full detail stored on Walrus.
    struct AuditEvent has copy, drop {
        wallet_id: ID,
        tx_digest: vector<u8>,
        risk_score: u64,
        decision: u8,          // 0 = auto, 1 = override, 2 = rejected
        walrus_blob_id: vector<u8>,
        timestamp: u64,
    }

    public fun emit_audit(
        wallet_id: ID,
        tx_digest: vector<u8>,
        risk_score: u64,
        decision: u8,
        walrus_blob_id: vector<u8>,
        timestamp: u64,
    ) {
        event::emit(AuditEvent {
            wallet_id,
            tx_digest,
            risk_score,
            decision,
            walrus_blob_id,
            timestamp,
        });
    }
}
```

---

## 4. AI Risk Engine

### Signal Analysis

The AI checks these signals for every transaction, scored 0-100:

| Signal | Weight | What It Checks | Red Flag Example |
|--------|--------|----------------|------------------|
| Token Approval Scope | 25 | Does the tx request unlimited token approval? | `approve(MAX_UINT256)` for any token |
| Balance Impact | 20 | What % of user's balance does this tx move? | Moving >50% of total holdings |
| Contract Verification | 20 | Is the target contract a known, verified protocol? | Unverified contract, no source code |
| Contract Age | 10 | How old is the target contract? | Deployed < 7 days ago |
| Transaction Simulation | 10 | Does devInspect show expected outcomes? | Simulation fails or shows unexpected token transfers |
| Address Reputation | 10 | Has this address been flagged by community lists? | Address linked to known drainer contracts |
| Spending Pattern | 5 | Is this transaction amount normal for this user? | 10x larger than user's average tx |

### Risk Scoring

```
Total Score = Σ (signal_score × weight)

Score 0-39:   GREEN  → Auto-sign, auto-submit
Score 40-69:  YELLOW → Auto-sign, but show brief warning toast
Score 70-100: RED    → Block. Require Ledger override.
```

### devInspectTransactionBlock Usage

```typescript
// AI Risk Engine — core analysis function

import { SuiClient } from "@mysten/sui/client";

interface RiskResult {
  score: number;           // 0-100
  level: "green" | "yellow" | "red";
  reasons: string[];       // machine-readable reasons
  explanation: string;     // plain English from LLM
  simulation: {
    success: boolean;
    balanceChanges: BalanceChange[];
    events: SuiEvent[];
  };
}

async function analyzeTransaction(
  client: SuiClient,
  txBytes: Uint8Array,
  senderAddress: string,
): Promise<RiskResult> {
  // 1. Dry-run the transaction
  const inspectResult = await client.devInspectTransactionBlock({
    transactionBlock: txBytes,
    sender: senderAddress,
  });

  // 2. Check if simulation succeeded
  if (inspectResult.effects.status.status !== "success") {
    return {
      score: 90,
      level: "red",
      reasons: ["simulation_failed"],
      explanation: "This transaction fails when simulated. It may be designed to behave differently when actually executed — a common scam pattern.",
      simulation: { success: false, balanceChanges: [], events: [] },
    };
  }

  // 3. Parse balance changes from simulation
  const balanceChanges = inspectResult.balanceChanges || [];

  // 4. Parse the transaction data to check for dangerous operations
  const txData = await parseTransactionData(txBytes);

  let score = 0;
  const reasons: string[] = [];

  // Signal 1: Unlimited token approvals (weight: 25)
  if (hasUnlimitedApproval(txData)) {
    score += 25;
    reasons.push("unlimited_token_approval");
  }

  // Signal 2: Balance impact (weight: 20)
  const userBalances = await client.getAllBalances({ owner: senderAddress });
  const impactPct = calculateBalanceImpact(balanceChanges, userBalances);
  if (impactPct > 50) {
    score += 20;
    reasons.push("high_balance_impact");
  } else if (impactPct > 25) {
    score += 10;
    reasons.push("moderate_balance_impact");
  }

  // Signal 3: Contract verification (weight: 20)
  const targetPackages = extractTargetPackages(txData);
  for (const pkg of targetPackages) {
    const isVerified = await checkVerifiedProtocol(pkg);
    if (!isVerified) {
      score += 20;
      reasons.push("unverified_contract");
      break;
    }
  }

  // Signal 4: Contract age (weight: 10)
  for (const pkg of targetPackages) {
    const ageEpochs = await getContractAge(client, pkg);
    if (ageEpochs < 7) {
      score += 10;
      reasons.push("new_contract");
      break;
    }
  }

  // Signal 5: Unexpected transfers in simulation (weight: 10)
  const unexpectedTransfers = findUnexpectedTransfers(
    balanceChanges,
    txData,
    senderAddress
  );
  if (unexpectedTransfers.length > 0) {
    score += 10;
    reasons.push("unexpected_transfers");
  }

  // Signal 6: Known bad addresses (weight: 10)
  const flaggedAddresses = await checkAddressReputation(targetPackages);
  if (flaggedAddresses.length > 0) {
    score += 10;
    reasons.push("flagged_address");
  }

  // Signal 7: Spending anomaly (weight: 5)
  const isAnomaly = await checkSpendingAnomaly(senderAddress, balanceChanges);
  if (isAnomaly) {
    score += 5;
    reasons.push("spending_anomaly");
  }

  // 5. Generate plain English explanation via LLM
  const explanation = await generateExplanation(reasons, balanceChanges, txData);

  // 6. Determine risk level
  const level = score < 40 ? "green" : score < 70 ? "yellow" : "red";

  return {
    score,
    level,
    reasons,
    explanation,
    simulation: {
      success: true,
      balanceChanges,
      events: inspectResult.events || [],
    },
  };
}
```

### LLM Explanation Generation

```typescript
async function generateExplanation(
  reasons: string[],
  balanceChanges: BalanceChange[],
  txData: ParsedTransaction,
): Promise<string> {
  const prompt = `You are a crypto security assistant. A user is about to sign a Sui transaction. Based on the following risk signals, write a 2-3 sentence plain English explanation of what this transaction does and why it might be risky. Be specific. Don't use jargon.

Risk signals detected: ${reasons.join(", ")}

Balance changes from simulation:
${JSON.stringify(balanceChanges, null, 2)}

Transaction operations:
${JSON.stringify(txData.operations, null, 2)}

Write the explanation:`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0].text;
}
```

### Verified Protocol Registry

For the hackathon, maintain a simple allowlist:

```typescript
const VERIFIED_PROTOCOLS: Record<string, string> = {
  // Cetus DEX
  "0x...cetus_package_id": "Cetus DEX",
  // Scallop Lending
  "0x...scallop_package_id": "Scallop Lending",
  // DeepBook
  "0x...deepbook_package_id": "DeepBook",
  // Navi Protocol
  "0x...navi_package_id": "Navi Protocol",
  // Turbos Finance
  "0x...turbos_package_id": "Turbos Finance",
};

function checkVerifiedProtocol(packageId: string): boolean {
  return packageId in VERIFIED_PROTOCOLS;
}
```

---

## 5. Ledger Integration

### WebHID Transport Flow

```
Browser ──► WebHID API ──► USB ──► Ledger Device
                                       │
                                  Sui App on Ledger
                                       │
                                  Signs tx bytes
                                       │
                                  Returns signature
```

### Dependencies

```
@ledgerhq/hw-transport-webhid    — WebHID transport for browser
@ledgerhq/hw-app-sui             — Sui-specific Ledger app interface
```

### Implementation

```typescript
import TransportWebHID from "@ledgerhq/hw-transport-webhid";

// Note: there is no official @ledgerhq/hw-app-sui package yet.
// For the hackathon, we talk to the Ledger Sui app directly
// using raw APDU commands over the transport.
//
// The Sui Ledger app uses these APDU instructions:
//   INS_GET_PUBLIC_KEY = 0x05
//   INS_SIGN_TX        = 0x06
//
// Alternatively, use @mysten/sui's Ledger signer if available,
// or wrap the raw APDU calls in a helper.

class LedgerSuiSigner {
  private transport: TransportWebHID | null = null;

  async connect(): Promise<string> {
    // Request Ledger device via WebHID
    this.transport = await TransportWebHID.create();

    // Get the Sui address from Ledger (derivation path m/44'/784'/0'/0'/0')
    const pathBuffer = this.buildPathBuffer("44'/784'/0'/0'/0'");

    const response = await this.transport.send(
      0xe0,   // CLA
      0x05,   // INS_GET_PUBLIC_KEY
      0x00,   // P1: don't display on device
      0x00,   // P2
      pathBuffer
    );

    // Parse public key from response
    const publicKeyLength = response[0];
    const publicKey = response.slice(1, 1 + publicKeyLength);

    // Derive Sui address from Ed25519 public key
    return this.publicKeyToSuiAddress(publicKey);
  }

  async signTransaction(txBytes: Uint8Array): Promise<Uint8Array> {
    if (!this.transport) throw new Error("Ledger not connected");

    const pathBuffer = this.buildPathBuffer("44'/784'/0'/0'/0'");

    // For large payloads, chunk into 255-byte APDU segments
    const chunks = this.chunkPayload(txBytes);

    let response: Buffer;
    for (let i = 0; i < chunks.length; i++) {
      const isFirst = i === 0;
      const isLast = i === chunks.length - 1;

      const payload = isFirst
        ? Buffer.concat([pathBuffer, chunks[i]])
        : chunks[i];

      response = await this.transport.send(
        0xe0,   // CLA
        0x06,   // INS_SIGN_TX
        isFirst ? 0x00 : 0x80,  // P1: first chunk vs continuation
        0x00,   // P2
        payload
      );
    }

    // Response contains the Ed25519 signature (64 bytes)
    return new Uint8Array(response!.slice(0, 64));
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
  }

  private buildPathBuffer(path: string): Buffer {
    const components = path.split("/").map((c) => {
      const hardened = c.endsWith("'");
      const index = parseInt(c.replace("'", ""));
      return hardened ? index + 0x80000000 : index;
    });
    const buf = Buffer.alloc(1 + components.length * 4);
    buf[0] = components.length;
    components.forEach((c, i) => buf.writeUInt32BE(c, 1 + i * 4));
    return buf;
  }

  private chunkPayload(data: Uint8Array): Buffer[] {
    const maxChunk = 255;
    const chunks: Buffer[] = [];
    for (let i = 0; i < data.length; i += maxChunk) {
      chunks.push(Buffer.from(data.slice(i, i + maxChunk)));
    }
    return chunks;
  }

  private publicKeyToSuiAddress(publicKey: Uint8Array): string {
    // Sui address = BLAKE2b-256(0x00 || public_key)[0..32] in hex
    // 0x00 is the Ed25519 scheme flag
    const { blake2b } = require("@noble/hashes/blake2b");
    const payload = new Uint8Array([0x00, ...publicKey]);
    const hash = blake2b(payload, { dkLen: 32 });
    return "0x" + Buffer.from(hash).toString("hex");
  }
}
```

### Escalation Flow (Risky Transaction)

```typescript
async function handleRiskyTransaction(
  riskResult: RiskResult,
  txBytes: Uint8Array,
  walletObjectId: string,
) {
  // 1. Show the warning modal to the user
  showWarningModal({
    score: riskResult.score,
    explanation: riskResult.explanation,
    reasons: riskResult.reasons,
    balanceChanges: riskResult.simulation.balanceChanges,
  });

  // 2. Wait for user to click "Override with Ledger"
  // (UI state change, handled by React)

  // 3. User clicks override → connect Ledger
  const ledger = new LedgerSuiSigner();
  const ledgerAddress = await ledger.connect();

  // 4. Build a new PTB that calls execute_override instead of execute_clean
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::wallet::execute_override`,
    arguments: [tx.object(walletObjectId)],
  });
  // Append the original DeFi operations to the same PTB
  // ... (copy operations from original tx)

  // 5. Serialize and send to Ledger for signing
  const txBytes = await tx.build({ client: suiClient });
  const signature = await ledger.signTransaction(txBytes);

  // 6. Submit the Ledger-signed transaction
  const result = await suiClient.executeTransactionBlock({
    transactionBlock: txBytes,
    signature: toSerializedSignature({
      signature,
      signatureScheme: "ED25519",
      publicKey: ledgerPublicKey,
    }),
  });

  // 7. Log to Walrus
  await logAuditToWalrus({
    decision: "override",
    riskScore: riskResult.score,
    txDigest: result.digest,
    explanation: riskResult.explanation,
  });

  await ledger.disconnect();
}
```

---

## 6. Transaction Flow

### Flow A: Clean Transaction (auto-sign)

```
Step 1: User clicks "Swap 100 USDC → SUI" in the wallet UI

Step 2: Frontend builds the PTB
        const tx = new Transaction();
        tx.moveCall({
          target: `${CETUS_PACKAGE}::router::swap`,
          arguments: [...],
        });

Step 3: Frontend serializes and sends to POST /api/analyze
        { txBytes: base64(serialized_ptb), sender: "0x..." }

Step 4: AI Risk Engine runs:
        - devInspectTransactionBlock → simulation succeeds
        - Cetus is in VERIFIED_PROTOCOLS → score +0
        - Balance impact: 100 USDC out of 2000 = 5% → score +0
        - No unlimited approvals → score +0
        - Total score: 0 → GREEN

Step 5: API returns { safe: true, score: 0, level: "green" }

Step 6: Frontend auto-signs with zkLogin keypair (stored in session)
        No user interaction needed.

Step 7: Frontend wraps in sponsored transaction (gas station pays gas)

Step 8: Submit to Sui network

Step 9: Show success toast: "Swapped 100 USDC → 47.3 SUI ✓"

Step 10: Log to Walrus: { decision: "auto", score: 0, tx: "...", timestamp: ... }
```

### Flow B: Risky Transaction (Ledger escalation)

```
Step 1: User interacts with a dApp that requests a transaction
        (or paste a transaction link, or DeFi action in wallet)

Step 2: Frontend builds the PTB from the dApp request

Step 3: Frontend serializes and sends to POST /api/analyze

Step 4: AI Risk Engine runs:
        - devInspectTransactionBlock → simulation succeeds BUT
          shows unexpected outgoing transfer of all USDC
        - Target contract is NOT in VERIFIED_PROTOCOLS → score +20
        - Contract deployed 2 days ago → score +10
        - Requests unlimited USDC approval → score +25
        - Balance impact: 100% of USDC → score +20
        - Total score: 75 → RED

Step 5: API returns:
        {
          safe: false,
          score: 75,
          level: "red",
          reasons: ["unverified_contract", "new_contract",
                    "unlimited_token_approval", "high_balance_impact"],
          explanation: "This transaction asks you to approve unlimited
            USDC spending for a contract that was created 2 days ago
            and has no verified source code. The simulation shows all
            your USDC would be transferred out. This matches the
            pattern of a token drainer scam."
        }

Step 6: Frontend shows WARNING MODAL:
        ┌──────────────────────────────────────────────┐
        │  ⚠️  RISKY TRANSACTION DETECTED               │
        │                                               │
        │  Risk Score: 75/100                           │
        │                                               │
        │  "This transaction asks you to approve        │
        │   unlimited USDC spending for a contract      │
        │   that was created 2 days ago and has no      │
        │   verified source code. The simulation shows  │
        │   all your USDC would be transferred out.     │
        │   This matches the pattern of a token         │
        │   drainer scam."                              │
        │                                               │
        │  Signals:                                     │
        │  ● Unlimited token approval requested         │
        │  ● Contract is 2 days old                     │
        │  ● Contract not verified                      │
        │  ● 100% of your USDC at risk                  │
        │                                               │
        │  [Cancel]    [Override with Ledger]            │
        └──────────────────────────────────────────────┘

Step 7: User clicks "Override with Ledger"
        → Browser prompts for WebHID device selection
        → User selects Ledger and confirms on device screen

Step 8: Transaction is signed by Ledger and submitted

Step 9: Log to Walrus with decision: "override"

--- OR ---

Step 7b: User clicks "Cancel"
         → Transaction is discarded
         → Log to Walrus with decision: "rejected"
```

---

## 7. Tech Stack

### Core

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Framework | Next.js | 14 | App router, API routes, SSR |
| Language | TypeScript | 5.x | Type safety |
| Sui SDK | @mysten/sui | latest | Transaction building, RPC |
| Sui dApp Kit | @mysten/dapp-kit | latest | Wallet connection, hooks |
| zkLogin | @mysten/zklogin | latest | Google OAuth → Sui address |
| Styling | Tailwind CSS | 3.x | UI styling |
| UI Components | shadcn/ui | latest | Pre-built components |
| State | Zustand | 4.x | Client state management |

### Ledger

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Transport | @ledgerhq/hw-transport-webhid | Browser USB communication |
| Crypto | @noble/hashes | BLAKE2b for address derivation |

### AI

| Component | Technology | Purpose |
|-----------|-----------|---------|
| LLM | Anthropic Claude API (claude-sonnet-4-20250514) | Risk explanation generation |
| Risk Scoring | Custom TypeScript | Signal analysis + scoring |

### Storage

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Audit Log | Walrus | Decentralized storage for AI decisions |
| Walrus SDK | @mysten/walrus | Blob upload/download |

### Smart Contracts

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Language | Move | Sui smart contracts |
| Build | Sui CLI | Compile + deploy |
| Testing | Sui Move test framework | Unit tests |

### Gas

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Sponsored Tx | Shinami or Enoki | Gas station for gasless UX |

---

## 8. Frontend Architecture

### Pages

```
app/
├── page.tsx                    # Landing / login page
├── dashboard/
│   └── page.tsx                # Main wallet dashboard
├── history/
│   └── page.tsx                # Transaction + audit history
├── settings/
│   └── page.tsx                # Policy settings (Ledger required)
└── api/
    ├── analyze/
    │   └── route.ts            # AI risk analysis endpoint
    ├── audit/
    │   └── route.ts            # Walrus audit log write
    └── sponsor/
        └── route.ts            # Sponsored transaction relay
```

### Key Components

```
components/
├── WalletDashboard.tsx         # Balance display, quick actions
├── TransactionBuilder.tsx      # Build and initiate transactions
├── RiskModal.tsx               # Warning modal for risky txs
│                                 Shows score, explanation, reasons
│                                 "Cancel" and "Override with Ledger" buttons
├── LedgerConnect.tsx           # Ledger pairing + signing UI
│                                 WebHID connection flow
│                                 Device status indicator
├── AuditLog.tsx                # Historical AI decisions from Walrus
├── PolicyEditor.tsx            # Edit risk thresholds (Ledger-gated)
├── TransactionToast.tsx        # Success/failure notifications
└── RiskBadge.tsx               # Green/Yellow/Red risk indicator
```

### State Management (Zustand)

```typescript
interface WalletStore {
  // Wallet state
  walletObjectId: string | null;
  primaryAddress: string | null;   // zkLogin address
  ledgerAddress: string | null;    // Ledger address
  balances: CoinBalance[];
  frozen: boolean;

  // Transaction state
  pendingTx: PendingTransaction | null;
  riskResult: RiskResult | null;
  txStatus: "idle" | "analyzing" | "signing" | "submitting" | "done" | "error";

  // Ledger state
  ledgerConnected: boolean;
  ledgerSigner: LedgerSuiSigner | null;

  // Policy
  policy: Policy;

  // Actions
  analyzeTx: (txBytes: Uint8Array) => Promise<void>;
  autoSign: (txBytes: Uint8Array) => Promise<void>;
  ledgerSign: (txBytes: Uint8Array) => Promise<void>;
  connectLedger: () => Promise<void>;
  refreshBalances: () => Promise<void>;
}
```

---

## 9. Walrus Audit Log

### Schema

Every AI decision is stored as a JSON blob on Walrus:

```typescript
interface AuditEntry {
  // Identifiers
  wallet_id: string;            // Sui object ID of the GuardianWallet
  tx_digest: string;            // Sui transaction digest (after submission)
  timestamp: number;            // Unix timestamp (ms)

  // AI Decision
  risk_score: number;           // 0-100
  risk_level: "green" | "yellow" | "red";
  reasons: string[];            // Machine-readable risk signals
  explanation: string;          // Plain English from LLM

  // User Action
  decision: "auto" | "override" | "rejected";
  // auto     = AI approved, auto-signed
  // override = AI flagged, user overrode with Ledger
  // rejected = AI flagged, user cancelled

  // Simulation
  simulation_success: boolean;
  balance_changes: {
    coin_type: string;
    amount: string;             // Signed: negative = outgoing
  }[];

  // Transaction Details
  target_packages: string[];    // Package IDs called
  operations: string[];         // Human-readable op list
}
```

### Write to Walrus

```typescript
import { WalrusClient } from "@mysten/walrus";

async function logAuditToWalrus(entry: AuditEntry): Promise<string> {
  const walrus = new WalrusClient({
    network: "testnet",
  });

  const blob = new TextEncoder().encode(JSON.stringify(entry));

  const { blobId } = await walrus.store(blob, {
    epochs: 5,  // Store for 5 epochs (~5 days, enough for hackathon)
  });

  return blobId;
}
```

### Read Audit History

```typescript
async function getAuditHistory(walletId: string): Promise<AuditEntry[]> {
  // Query Sui events for AuditEvent emissions from our contract
  const events = await suiClient.queryEvents({
    query: {
      MoveEventType: `${PACKAGE_ID}::audit::AuditEvent`,
    },
    order: "descending",
    limit: 50,
  });

  // For each event, fetch the full audit data from Walrus
  const entries: AuditEntry[] = [];
  for (const event of events.data) {
    const parsedEvent = event.parsedJson as {
      walrus_blob_id: number[];
      wallet_id: string;
    };

    // Filter by wallet
    if (parsedEvent.wallet_id !== walletId) continue;

    const blobId = Buffer.from(parsedEvent.walrus_blob_id).toString("hex");
    const walrus = new WalrusClient({ network: "testnet" });
    const data = await walrus.read(blobId);
    const entry = JSON.parse(new TextDecoder().decode(data));
    entries.push(entry);
  }

  return entries;
}
```

---

## 10. API Routes

### POST /api/analyze

Receives a serialized PTB, runs the AI risk engine, returns the risk assessment.

```typescript
// app/api/analyze/route.ts
import { NextRequest, NextResponse } from "next/server";
import { SuiClient } from "@mysten/sui/client";

const client = new SuiClient({ url: "https://fullnode.testnet.sui.io:443" });

export async function POST(req: NextRequest) {
  const { txBytes, sender } = await req.json();

  // Decode the base64 transaction bytes
  const bytes = Buffer.from(txBytes, "base64");

  // Run the AI risk analysis
  const result = await analyzeTransaction(client, bytes, sender);

  return NextResponse.json(result);
}
```

### POST /api/audit

Writes an audit entry to Walrus and emits an on-chain event.

```typescript
// app/api/audit/route.ts
export async function POST(req: NextRequest) {
  const entry: AuditEntry = await req.json();

  // 1. Store full audit data on Walrus
  const blobId = await logAuditToWalrus(entry);

  // 2. Emit on-chain event with Walrus blob reference
  // (This is done via a sponsored transaction from the backend)
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::audit::emit_audit`,
    arguments: [
      tx.pure.id(entry.wallet_id),
      tx.pure.vector("u8", Buffer.from(entry.tx_digest)),
      tx.pure.u64(entry.risk_score),
      tx.pure.u8(
        entry.decision === "auto" ? 0 :
        entry.decision === "override" ? 1 : 2
      ),
      tx.pure.vector("u8", Buffer.from(blobId)),
      tx.pure.u64(entry.timestamp),
    ],
  });

  // Sign with backend keypair and sponsor gas
  const result = await sponsorAndSubmit(tx);

  return NextResponse.json({ blobId, txDigest: result.digest });
}
```

### POST /api/sponsor

Wraps a user transaction in a sponsored transaction so the user pays no gas.

```typescript
// app/api/sponsor/route.ts
export async function POST(req: NextRequest) {
  const { txBytes, signature } = await req.json();

  // Use Shinami or Enoki gas station API
  // Or use a self-funded sponsor keypair for the hackathon
  const sponsorKeypair = Ed25519Keypair.fromSecretKey(
    process.env.SPONSOR_PRIVATE_KEY!
  );

  const result = await client.executeTransactionBlock({
    transactionBlock: txBytes,
    signature: [signature],
    options: { showEffects: true },
  });

  return NextResponse.json({ digest: result.digest });
}
```

---

## 11. Security Model

### Threat Model

| Threat | How Guardian Wallet Handles It |
|--------|-------------------------------|
| **Token drainer contracts** | AI detects unlimited approval requests + unverified contracts → RED. Requires Ledger. |
| **Phishing dApps** | AI checks contract against verified list + age. New/unverified → elevated risk. |
| **Sandwich attacks / MEV** | Out of scope for hackathon. Not a signing-level concern. |
| **Compromised frontend** | Even if frontend is compromised, it can't bypass Ledger requirement. The Move contract enforces dual-auth. |
| **Compromised AI backend** | If the AI is compromised to always return "green," the worst case is the user signs everything with zkLogin. The Ledger path is an additional check, not the only one. Policy thresholds on-chain enforce hard limits regardless of AI. |
| **Stolen zkLogin session** | Attacker can only auto-sign transactions below policy thresholds. Large/risky txs still need Ledger. |
| **Lost Ledger** | Wallet enters freeze state. Recovery flow: deploy new wallet, migrate assets (requires existing Ledger — if truly lost, social recovery could be added as future work). |

### What This Prevents

1. Signing unlimited token approvals without knowing
2. Interacting with brand-new scam contracts
3. Sending >50% of holdings in a single transaction without physical confirmation
4. Automated draining even if zkLogin session is compromised

### Limitations (be honest in presentation)

1. AI risk scoring is heuristic, not foolproof — a sophisticated scam could score below threshold
2. Verified protocol list is manually maintained in hackathon version
3. The AI cannot protect against contracts that behave differently when called by the actual user vs. devInspect (though this is rare)
4. No protection against smart contract bugs in verified protocols (e.g., if Cetus has a bug, AI still says "green")

---

## 12. Demo Script (3 Minutes)

### Setup Before Demo

- Wallet already created with some USDC + SUI on testnet
- Ledger plugged in (not connected yet — save the connection moment for drama)
- Deploy a fake "scam" contract on testnet that requests unlimited approval
- Have a second browser tab with the Walrus audit log viewer ready

### Script

**[0:00 - 0:30] The Problem**
> "Every day, crypto users lose millions to scam contracts. You either sign every transaction on a hardware wallet — which is slow and painful — or you trust a software wallet and pray. There's no middle ground. Until now."

**[0:30 - 1:00] Normal Transaction (Green)**
> "This is Guardian Wallet. I'm logged in with Google — no wallet setup needed. Let me swap 50 USDC to SUI on Cetus."

*Click swap. Show the brief "Analyzing..." spinner (< 1 second). Transaction auto-submits. Success toast appears.*

> "The AI dry-ran this transaction, verified Cetus is a trusted protocol, checked the amounts were normal, and auto-approved it. I didn't have to do anything."

**[1:00 - 2:00] Malicious Transaction (Red)**
> "Now let me try something dangerous. I got this link from a 'free airdrop' — let's see what happens."

*Click the scam dApp link. Transaction is initiated. "Analyzing..." spinner appears. RED warning modal appears with the AI explanation.*

> "The AI caught it. It says: 'This transaction asks you to approve unlimited USDC spending for a contract that was created yesterday. This pattern matches known token drainer scams.' My risk score is 82 out of 100."

> "The transaction is blocked. I cannot proceed with just Google login. But if I really want to — maybe I know something the AI doesn't — I need my physical Ledger."

*Pull out Ledger. Click "Override with Ledger." Confirm on Ledger device screen. Transaction goes through.*

> "The Ledger is my override key. It only comes out when the AI says something is wrong."

**[2:00 - 2:30] Audit Trail**
> "Every decision the AI makes is permanently logged on Walrus — decentralized, tamper-proof."

*Switch to audit log tab. Show entries: the green auto-approve and the red override, with timestamps, scores, and explanations.*

**[2:30 - 3:00] Closing**
> "Guardian Wallet: your AI security guard with a hardware kill switch. The AI handles the safe stuff silently. When it smells danger, it escalates to your Ledger. You only touch your hardware when it actually matters."

---

## 13. Development Timeline

### Day 1: Foundation (8-10 hours)

**Morning (4h)**
- [ ] Initialize Next.js 14 project with TypeScript + Tailwind + shadcn
- [ ] Set up Sui CLI, create Move project structure
- [ ] Write and test `wallet.move` (GuardianWallet object, create, execute_clean, execute_override, freeze/unfreeze)
- [ ] Write `policy.move` (default policy, update function)
- [ ] Deploy contracts to Sui testnet

**Afternoon (4h)**
- [ ] Implement zkLogin flow (Google OAuth → Sui address)
  - Use @mysten/zklogin with a salt server or Enoki
  - Create wallet on first login
- [ ] Implement Ledger WebHID connection
  - Get Ledger Sui address
  - Store both addresses in the GuardianWallet object during creation
- [ ] Build basic wallet dashboard UI
  - Show balances (SUI, USDC)
  - Transaction list

**Evening (2h)**
- [ ] Deploy a fake "scam" contract on testnet
  - Contract that requests unlimited token approval
  - Contract deployed from a fresh address (will trigger "new contract" signal)
- [ ] Test basic flows: create wallet, send SUI

### Day 2: AI Engine + Core Flow (8-10 hours)

**Morning (4h)**
- [ ] Build POST /api/analyze endpoint
  - devInspectTransactionBlock integration
  - Implement 7 risk signals (start with the top 3: unlimited approvals, contract verification, balance impact)
  - Risk scoring logic
- [ ] Integrate Claude API for explanation generation
- [ ] Build the TransactionBuilder component
  - Simple swap interface (USDC → SUI)
  - "Send USDC" interface

**Afternoon (4h)**
- [ ] Build the RiskModal component
  - Score visualization
  - Plain English explanation
  - Risk signal breakdown
  - "Cancel" and "Override with Ledger" buttons
- [ ] Implement the full transaction flow:
  - User initiates tx → serialize PTB → send to /api/analyze
  - Green: auto-sign with zkLogin keypair → submit → toast
  - Red: show modal → Ledger override flow → submit → toast
- [ ] Set up sponsored transactions (use Enoki or self-funded sponsor)

**Evening (2h)**
- [ ] Implement Walrus audit logging
  - Write audit entries to Walrus on every decision
  - Emit on-chain AuditEvent
- [ ] Build audit history page
  - Fetch events from Sui → fetch blobs from Walrus → display

### Day 3: Polish + Demo (6-8 hours)

**Morning (3h)**
- [ ] Polish UI: loading states, error handling, animations
- [ ] Add the policy settings page (Ledger-required editing)
- [ ] Add emergency freeze button (Ledger-required)
- [ ] Test the full demo flow end-to-end 3 times

**Afternoon (3h)**
- [ ] Record backup demo video (in case Ledger has issues on stage)
- [ ] Write presentation slides (3-5 slides max)
- [ ] Rehearse 3-minute presentation
- [ ] Deploy frontend to Vercel

**Evening (2h)**
- [ ] Final testing on deployed version
- [ ] Prepare Ledger device (Sui app installed, charged)
- [ ] Submit to ETHGlobal

---

## 14. Sui Features Used

### Programmable Transaction Blocks (PTBs)

**Where:** Core to the entire product.

- All DeFi operations (swaps, approvals, transfers) are composed as PTBs
- The auth check (`execute_clean` or `execute_override`) is the first call in the PTB, followed by the actual DeFi operations — all atomic
- `devInspectTransactionBlock` is used to simulate PTBs before signing, which is the foundation of the AI risk engine
- Policy updates are PTBs that combine `execute_override` (Ledger auth) with `update_policy` — atomic auth + edit

**Why Sui:** PTBs allow composing auth + operations in a single atomic transaction. On EVM, you'd need separate approve + execute transactions, which can't be atomically gated.

### zkLogin

**Where:** Primary authentication for onboarding and safe transactions.

- Users sign in with Google OAuth → zkLogin derives a Sui address
- This address is stored as `primary_address` in the GuardianWallet object
- All "green" (safe) transactions are auto-signed using the zkLogin keypair
- Eliminates wallet setup friction — users never need to manage seed phrases for daily use

**Why Sui:** zkLogin is Sui-native. No equivalent exists on EVM without complex account abstraction setups.

### Sponsored Transactions

**Where:** Every transaction the user makes.

- A backend gas station (Enoki/Shinami or self-funded) sponsors gas for all transactions
- Users never see gas fees — the wallet is completely gasless
- Critical for the UX: "auto-signed" transactions should be invisible, and a gas popup would break that

**Why Sui:** Sui has native transaction sponsorship. On EVM, you need EIP-4337 bundlers and paymasters — much more complex for a hackathon.

### Sui Object Model

**Where:** Wallet architecture.

- `GuardianWallet` is a Sui object owned by the user. It stores both auth addresses and the frozen state.
- `Policy` is a shared Sui object. It stores risk thresholds and is readable by the AI engine.
- Audit events reference Walrus blob IDs, creating a bridge between on-chain indexing and off-chain storage.
- Each wallet is its own object — no global state contention.

**Why Sui:** The object-centric model maps naturally to "one wallet = one object." On EVM, you'd need a factory pattern with proxy contracts — more gas, more complexity.

### Walrus

**Where:** Audit trail storage.

- Every AI decision (score, explanation, signals, simulation results) is stored as a JSON blob on Walrus
- On-chain events reference the Walrus blob ID, so the audit trail is decentralized but indexable
- The audit log page fetches events from Sui → resolves blob IDs → displays full decision history
- If the project adds a dispute resolution feature later, the Walrus audit trail is the evidence

**Why Walrus:** Traditional databases are centralized and mutable. Walrus provides tamper-proof storage without the gas cost of putting full audit data on-chain. The on-chain event + Walrus blob pattern is the best of both worlds.
