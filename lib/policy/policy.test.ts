import { PolicySchema, evaluate, type Evidence } from './policy'

const SELF = '0x1111111111111111111111111111111111111111111111111111111111111111'
const ATTACKER = '0x9999999999999999999999999999999999999999999999999999999999999999'
const DEEPBOOK = '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809'
const DBUSDC = '0xf7152c05930530cd9cc7ff2b53d8dcccb1e93f9d5f04b73a58fa4b0e6d0b1a1a::dbusdc::DBUSDC'

const policy = PolicySchema.parse({
  version: 1,
  walletAddress: SELF,
  caps: [
    { coinType: '0x2::sui::SUI', symbol: 'SUI', decimals: 9, perTxLimit: '10000000000', weeklyLimit: '50000000000' },
    { coinType: DBUSDC, symbol: 'DBUSDC', decimals: 6, perTxLimit: '10000000', weeklyLimit: '50000000' },
  ],
  allowedRecipients: [],
  allowedPackages: [{ packageId: DEEPBOOK, label: 'DeepBook' }, { packageId: '0x2', label: 'Sui Framework' }],
})
console.log('policy parsed. SUI cap key =', policy.caps[0].coinType)

const gasUsed = { computationCost: '1000000', storageCost: '2953600', storageRebate: '2000000' }

// DEMO 1 — DeepBook swap. Verified live: -1.914 SUI / +1.3756 DBUSDC.
const swap: Evidence = {
  balanceChanges: [
    { coinType: '0x2::sui::SUI', address: SELF, amount: '-1914000000' },
    { coinType: DBUSDC, address: SELF, amount: '1375600' },
  ],
  gasUsed, gasCoinType: '0x2::sui::SUI',
  movePackages: [DEEPBOOK, '0x2'],
  simulationOk: true,
}
console.log('\n--- DEMO 1: DeepBook trade ---')
console.log(JSON.stringify(evaluate(policy, swap, () => 0n), null, 2))

// DEMO 2 — "Transfer all my funds to <random address>"
const drain: Evidence = {
  balanceChanges: [
    { coinType: '0x2::sui::SUI', address: SELF, amount: '-200001953600' },
    { coinType: '0x2::sui::SUI', address: ATTACKER, amount: '200000000000' },
  ],
  gasUsed, gasCoinType: '0x2::sui::SUI',
  movePackages: ['0x2'],
  simulationOk: true,
}
console.log('\n--- DEMO 2: drain ---')
const drainVerdict = evaluate(policy, drain, () => 0n)
console.log(JSON.stringify(drainVerdict, null, 2))

// EDGE — weekly cap already 48 SUI spent, small 3 SUI transfer to a known friend
console.log('\n--- EDGE: weekly cap exhausted ---')
const small: Evidence = { ...drain, balanceChanges: [
  { coinType: '0x2::sui::SUI', address: SELF, amount: '-3001953600' },
  { coinType: '0x2::sui::SUI', address: ATTACKER, amount: '3000000000' },
]}
console.log(JSON.stringify(evaluate(policy, small, () => 48_000_000_000n).reasons, null, 2))
if (!evaluate(policy, small, () => 0n).consultGonka) {
  console.log('\nFAILING: Ledger-review transfers must request Gonka consensus')
  process.exit(1)
}

// EDGE — receiving an unconfigured coin must NOT deny; spending one must.
console.log('\n--- EDGE: unconfigured coin ---')
const recv: Evidence = { ...swap, balanceChanges: [
  { coinType: '0x2::sui::SUI', address: SELF, amount: '-1953600' },
  { coinType: '0xdead::weird::WEIRD', address: SELF, amount: '5000' },
]}
console.log('receive unconfigured:', evaluate(policy, recv, () => 0n).verdict)
const spendUnknown: Evidence = { ...recv, balanceChanges: [
  { coinType: '0x2::sui::SUI', address: SELF, amount: '-1953600' },
  { coinType: '0xdead::weird::WEIRD', address: SELF, amount: '-5000' },
]}
const r = evaluate(policy, spendUnknown, () => 0n)
console.log('spend unconfigured:', r.verdict, '|', r.reasons[0]?.human)

// EDGE — precision: 100000000000000001 base units must survive
console.log('\n--- EDGE: precision ---')
const big = PolicySchema.parse({ ...policy, caps: [{ coinType: '0x2::sui::SUI', symbol: 'SUI', decimals: 9, perTxLimit: '100000000000000001', weeklyLimit: '100000000000000001' }] })
console.log('cap round-trip:', big.caps[0].perTxLimit, '| Number() would give', Number('100000000000000001'))

// EDGE — long-form coin type in balanceChanges still matches a short-form cap
const longForm: Evidence = { ...swap, balanceChanges: [{ coinType: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI', address: SELF, amount: '-1914000000' }] }
console.log('long-form coinType matches cap:', evaluate(policy, longForm, () => 0n).verdict === 'allow')

// EDGE — capability handover. THE case balance changes cannot see: the only balance row is gas,
// so without objectTransfers this returns "allow" while the wallet loses irrevocable authority.
console.log('\n--- EDGE: capability handover (gas-only balance change) ---')
const capGrab: Evidence = {
  balanceChanges: [{ coinType: '0x2::sui::SUI', address: SELF, amount: '-1017024' }],
  gasUsed: { computationCost: '1000000', storageCost: '2953600', storageRebate: '2936576' },
  gasCoinType: '0x2::sui::SUI',
  movePackages: ['0x2'],
  simulationOk: true,
  objectTransfers: [{
    objectId: '0xcap', objectType: '0x2::coin::TreasuryCap<0xabc::tok::TOK>',
    to: ATTACKER, isCapability: true,
  }],
}
const withoutSignal = evaluate(policy, { ...capGrab, objectTransfers: [] }, () => 0n)
const withSignal = evaluate(policy, capGrab, () => 0n)
console.log('  without objectTransfers ->', withoutSignal.verdict, '(this is the hole)')
console.log('  with    objectTransfers ->', withSignal.verdict, '|', withSignal.reasons[0]?.human)

console.log('\n--- EDGE: ordinary NFT to an unknown address ---')
const nft = evaluate(policy, { ...capGrab, objectTransfers: [{
  objectId: '0xnft', objectType: '0xabc::art::Piece', to: ATTACKER, isCapability: false }] }, () => 0n)
console.log('  ->', nft.verdict, '|', nft.reasons[0]?.human)

// EDGE — sponsored gas. Measured live: for the SAME 10,000,000 MIST transfer the sender's delta is
// -12,007,760 self-paid but -10,000,000 sponsored, because the sponsor's coin covers gas. Netting
// gas out of a sponsored transaction under-counts the spend, which is the permissive direction.
console.log('\n--- EDGE: sponsored vs self-paid spend arithmetic ---')
const gasUsedReal = { computationCost: '1000000', storageCost: '1976000', storageRebate: '968240' } // net 2,007,760
const selfPaid: Evidence = {
  balanceChanges: [{ coinType: '0x2::sui::SUI', address: SELF, amount: '-12007760' }],
  gasUsed: gasUsedReal, gasCoinType: '0x2::sui::SUI', movePackages: ['0x2'],
  gasPaidBySender: true, simulationOk: true,
}
const sponsored: Evidence = {
  ...selfPaid,
  balanceChanges: [{ coinType: '0x2::sui::SUI', address: SELF, amount: '-10000000' }],
  gasPaidBySender: false,
}
const a = evaluate(policy, selfPaid, () => 0n).outflows[0]?.principal
const b = evaluate(policy, sponsored, () => 0n).outflows[0]?.principal
const wrong = evaluate(policy, { ...sponsored, gasPaidBySender: true }, () => 0n).outflows[0]?.principal
console.log('  self-paid  ->', a, a === '10000000' ? 'OK' : 'WRONG')
console.log('  sponsored  ->', b, b === '10000000' ? 'OK' : 'WRONG')
console.log('  sponsored mislabelled self-paid ->', wrong, '(under-counts by the gas: permissive)')
if (a !== '10000000' || b !== '10000000') { console.log('\nFAILING'); process.exit(1) }

// EDGE — the gas sponsor must never be counted as a payee.
// Merging coins DELETES objects, so the storage rebate can exceed the fee and leave the sponsor
// with a POSITIVE balance delta. Unhandled, a payment to an allowlisted address escalates with
// "Money is going to 0x1c1a…8b6c" — which is the gas station. And Shinami's sponsor address
// rotates between transactions, so it can never simply be allowlisted.
console.log('\n--- EDGE: sponsor is not a recipient ---')
const SPONSOR = '0x1c1a56df0bd80abc6dd097b98cd4ff341c3ef2bdb0f2ea7d0ebd87eff3268b6c'
const FRIEND = '0x2222222222222222222222222222222222222222222222222222222222222222'
const withFriend = PolicySchema.parse({
  ...policy, version: 2,
  allowedRecipients: [{ address: FRIEND, label: 'friend' }],
})
const rebateHeavy: Evidence = {
  balanceChanges: [
    { coinType: '0x2::sui::SUI', address: SELF, amount: '-5000000' },
    { coinType: '0x2::sui::SUI', address: FRIEND, amount: '5000000' },
    { coinType: '0x2::sui::SUI', address: SPONSOR, amount: '2902600' },
  ],
  gasUsed: { computationCost: '1000000', storageCost: '100000', storageRebate: '4002600' },
  gasCoinType: '0x2::sui::SUI', movePackages: ['0x2'],
  gasPaidBySender: false, gasOwner: SPONSOR, simulationOk: true,
}
const rb = evaluate(withFriend, rebateHeavy, () => 0n)
console.log('  rebate-positive sponsor ->', rb.verdict, `| recipients: ${rb.recipients.length}`,
  rb.verdict === 'allow' && rb.recipients.length === 1 ? 'OK' : 'WRONG')

// ...but a sponsor that is ALSO a genuine payee must still be caught.
const sponsorPaid = evaluate(withFriend, { ...rebateHeavy, balanceChanges: [
  { coinType: '0x2::sui::SUI', address: SELF, amount: '-1005000000' },
  { coinType: '0x2::sui::SUI', address: FRIEND, amount: '5000000' },
  { coinType: '0x2::sui::SUI', address: SPONSOR, amount: '1002902600' },
]}, () => 0n)
console.log('  sponsor also a payee    ->', sponsorPaid.verdict, `| recipients: ${sponsorPaid.recipients.length}`,
  sponsorPaid.recipients.length === 2 ? 'OK (still flagged)' : 'WRONG')
if (rb.verdict !== 'allow' || sponsorPaid.recipients.length !== 2) { console.log('\nFAILING'); process.exit(1) }
