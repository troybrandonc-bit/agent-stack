/**
 * Generate the agent's wallet: a real Ethereum-style keypair.
 *
 * Same concept as agent-key.json in the prototype — an identity that IS
 * a keypair — but this one can hold and authorize real (testnet) USDC.
 *
 * Run once:  npm run wallet
 * Then fund the printed address at Circle's faucet (see README).
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import fs from 'fs';

if (fs.existsSync('.env')) {
  console.log('.env already exists — refusing to overwrite an existing wallet.');
  console.log('Delete .env manually if you really want a new one (the old funds stay at the old address forever).');
  process.exit(1);
}

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

fs.writeFileSync('.env', `# NEVER commit this file. NEVER share the private key.\nAGENT_PRIVATE_KEY=${privateKey}\nSHOP_ADDRESS=${account.address}\n`);

console.log('Agent wallet created and saved to .env');
console.log('');
console.log('  Address:', account.address);
console.log('');
console.log('Next: fund it with FREE testnet USDC:');
console.log('  1. Go to https://faucet.circle.com');
console.log('  2. Select network: Base Sepolia');
console.log('  3. Paste the address above, request USDC (10 test-USDC typical)');
console.log('');
console.log('(For the demo the shop receives payments at this same address —');
console.log(' the agent pays itself, so your test USDC recycles forever.)');
