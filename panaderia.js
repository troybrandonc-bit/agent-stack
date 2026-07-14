/**
 * PANADERÍA LA ESPIGA — a second, unrelated merchant. Port 3001.
 *
 * Identical SDK, different API key. This file existing at all is the
 * point: the SECOND customer costs you (the verifier company) zero
 * new code. That's the SaaS shape — build once, sell N times.
 *
 * Run: node panaderia.js   (with verifier-service.js running)
 */

const express = require('express');
const agentReady = require('./agent-ready-sdk');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

const verify = agentReady({ apiKey: 'mk_test_panaderia' });
const commit = agentReady.commit({ apiKey: 'mk_test_panaderia' });
const release = agentReady.release({ apiKey: 'mk_test_panaderia' });

const CATALOG = {
  'barra':      { name: 'Barra de pan',     priceCents:  120 },
  'croissants': { name: 'Croissants x6',    priceCents:  780 },
  'tarta':      { name: 'Tarta de manzana', priceCents: 1850 },
};

app.get('/catalog', (_req, res) => res.json(CATALOG));

app.post('/checkout', verify, async (req, res) => {
  const product = CATALOG[req.body.sku];
  if (!product) {
    await release(req.agentHoldId);
    return res.status(404).json({ error: 'Unknown SKU' });
  }

  commit(req.agent.id, product.priceCents, req.agentHoldId); // capture
  console.log(`🥖 SALE: ${product.name} to agent "${req.agent.id}" (owner: ${req.agent.owner})`);
  res.json({ ok: true, sold: product.name, to: req.agent });
});

app.listen(3001, () => console.log('PANADERÍA (second merchant, same SDK) on http://localhost:3001\n'));
