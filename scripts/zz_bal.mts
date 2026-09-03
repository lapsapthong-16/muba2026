import { getBalance, NETWORK } from '../lib/sui'
const addrs: [string,string][] = [
  ['3dd6cf74 H', '0xc370d09a630f416b68d96197d6ee9d4f94ef16bb834b4ec6844c50db2307bf37'],
  ['3dd6cf74 M', '0x033034563fc5765283e23f23fcc962180f5298acdfe209b9ca94b16ac0533e46'],
  ['60e30f85 H', '0x9ff82597da914b6cd4e13aac941a1fc3ae07b91c3ff2528c3192422605f2e3ed'],
  ['60e30f85 M', '0xfcf3de91720ef379d7bdb467a42348a25a0d5b262924c9aed340559b79607b0c'],
]
console.log('network', NETWORK)
for (const [n,a] of addrs) console.log(n, a.slice(0,10), Number(await getBalance(a))/1e9, 'SUI')
