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

// INTENT: written BEFORE the settle call, which is the whole point.
// The old code had no durable row until after the money moved, so a crash
// in between left nothing to recover from — we papered over it by listing
// every settlement for this payee, which works on a SQLite ledger and
// falls apart on a real chain where enumeration is slow and costs money.
// With an intent row we can ask one question by one ref.
//
// States: intended → settled → captured
//   intended, nothing on the network  = the call never happened. Safe.
//   intended, settled on the network  = money moved, we don't know it. Recover.
//   settled, not captured             = money moved, mandate never counted. Recover.
books.exec(`CREATE TABLE IF NOT EXISTS intents (
  intent_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  hold_id TEXT,
  tx_id TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
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
  // Release whatever the identity layer held, on every exit that isn't a
  // completed sale. BREAK_RELEASE=1 simulates this call failing, which is
  // the whole reason the verifier also supersedes by intent id: this is a
  // network call, and network calls fail. Belt (release) and braces
  // (supersede). Run the demo with BREAK_RELEASE=1 to exercise the braces.
  onFailure: (req) => process.env.BREAK_RELEASE ? Promise.resolve() : release(req.agentHoldId),   // no sale → free the hold

  // Called immediately BEFORE the settle request goes out. This is the
  // durable "I am about to move money" row. If we die one line later,
  // this is the only thing that lets us find out what happened.
  beforeSettle: (req, intentRef) => {
    books.prepare(`INSERT OR REPLACE INTO intents
      (intent_id, agent_id, sku, amount_cents, hold_id, state, created_at)
      VALUES (?, ?, ?, ?, ?, 'intended', ?)`)
      .run(intentRef, req.agent.id, req.body.sku, CATALOG[req.body.sku].priceCents,
           req.agentHoldId ?? null, Date.now());
  },
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

  // Settlement happened. Record it against the intent first, so a crash
  // from here on is recoverable by ref rather than by guesswork.
  books.prepare(`UPDATE intents SET tx_id = ?, state = 'settled' WHERE intent_id = ?`)
    .run(req.payment.transaction, req.intentRef);

  books.prepare(`INSERT OR IGNORE INTO fulfilled (tx_id, sku, agent_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(req.payment.transaction, req.body.sku, req.agent.id, Date.now());

  await commit(req.agent.id, product.priceCents, req.agentHoldId, req.intentRef); // capture: NOW it counts, once
  books.prepare(`UPDATE intents SET state = 'captured' WHERE intent_id = ?`).run(req.intentRef);
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
    // Start from OUR intents, not from the network's list. Every row here
    // is a purchase we know we started; the network is asked one point
    // question per row. No enumeration, no "list the world".
    const open = books.prepare(
      `SELECT * FROM intents WHERE state IN ('intended','settled') AND created_at < ?`
    ).all(Date.now() - 5_000);   // grace for in-flight requests

    for (const i of open) {
      // The ambiguity the whole design exists for: we have an intent and
      // no capture. That does NOT mean the call never happened. Ask.
      const s = await fetch(`${FACILITATOR}/settlement-by-ref/${i.intent_id}`).then(r => r.json());

      if (!s) {
        // Genuinely never settled. Nothing moved. Free the hold and forget.
        await release(i.hold_id);
        books.prepare(`DELETE FROM intents WHERE intent_id = ?`).run(i.intent_id);
        console.log(`🔍 RECONCILE: ${i.intent_id} never settled — hold released, intent dropped`);
        continue;
      }
      if (s.reversed_at) {
        books.prepare(`DELETE FROM intents WHERE intent_id = ?`).run(i.intent_id);
        continue;
      }

      const delivered = books.prepare(`SELECT 1 FROM fulfilled WHERE tx_id = ?`).get(s.tx_id);

      if (!delivered) {
        // Money moved, goods didn't. Refund.
        console.log(`🔍 RECONCILE: ${s.tx_id} settled ${(s.amount_cents / 100).toFixed(2)}€ but nothing was delivered → refunding`);
        await fetch(`${FACILITATOR}/refund`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction: s.tx_id, reason: 'unfulfilled: no delivery recorded' }),
        });
        await release(i.hold_id);
        books.prepare(`DELETE FROM intents WHERE intent_id = ?`).run(i.intent_id);
      } else {
        // The gap nobody had on their list: money moved, goods DELIVERED,
        // and we died before committing the spend. The mandate never
        // counted it, so the agent's daily limit is quietly wrong across
        // every merchant. Finish the job.
        console.log(`🔍 RECONCILE: ${s.tx_id} delivered but never committed → committing spend now`);
        await commit(i.agent_id, i.amount_cents, i.hold_id, i.intent_id);
        books.prepare(`UPDATE intents SET state = 'captured' WHERE intent_id = ?`).run(i.intent_id);
      }
    }
  } catch { /* facilitator unreachable — retry next tick */ }
}

setTimeout(reconcile, 2_000);      // post-restart recovery sweep
setInterval(reconcile, 15_000);    // and periodically thereafter

// DEV ONLY — the shop's own books: intents and deliveries.
if (process.env.ALLOW_DEV_RESET === '1') {
  app.post('/dev/reset', (_req, res) => {
    books.exec(`DELETE FROM intents; DELETE FROM fulfilled;`);
    console.log('🧹 DEV RESET — shop books cleared');
    res.json({ ok: true });
  });
}

app.listen(3000, () => console.log('FERRETERÍA (a merchant using the SDK) on http://localhost:3000\n'));
