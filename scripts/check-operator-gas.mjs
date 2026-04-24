#!/usr/bin/env node
/**
 * Operator wallet gas monitor.
 *
 * Reads OPERATOR_PRIVATE_KEY from env, derives the address, and queries
 * native gas balance from each registered chain RPC.
 *
 * Exit codes:
 *   0 — all chains have balance >= THRESHOLD
 *   1 — at least one chain below threshold (cron should page)
 *   2 — env var missing or RPC unreachable
 *
 * Usage:
 *   OPERATOR_PRIVATE_KEY=0x... KITE_TESTNET_RPC_URL=https://... \
 *     node scripts/check-operator-gas.mjs
 *
 * For Railway cron integration:
 *   railway run --service=wasiai-facilitator npm run ops:check-gas
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, formatEther } from 'viem';

const THRESHOLD_WEI = 100_000_000_000_000_000n; // 0.1 KITE/AVAX

const CHAINS = [
  { name: 'Kite Testnet', envVar: 'KITE_TESTNET_RPC_URL', chainId: 2368, symbol: 'KITE' },
  { name: 'Kite Mainnet', envVar: 'KITE_MAINNET_RPC_URL', chainId: 2366, symbol: 'KITE' },
  { name: 'Avalanche Fuji', envVar: 'AVALANCHE_FUJI_RPC_URL', chainId: 43113, symbol: 'AVAX' },
];

const pk = process.env.OPERATOR_PRIVATE_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error('ERROR: OPERATOR_PRIVATE_KEY missing or malformed');
  process.exit(2);
}

const account = privateKeyToAccount(pk);
console.log(`Operator: ${account.address}\n`);

let anyBelow = false;

for (const chain of CHAINS) {
  const rpcUrl = process.env[chain.envVar];
  if (!rpcUrl) {
    console.log(`  ${chain.name.padEnd(20)} SKIP (${chain.envVar} not set)`);
    continue;
  }
  try {
    const client = createPublicClient({ transport: http(rpcUrl) });
    const balance = await client.getBalance({ address: account.address });
    const formatted = formatEther(balance);
    const ok = balance >= THRESHOLD_WEI;
    const marker = ok ? '✅' : '⚠️  LOW';
    console.log(`  ${chain.name.padEnd(20)} ${formatted.padStart(18)} ${chain.symbol} ${marker}`);
    if (!ok) anyBelow = true;
  } catch (err) {
    console.log(`  ${chain.name.padEnd(20)} ERROR: ${err.shortMessage ?? err.message}`);
    anyBelow = true;
  }
}

if (anyBelow) {
  console.error('\n❌ At least one chain below threshold — refuel operator wallet.');
  process.exit(1);
}

console.log('\n✅ All chains above threshold.');
process.exit(0);
