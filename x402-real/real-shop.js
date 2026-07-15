/**
 * THE SHOP — real x402 this time.
 *
 * Compare with the prototype's shop.js + x402.js: the 402 → X-PAYMENT →
 * settle choreography you built by hand is now handled by the official
 * @x402 middleware, and settlement is REAL — the facilitator at
 * x402.org executes an on-chain USDC transfer on Base Sepolia and pays
 * the gas. You'll get a transaction hash you can look up on
 * https://sepolia.basescan.org
 *
 * Run:  npm run shop     (after wallet + faucet steps)
 */

import 'dotenv/config';
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

const payTo = process.env.SHOP_ADDRESS;
if (!payTo) { console.error('Run `npm run wallet` first.'); process.exit(1); }

const app = express();

// The REAL testnet facilitator — this replaces our facilitator.js
const facilitatorClient = new HTTPFacilitatorClient({ url: 'https://x402.org/facilitator' });

// eip155:84532 = Base Sepolia testnet (CAIP-2 chain id).
// Careful: 8453 without the 2 is Base MAINNET — real money. Don't.
const server = new x402ResourceServer(facilitatorClient)
  .register('eip155:84532', new ExactEvmScheme());

app.use(
  paymentMiddleware(
    {
      'GET /catalog/taladro': {
        accepts: [{
          scheme: 'exact',
          price: '$0.01',              // one testnet cent, converted to USDC atomic units
          network: 'eip155:84532',
          payTo,
        }],
        description: 'Taladro percutor — pay-per-purchase via x402',
        mimeType: 'application/json',
      },
    },
    server,
  ),
);

app.get('/catalog/taladro', (req, res) => {
  console.log('🛒 SALE (real x402): taladro sold — payment settled ON-CHAIN');
  res.json({ ok: true, sold: 'Taladro percutor', network: 'base-sepolia' });
});

app.listen(3000, () => {
  console.log('REAL-X402 SHOP on http://localhost:3000');
  console.log(`Receiving USDC at ${payTo} (Base Sepolia)\n`);
});
