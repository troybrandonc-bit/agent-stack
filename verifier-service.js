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
    -- The idempotency key for a capture. One logical purchase commits ONCE,
    -- however many times a nervous merchant retries the call. Without this,
    -- a commit retried after a timeout charges the agent's budget twice --
    -- and a retry is not a second purchase.
    ref TEXT UNIQUE,
    -- Set when this row was reconstructed from a network settlement rather
    -- than reported by a merchant. Useful to see how often merchants drop
    -- the ball, and proof the ledger self-heals.
    from_network INTEGER NOT NULL DEFAULT 0,
    agent_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS holds (
    hold_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    intent_id TEXT,                    -- the logical purchase this hold belongs to
    amount_cents INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  -- One live hold per logical purchase. The 402 dance sends the same
  -- purchase twice; without this the two attempts stack and the agent
  -- denies its own retry.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_holds_intent ON holds(agent_id, intent_id) WHERE intent_id IS NOT NULL;
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
  // The intent id identifies the PURCHASE, not the HTTP request. Both
  // attempts of the 402 dance carry the same one. It is also the handle
  // reconciliation uses later, which is why it's worth a column.
  const intentId = req.body.intentId ?? null;

  let holdId = null;
  if (typeof amountCents === 'number') {
    if (amountCents > agent.max_per_tx_cents) {
      return deny(`Amount ${euros(amountCents)} exceeds agent's per-transaction mandate (${euros(agent.max_per_tx_cents)}).`);
    }

    const HOLD_TTL_MS = 60_000; // uncommitted holds evaporate after 60s
    const placeHold = db.transaction(() => {
      db.prepare(`DELETE FROM holds WHERE expires_at < ?`).run(Date.now());

      // SUPERSEDE, don't stack. The unpaid attempt and the paid retry are
      // one logical purchase carrying one intent id, so the retry replaces
      // the first hold inside this transaction. Previously we released the
      // first hold with a separate network call on the 402 — which worked
      // until that call failed, and then the agent's budget stayed eaten
      // for the whole TTL. This can't half-fail: it's one transaction.
      const superseded = intentId
        ? db.prepare(`DELETE FROM holds WHERE agent_id = ? AND intent_id = ?`).run(agent.agent_id, intentId).changes
        : 0;

      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const spent = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) t FROM spends WHERE agent_id = ? AND created_at >= ?`)
        .get(agent.agent_id, startOfDay.getTime()).t;
      const held = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) t FROM holds WHERE agent_id = ?`)
        .get(agent.agent_id).t;

      if (spent + held + amountCents > agent.max_per_day_cents) {
        return { ok: false, spent, held };
      }
      const id = 'hold_' + crypto.randomBytes(8).toString('hex');
      db.prepare(`INSERT INTO holds (hold_id, agent_id, intent_id, amount_cents, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .run(id, agent.agent_id, intentId ?? null, amountCents, Date.now() + HOLD_TTL_MS);
      // An anonymous hold cannot be superseded by its own retry, so it is
      // worth noticing loudly rather than discovering during an incident.
      if (!intentId) console.warn(`  ⚠ hold ${id} has NO intent id — retry will stack a second hold`);
      return { ok: true, id, superseded };
    });

    const hold = placeHold();
    if (!hold.ok) {
      return deny(`Daily mandate exhausted (${euros(hold.spent)} committed + ${euros(hold.held)} held + ${euros(amountCents)} > ${euros(agent.max_per_day_cents)}).`);
    }
    holdId = hold.id;
    if (hold.superseded) {
      console.log(`  ↻ [${merchant.name}] hold superseded for intent ${intentId} (retry replaced the unpaid attempt)`);
    }
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

  const { agentId, amountCents, holdId, ref } = req.body;
  if (!agentId || !Number.isInteger(amountCents)) {
    return res.status(400).json({ error: 'agentId and integer amountCents required' });
  }

  // The capture's identity. Prefer the caller's ref (the intent id, which
  // survives retries); fall back to the hold id. A commit with neither is
  // un-deduplicable, so it's accepted but flagged -- better a warning than
  // a silent double-charge.
  const key = ref ?? holdId ?? null;
  if (!key) console.warn(`  ⚠ commit from ${merchant.name} has no ref or holdId — cannot be made idempotent`);

  let counted = true;
  db.transaction(() => {
    if (holdId) db.prepare(`DELETE FROM holds WHERE hold_id = ?`).run(holdId);
    const r = db.prepare(`INSERT OR IGNORE INTO spends (ref, agent_id, amount_cents, created_at) VALUES (?, ?, ?, ?)`)
      .run(key, agentId, amountCents, Date.now());
    counted = r.changes > 0;   // 0 = we've seen this capture before
  })();

  if (counted) {
    console.log(`🧾 [${merchant.name}] COMMIT ${euros(amountCents)} against "${agentId}" (hold ${holdId ?? 'none'} converted)`);
  } else {
    console.log(`↺ [${merchant.name}] COMMIT ${euros(amountCents)} against "${agentId}" already counted (ref ${key}) — retry, not a second purchase`);
  }
  res.json({ ok: true, counted });
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

/**
 * THE COORDINATOR IS NOT THE LEDGER OF TRUTH.
 *
 * Everything above treats the spends table as the record of what an agent
 * has spent. It isn't. It's a cache of merchants remembering to call
 * /commit -- a local record of a remote fact. A merchant that settles and
 * then dies before committing leaves money moved and nothing recorded, so
 * this service under-counts, and under-counting a budget means the agent
 * overspends at every OTHER merchant too. One shop's crash silently raises
 * the limit everywhere.
 *
 * So: rebuild exposure from what the network actually settled. Every
 * settlement is keyed by its tx id, so backfilling is idempotent -- a
 * settlement already reported by its merchant is skipped, and one that was
 * never reported gets written now. Reversed settlements are removed again,
 * because a refund that doesn't give back budget is just a slower theft.
 *
 * Exposure = (settled on the network) + (open holds). Both derived, neither
 * remembered. Delete this database and it rebuilds itself from the chain.
 *
 * The honest limit of this: it can only reconstruct what the network saw.
 * A merchant on another rail, or one who invoices monthly, settles nowhere
 * this service can read -- for those, the merchant's own /commit is still
 * the only record there is. Cross-rail agents are exactly where a
 * merchant-side coordinator stops being able to see everything.
 */
const FACILITATOR = process.env.FACILITATOR_URL || 'http://localhost:4001';

async function reconcileAgent(agentId) {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  let settlements;
  try {
    settlements = await fetch(`${FACILITATOR}/settlements-by-payer/${agentId}?since=${startOfDay.getTime()}`)
      .then(r => r.json());
  } catch {
    return; // network unreachable: keep serving from cache, try again next tick
  }
  if (!Array.isArray(settlements)) return;

  for (const s of settlements) {
    // Key on the intent ref when the merchant carried one, so this matches
    // the same key /commit used and we don't double-count the same purchase
    // under two different names.
    const key = s.intent_ref ?? s.tx_id;

    if (s.reversed_at) {
      const undone = db.transaction(() => {
        const gone = db.prepare(`DELETE FROM spends WHERE ref = ?`).run(key).changes;
        const freed = db.prepare(`DELETE FROM holds WHERE agent_id = ? AND intent_id = ?`).run(agentId, key).changes;
        return gone + freed;
      })();
      if (undone) console.log(`  ⟲ RECONCILE: ${key} was reversed on the network — budget given back`);
      continue;
    }

    // Backfill the spend and retire its hold in ONE transaction. They are
    // the same purchase: the hold was the promise, the settlement is the
    // fact. Counting the spend while the hold is still open charges the
    // agent's budget twice for one thing -- 89.90 held plus 89.90 spent
    // reads as 179.80 of exposure until the hold expires.
    //
    // That error is at least the SAFE direction (it blocks rather than
    // overspends) and it self-corrects on the TTL, but "wrong for 60
    // seconds" is still wrong, and the intent id is exactly the handle
    // needed to say "these two rows are one purchase".
    const settled = db.transaction(() => {
      const ins = db.prepare(`INSERT OR IGNORE INTO spends (ref, from_network, agent_id, amount_cents, created_at)
                              VALUES (?, 1, ?, ?, ?)`).run(key, agentId, s.amount_cents, s.created_at);
      // Retire the hold whether or not the spend was new: a committed spend
      // with a lingering hold is the same double-count by another route.
      const freed = db.prepare(`DELETE FROM holds WHERE agent_id = ? AND intent_id = ?`).run(agentId, key).changes;
      return { counted: ins.changes > 0, freed };
    })();

    if (settled.counted) {
      console.log(`  ⟳ RECONCILE: ${key} settled ${euros(s.amount_cents)} on the network but no merchant ever committed it — counted now`);
    }
    if (settled.freed) {
      console.log(`  ⟳ RECONCILE: hold for ${key} retired — its settlement is on the network, the promise is now a fact`);
    }
  }
}

async function reconcileAll() {
  for (const a of db.prepare(`SELECT agent_id FROM agents`).all()) {
    await reconcileAgent(a.agent_id);
  }
}
setInterval(() => { reconcileAll().catch(() => {}); }, 10_000);

/**
 * DEV ONLY — wipe the ledger without restarting.
 *
 * Persistence is the product: budgets that survive a restart are the whole
 * reason this service exists. But a demo you can only run once a day is a
 * demo nobody runs. So: an explicit, guarded, loudly-named door.
 *
 * Guarded by ALLOW_DEV_RESET so it cannot be reached by accident in
 * anything resembling production. A reset endpoint that exists quietly is
 * a data-loss bug waiting for a stray curl.
 */
if (process.env.ALLOW_DEV_RESET === '1') {
  app.post('/dev/reset', (_req, res) => {
    db.exec(`DELETE FROM spends; DELETE FROM holds; DELETE FROM nonces;`);
    db.prepare(`UPDATE merchants SET verifications = 0`).run();
    console.log('🧹 DEV RESET — spends, holds, nonces and billing cleared (agents kept)');
    res.json({ ok: true });
  });
  console.log('⚠  ALLOW_DEV_RESET=1 — POST /dev/reset will wipe the ledger. Never set this in production.');
}

app.listen(4000, () => console.log('VERIFIER SERVICE (the product) on http://localhost:4000\n'));
