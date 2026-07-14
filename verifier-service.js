/**
 * VERIFIER SERVICE — port 4000.
 *
 * THIS is the product. The closed, hosted core:
 *   - the agent registry ("know your agent")
 *   - signature verification (RFC 9421)
 *   - nonce replay protection
 *   - spending mandates
 *   - and the billing meter: every verification a merchant asks for
 *     is counted against their API key. That counter is the invoice.
 *
 * Merchants never see this code. They talk to it through the open SDK.
 *
 * Run: node verifier-service.js
 */

const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { verifyRequest, parseSignatureInput } = require('./httpsig');

const db = new Database('verifier.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    agent_id        TEXT PRIMARY KEY,
    public_key      TEXT NOT NULL,
    owner_name      TEXT NOT NULL,
    max_per_tx_cents  INTEGER NOT NULL,
    max_per_day_cents INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS spends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS holds (
    hold_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS merchants (
    api_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    verifications INTEGER NOT NULL DEFAULT 0
  );
`);

// Seed merchant API keys (in real life: a signup flow)
db.prepare(`INSERT OR IGNORE INTO merchants (api_key, name) VALUES (?, ?)`)
  .run('mk_test_ferreteria', 'Ferretería Online Demo');
db.prepare(`INSERT OR IGNORE INTO merchants (api_key, name) VALUES (?, ?)`)
  .run('mk_test_panaderia', 'Panadería La Espiga');

const app = express();
app.use(express.json());

/** Format integer cents as a euro string — ONLY at print time. */
const euros = (cents) => (cents / 100).toFixed(2) + '€';

/** Agent onboarding — the KYA step. */
app.post('/agents/register', (req, res) => {
  const { agentId, publicKeyPem, ownerName, maxPerTxCents, maxPerDayCents } = req.body;
  if (!agentId || !publicKeyPem) return res.status(400).json({ error: 'agentId and publicKeyPem required' });
  if (!Number.isInteger(maxPerTxCents) || !Number.isInteger(maxPerDayCents)) {
    return res.status(400).json({ error: 'Mandates must be INTEGER cents (e.g. 5000 = 50.00€).' });
  }

  db.prepare(`INSERT OR REPLACE INTO agents VALUES (?, ?, ?, ?, ?)`)
    .run(agentId, publicKeyPem, ownerName ?? 'unknown', maxPerTxCents, maxPerDayCents);

  console.log(`✔ KYA: registered agent "${agentId}" (${ownerName})`);
  res.json({ ok: true });
});

/**
 * THE endpoint merchants pay for.
 * The SDK forwards the incoming request's signature material + amount;
 * we answer: verdict + reason. One call, one billable verification.
 */
app.post('/verify', (req, res) => {
  const apiKey = req.header('X-Api-Key');
  const merchant = db.prepare(`SELECT * FROM merchants WHERE api_key = ?`).get(apiKey ?? '');
  if (!merchant) return res.status(401).json({ error: 'Invalid merchant API key.' });

  // Billing meter ticks no matter the verdict — work is work.
  db.prepare(`UPDATE merchants SET verifications = verifications + 1 WHERE api_key = ?`).run(apiKey);

  const { method, path, bodyString, headers, amountCents } = req.body;

  if (amountCents !== undefined && !Number.isInteger(amountCents)) {
    return res.json({ verdict: 'deny', reason: 'amountCents must be an integer (cents). Floats are not money.' });
  }

  const deny = (reason) => {
    console.log(`✘ [${merchant.name}] DENY: ${reason}`);
    return res.json({ verdict: 'deny', reason });
  };

  const parsed = parseSignatureInput(headers?.['signature-input']);
  if (!parsed) return deny('Missing or malformed Signature-Input header.');

  const agent = db.prepare(`SELECT * FROM agents WHERE agent_id = ?`).get(parsed.keyid);
  if (!agent) return deny(`Unknown agent "${parsed.keyid}" — not registered.`);

  const result = verifyRequest({
    method, path, bodyString, headers,
    publicKeyPem: agent.public_key,
    maxAgeSeconds: 30,
  });
  if (!result.ok) return deny(result.reason);

  // Replay protection (centralized: protects ALL merchants at once —
  // a signature replayed against shop B after shop A dies here too
  // if it's byte-identical)
  db.prepare(`DELETE FROM nonces WHERE expires_at < ?`).run(Date.now());
  if (db.prepare(`SELECT 1 FROM nonces WHERE nonce = ?`).get(parsed.nonce)) {
    return deny('Nonce already used — duplicate/replayed request.');
  }
  db.prepare(`INSERT INTO nonces VALUES (?, ?)`).run(parsed.nonce, Date.now() + 60_000);

  // Mandate enforcement — committed spends PLUS live holds, atomically.
  // The hold closes the race: two simultaneous requests serialize on
  // the transaction, and the second sees the first's hold.
  let holdId = null;
  if (typeof amountCents === 'number') {
    if (amountCents > agent.max_per_tx_cents) {
      return deny(`Amount ${euros(amountCents)} exceeds agent's per-transaction mandate (${euros(agent.max_per_tx_cents)}).`);
    }

    const HOLD_TTL_MS = 60_000; // uncommitted holds evaporate after 60s
    const placeHold = db.transaction(() => {
      db.prepare(`DELETE FROM holds WHERE expires_at < ?`).run(Date.now());

      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const spent = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) t FROM spends WHERE agent_id = ? AND created_at >= ?`)
        .get(agent.agent_id, startOfDay.getTime()).t;
      const held = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) t FROM holds WHERE agent_id = ?`)
        .get(agent.agent_id).t;

      if (spent + held + amountCents > agent.max_per_day_cents) {
        return { ok: false, spent, held };
      }
      const id = 'hold_' + crypto.randomBytes(8).toString('hex');
      db.prepare(`INSERT INTO holds (hold_id, agent_id, amount_cents, expires_at) VALUES (?, ?, ?, ?)`)
        .run(id, agent.agent_id, amountCents, Date.now() + HOLD_TTL_MS);
      return { ok: true, id };
    });

    const hold = placeHold();
    if (!hold.ok) {
      return deny(`Daily mandate exhausted (${euros(hold.spent)} committed + ${euros(hold.held)} held + ${euros(amountCents)} > ${euros(agent.max_per_day_cents)}).`);
    }
    holdId = hold.id;
  }

  console.log(`✔ [${merchant.name}] ALLOW agent "${agent.agent_id}"${amountCents ? ` — ${euros(amountCents)}` : ''}`);
  res.json({
    verdict: 'allow',
    agent: { id: agent.agent_id, owner: agent.owner_name },
    holdId,
  });
});

/**
 * CAPTURE: the merchant confirms the purchase completed (payment
 * settled, goods served). Only now does the spend count against
 * the agent's daily mandate.
 */
/** Purchase failed after authorization (payment declined, out of stock…): free the hold now instead of waiting for expiry. */
app.post('/release', (req, res) => {
  const apiKey = req.header('X-Api-Key');
  if (!db.prepare(`SELECT 1 FROM merchants WHERE api_key = ?`).get(apiKey ?? '')) {
    return res.status(401).json({ error: 'Invalid merchant API key.' });
  }
  const { holdId } = req.body;
  if (holdId) db.prepare(`DELETE FROM holds WHERE hold_id = ?`).run(holdId);
  res.json({ ok: true });
});

app.post('/commit', (req, res) => {
  const apiKey = req.header('X-Api-Key');
  const merchant = db.prepare(`SELECT * FROM merchants WHERE api_key = ?`).get(apiKey ?? '');
  if (!merchant) return res.status(401).json({ error: 'Invalid merchant API key.' });

  const { agentId, amountCents, holdId } = req.body;
  if (!agentId || !Number.isInteger(amountCents)) {
    return res.status(400).json({ error: 'agentId and integer amountCents required' });
  }
  const convert = db.transaction(() => {
    if (holdId) db.prepare(`DELETE FROM holds WHERE hold_id = ?`).run(holdId);
    db.prepare(`INSERT INTO spends (agent_id, amount_cents, created_at) VALUES (?, ?, ?)`)
      .run(agentId, amountCents, Date.now());
  });
  convert();
  console.log(`🧾 [${merchant.name}] COMMIT ${euros(amountCents)} against "${agentId}" (hold ${holdId ?? 'none'} converted)`);
  res.json({ ok: true });
});

/** The money view: what would we invoice each merchant? */
app.get('/billing', (_req, res) => {
  // €0.005/verification = 5 tenths-of-a-cent. Integer math in the
  // smallest unit we bill in (here: milli-euros), format at the end.
  const PRICE_MILLIEUROS = 5;
  const rows = db.prepare(`SELECT name, verifications FROM merchants`).all();
  res.json(rows.map(r => ({
    merchant: r.name,
    verifications: r.verifications,
    invoice: `${(r.verifications * PRICE_MILLIEUROS / 1000).toFixed(3)} €`,
  })));
});

app.listen(4000, () => console.log('VERIFIER SERVICE (the product) on http://localhost:4000\n'));
