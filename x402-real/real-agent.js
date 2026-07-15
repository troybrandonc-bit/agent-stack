/**
 * THE AGENT — pays with real (testnet) USDC.
 *
 * Compare with the prototype's agent.js buy(): the 402-catch, payment
 * construction and retry you wrote by hand is what wrapFetchWithPayment
 * does — except the "payment" is now an EIP-3009 transferWithAuthorization
 * signature over real USDC, and the facilitator submits it on-chain.
 *
 * The agent NEVER sends a blockchain transaction itself and pays no gas —
 * it only signs an authorization. Exactly like our mock, one level up.
 *
 * Run:  npm run agent    (with the shop running)
 */

import 'dotenv/config';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
console.log('Agent wallet:', account.address);

const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    { network: 'eip155:84532', client: new ExactEvmScheme(account) }, // Base Sepolia
  ],
});

console.log('Buying the taladro (will auto-handle 402 → sign USDC authorization → retry)…\n');

const res = await paidFetch('http://localhost:3000/catalog/taladro');
const data = await res.json();

console.log('Response:', data);

// The on-chain receipt travels back in this header:
const receipt = res.headers.get('payment-response') ?? res.headers.get('x-payment-response');
if (receipt) {
  const decoded = JSON.parse(Buffer.from(receipt, 'base64').toString('utf8'));
  console.log('\nSettlement receipt:', decoded);
  if (decoded.transaction) {
    console.log(`\n🔗 See YOUR transaction on the public blockchain:`);
    console.log(`   https://sepolia.basescan.org/tx/${decoded.transaction}`);
  }
}
