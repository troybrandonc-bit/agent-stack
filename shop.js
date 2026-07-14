/**
 * FERRETERÍA ONLINE — a random merchant on the internet. Port 3000.
 *
 * Note what ISN'T here: no crypto, no registry, no nonces, no RFC 9421.
 * The shop knows nothing about agent security. It installed the SDK.
 * The integration is the three marked lines. That's the entire pitch:
 * "agent-ready in one afternoon."
 *
 * Run: node shop.js   (with verifier-service.js already running)
 */

const express = require('express');
const Database = require('better-sqlite3');
const agentReady = require('./agent-ready-sdk');
const { paymentRequired } = require('./x402');                       // (1)

const FACILITATOR = 'http://localhost:4001';

// The shop's own books: what did we actually deliver, and for which tx?
// Without this, a crash between "money settled" and "goods served"
// leaves money the shop can't account for. Memory isn't enough — a crash
// wipes it, which is precisely the case we're defending against.
const books = new Database('shop.db');
books.pragma('journal_mode = WAL');
books.exec(`CREATE TABLE IF NOT EXISTS fulfilled (
  tx_id TEXT PRIMARY KEY, sku TEXT NOT NULL, agent_id TEXT NOT NULL, created_at INTEGER NOT NULL
)`);

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

const verify = agentReady({ apiKey: 'mk_test_ferreteria' });           // (2)
const commit = agentReady.commit({ apiKey: 'mk_test_ferreteria' });
const release = agentReady.release({ apiKey: 'mk_test_ferreteria' });

const CATALOG = {
  'taladro':   { name: 'Taladro percutor',    priceCents: 8990 },
  'tornillos': { name: 'Caja tornillos 500u', priceCents: 1250 },
  'guantes':   { name: 'Guantes de trabajo',  priceCents:  875 },
};

app.get('/catalog', (_req, res) => res.json(CATALOG));

const paid = paymentRequired({                                         // (4)
  payTo: 'ferreteria-online',
  amountCents: (req) => CATALOG[req.body?.sku]?.priceCents,
  description: 'Ferretería checkout',
  onFailure: (req) => release(req.agentHoldId),   // no sale → free the hold
});

app.post('/checkout', verify, paid, async (req, res) => {              // (3)
  const product = CATALOG[req.body.sku];
  if (!product) {
    await release(req.agentHoldId);
    return res.status(404).json({ error: 'Unknown SKU' });
  }

  // CRASH SIMULATION: run with CRASH_AFTER_SETTLE=1 to kill the shop right
  // here — money settled, goods never served. Restart it and watch
  // reconciliation clean up by itself.
  if (process.env.CRASH_AFTER_SETTLE === '1') {
    console.log(`💥 CRASHING after settlement of ${req.payment.transaction} — goods NOT served`);
    process.exit(1);
  }

  // Record fulfillment BEFORE answering: crash after this line and the
  // books know the sale completed; crash before it and the reconciler
  // finds the orphaned money and refunds it.
  books.prepare(`INSERT OR IGNORE INTO fulfilled (tx_id, sku, agent_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(req.payment.transaction, req.body.sku, req.agent.id, Date.now());

  commit(req.agent.id, product.priceCents, req.agentHoldId); // capture: NOW it counts
  console.log(`🛒 SALE+PAID: ${product.name} to agent "${req.agent.id}" — tx ${req.payment.transaction}`);
  res.json({ ok: true, sold: product.name, paid: req.payment });
});

/**
 * RECONCILIATION: every settlement we received must match goods we
 * delivered. Anything settled but unfulfilled is money we shouldn't
 * have — refund it. Runs at startup (post-crash recovery) and on a timer.
 */
async function reconcile() {
  try {
    const settlements = await fetch(`${FACILITATOR}/settlements/ferreteria-online`).then(r => r.json());
    const orphans = settlements.filter(s =>
      !s.reversed_at &&
      Date.now() - s.created_at > 5_000 &&                    // grace for in-flight requests
      !books.prepare(`SELECT 1 FROM fulfilled WHERE tx_id = ?`).get(s.tx_id)
    );

    for (const o of orphans) {
      console.log(`🔍 RECONCILE: ${o.tx_id} settled ${(o.amount_cents / 100).toFixed(2)}€ but nothing was delivered → refunding`);
      await fetch(`${FACILITATOR}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: o.tx_id, reason: 'unfulfilled: no delivery recorded' }),
      });
    }
  } catch { /* facilitator unreachable — retry next tick */ }
}

setTimeout(reconcile, 2_000);      // post-restart recovery sweep
setInterval(reconcile, 15_000);    // and periodically thereafter

app.listen(3000, () => console.log('FERRETERÍA (a merchant using the SDK) on http://localhost:3000\n'));
