/**
 * SHOPPING AGENT — buys tools from the ferretería.
 * Registers its identity with the VERIFIER (not the shop!), then
 * makes RFC 9421-signed purchases at the shop.
 *
 * Run last: node agent.js
 */

const crypto = require('crypto');
const fs = require('fs');
const { signRequest } = require('./httpsig');
const { buildPayment } = require('./x402');

const VERIFIER = 'http://localhost:4000';
const FACILITATOR = 'http://localhost:4001';
const SHOP = 'http://localhost:3000';
const PANADERIA = 'http://localhost:3001';
const AGENT_ID = 'obra-supplies-agent';
const KEY_FILE = 'agent-key.json';

function identity() {
  if (fs.existsSync(KEY_FILE)) {
    const s = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    return { privateKey: crypto.createPrivateKey(s.privateKeyPem), publicKeyPem: s.publicKeyPem };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(KEY_FILE, JSON.stringify({
    publicKeyPem, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }, null, 2));
  return { privateKey, publicKeyPem };
}

const id = identity();

async function buy(shopUrl, sku, amountCents) {
  const body = JSON.stringify({ sku, amountCents });

  // Each attempt gets a FRESH identity signature: the verifier burns
  // the nonce on every verification, so replaying the first attempt's
  // headers on the paid retry would be rejected as a replay. Identity
  // nonces are one-shot; the retry is a NEW request that happens to
  // carry a payment.
  const attempt = (extraHeaders = {}) => fetch(shopUrl + '/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...signRequest({ method: 'POST', path: '/checkout', bodyString: body,
                       keyid: AGENT_ID, privateKey: id.privateKey }),
      ...extraHeaders,
    },
    body,
  });

  let res = await attempt();

  if (res.status === 402) {
    const terms = await res.json();
    const requirements = terms.accepts?.[0];
    console.log(`  💳 402 — paying ${(requirements.maxAmountRequiredCents / 100).toFixed(2)}€ to ${requirements.payTo}, retrying`);
    const xPayment = buildPayment({ requirements, from: AGENT_ID, privateKey: id.privateKey });
    res = await attempt({ 'X-PAYMENT': xPayment });
  }

  console.log(`  buy ${sku} (${(amountCents / 100).toFixed(2)}€):`, res.status, await res.json());
}

async function main() {
  console.log('— Registering identity with the VERIFIER (one time, works at every shop using it)');
  await fetch(VERIFIER + '/agents/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: AGENT_ID, publicKeyPem: id.publicKeyPem,
      ownerName: 'Troy', maxPerTxCents: 10000, maxPerDayCents: 15000,
    }),
  });

  console.log('\n— Topping up the agent wallet at the facilitator faucet (150.00€ testnet)');
  await fetch(FACILITATOR + '/faucet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: AGENT_ID, publicKeyPem: id.publicKeyPem, amountCents: 15000 }),
  });

  console.log('\n— Shopping at the FERRETERÍA:');
  await buy(SHOP, 'taladro', 8990);       // fine
  await buy(SHOP, 'tornillos', 1250);     // fine (102.40€ today)

  console.log('\n— SAME identity, shopping at the PANADERÍA:');
  await buy(PANADERIA, 'croissants', 780);   // fine (110.20€ today)
  await buy(PANADERIA, 'tarta', 1850);       // fine (128.70€ today)
  await buy(PANADERIA, 'tarta', 1850);       // fine (147.20€ today)
  await buy(PANADERIA, 'croissants', 780);   // daily mandate says NO (would be 155.00€)

  console.log('\n— An unsigned bot tries the ferretería checkout:');
  const res = await fetch(SHOP + '/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'taladro', amountCents: 8990 }),
  });
  console.log('  bot:', res.status, await res.json());

  console.log('\n— The money view: GET verifier /billing (TWO invoices now)');
  console.log(await (await fetch(VERIFIER + '/billing')).json());

  console.log('\n— The LEDGER: GET facilitator /balances (real money moved)');
  console.log(await (await fetch(FACILITATOR + '/balances')).json());
}

main().catch(console.error);
