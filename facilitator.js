/**
 * FACILITATOR — port 5000. The settlement layer.
 *
 * In real x402 (Coinbase's protocol, now at the Linux Foundation),
 * the facilitator verifies a signed stablecoin payment and settles it
 * on-chain (USDC on Base). Same API shape here — /verify and /settle —
 * but our "chain" is a SQLite ledger and our signatures are Ed25519.
 * The HTTP choreography is the real thing; the money is training wheels.
 *
 * Run: node facilitator.js
 */

const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const db = new Database('facilitator.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    address TEXT PRIMARY KEY,          -- the payer/payee id (agent or merchant)
    public_key TEXT,                   -- payers sign; payees may just receive
    balance_cents INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settlements (
    id TEXT PRIMARY KEY,               -- the payment nonce: one settlement per payment
    tx_id TEXT NOT NULL,
    intent_ref TEXT,                   -- the payer's correlation ref, carried through
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    reversed_at INTEGER                -- set when refunded; NULL = money still with the merchant
  );
`);

const app = express();
app.use(express.json());
const euros = (c) => (c / 100).toFixed(2) + '€';

/** Testnet faucet: free demo money. (On real x402: a testnet USDC faucet.) */
app.post('/faucet', (req, res) => {
  const { address, publicKeyPem, amountCents } = req.body;
  if (!address || !Number.isInteger(amountCents)) {
    return res.status(400).json({ error: 'address and integer amountCents required' });
  }
  db.prepare(`INSERT INTO accounts (address, public_key, balance_cents) VALUES (?, ?, ?)
              ON CONFLICT(address) DO UPDATE SET
                balance_cents = balance_cents + excluded.balance_cents,
                public_key = COALESCE(excluded.public_key, public_key)`)
    .run(address, publicKeyPem ?? null, amountCents);
  console.log(`💧 faucet: +${euros(amountCents)} to ${address}`);
  res.json({ ok: true });
});

/** What the payer signs: the payment authorization, canonically encoded. */
function authString(a) {
  return ['x402-mock-v1', a.from, a.to, a.amountCents, a.nonce, a.validBefore, a.intentRef ?? ''].join('|');
}

function checkPayment(paymentPayload, paymentRequirements) {
  const auth = paymentPayload?.authorization;
  const sig = paymentPayload?.signature;
  if (!auth || !sig) return { isValid: false, invalidReason: 'Malformed payment payload.' };

  if (auth.to !== paymentRequirements.payTo) {
    return { isValid: false, invalidReason: 'Payment addressed to the wrong payee.' };
  }
  if (!Number.isInteger(auth.amountCents) || auth.amountCents < paymentRequirements.maxAmountRequiredCents) {
    return { isValid: false, invalidReason: `Insufficient amount: ${auth.amountCents} < ${paymentRequirements.maxAmountRequiredCents}.` };
  }
  if (Date.now() > auth.validBefore) {
    return { isValid: false, invalidReason: 'Payment authorization expired.' };
  }

  const payer = db.prepare(`SELECT * FROM accounts WHERE address = ?`).get(auth.from);
  if (!payer?.public_key) return { isValid: false, invalidReason: `Unknown payer "${auth.from}".` };

  const valid = crypto.verify(null, Buffer.from(authString(auth)), payer.public_key, Buffer.from(sig, 'base64'));
  if (!valid) return { isValid: false, invalidReason: 'Payment signature invalid.' };

  const existing = db.prepare(`SELECT * FROM settlements WHERE id = ?`).get(auth.nonce);
  if (existing) {
    // The signature covers the nonce, so an identical nonce with a valid
    // signature IS the same request arriving twice — a retry, not a fraud.
    // Idempotency: replay the original outcome instead of charging again.
    return { isValid: true, auth, alreadySettled: existing };
  }
  if (payer.balance_cents < auth.amountCents) {
    return { isValid: false, invalidReason: `Insufficient funds: balance ${euros(payer.balance_cents)}.` };
  }
  return { isValid: true, auth };
}

/** x402 facilitator API shape: verify without moving money. */
app.post('/verify', (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body;
  const result = checkPayment(paymentPayload, paymentRequirements);
  res.json({ isValid: result.isValid, invalidReason: result.invalidReason });
});

/** x402 facilitator API shape: settle — atomically move the money. */
app.post('/settle', (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body;
  const result = checkPayment(paymentPayload, paymentRequirements);
  if (!result.isValid) {
    console.log(`✘ settle refused: ${result.invalidReason}`);
    return res.json({ success: false, errorReason: result.invalidReason });
  }

  // IDEMPOTENCY: same payment, second call → same answer, no second charge.
  if (result.alreadySettled) {
    const s = result.alreadySettled;
    if (s.reversed_at) {
      return res.json({ success: false, errorReason: 'This payment was refunded; a new payment is required.' });
    }
    console.log(`♻️  idempotent replay of ${s.tx_id} (${euros(s.amount_cents)}) — not charged twice`);
    return res.json({ success: true, transaction: s.tx_id, replayed: true });
  }

  const { auth } = result;
  const txId = 'tx_' + crypto.createHash('sha256').update(auth.nonce).digest('hex').slice(0, 12);
  const settle = db.transaction(() => {
    db.prepare(`UPDATE accounts SET balance_cents = balance_cents - ? WHERE address = ?`)
      .run(auth.amountCents, auth.from);
    db.prepare(`INSERT INTO accounts (address, balance_cents) VALUES (?, ?)
                ON CONFLICT(address) DO UPDATE SET balance_cents = balance_cents + excluded.balance_cents`)
      .run(auth.to, auth.amountCents);
    db.prepare(`INSERT INTO settlements (id, tx_id, intent_ref, from_address, to_address, amount_cents, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(auth.nonce, txId, auth.intentRef ?? null, auth.from, auth.to, auth.amountCents, Date.now());
  });
  settle();
  console.log(`💸 SETTLED ${euros(auth.amountCents)}  ${auth.from} → ${auth.to}  (${txId})`);
  res.json({ success: true, transaction: txId });
});

/** REVERSAL: money goes back. Idempotent — refunding twice is a no-op. */
app.post('/refund', (req, res) => {
  const { transaction, reason } = req.body;
  const s = db.prepare(`SELECT * FROM settlements WHERE tx_id = ?`).get(transaction ?? '');
  if (!s) return res.status(404).json({ error: 'Unknown transaction.' });
  if (s.reversed_at) return res.json({ ok: true, alreadyRefunded: true });

  const reverse = db.transaction(() => {
    db.prepare(`UPDATE accounts SET balance_cents = balance_cents - ? WHERE address = ?`)
      .run(s.amount_cents, s.to_address);
    db.prepare(`UPDATE accounts SET balance_cents = balance_cents + ? WHERE address = ?`)
      .run(s.amount_cents, s.from_address);
    db.prepare(`UPDATE settlements SET reversed_at = ? WHERE tx_id = ?`).run(Date.now(), s.tx_id);
  });
  reverse();

  console.log(`↩️  REFUNDED ${euros(s.amount_cents)}  ${s.to_address} → ${s.from_address}  (${s.tx_id}: ${reason ?? 'no reason given'})`);
  res.json({ ok: true, refunded: s.tx_id, amountCents: s.amount_cents });
});

/**
 * "Did this purchase settle?" — answered by the payer's own ref.
 *
 * This is what makes crash recovery possible without enumerating the
 * world. A shop that wrote an intent and then died can ask by that ref
 * instead of guessing. Enumerating settlements by payee works here
 * because this ledger is a SQLite table; on a real chain it's slow,
 * paginated and costs money, so recovery has to be a point lookup.
 */
app.get('/settlement-by-ref/:ref', (req, res) => {
  const s = db.prepare(`SELECT tx_id, from_address, to_address, amount_cents, created_at, reversed_at
                        FROM settlements WHERE intent_ref = ?`).get(req.params.ref);
  res.json(s ?? null);      // null = it genuinely never happened
});

/** Reconciliation feed: what did we settle for this payee? */
app.get('/settlements/:payee', (req, res) => {
  res.json(db.prepare(`SELECT tx_id, from_address, amount_cents, created_at, reversed_at
                       FROM settlements WHERE to_address = ? ORDER BY created_at DESC`)
    .all(req.params.payee));
});

/**
 * What did this PAYER actually spend on the network, ever?
 *
 * This is the question that makes the verifier's counters non-authoritative.
 * The verifier's spends table is a cache of merchants remembering to call
 * /commit. This endpoint is what really happened. When they disagree, this
 * wins — a merchant that settled and then crashed before committing leaves
 * no local row, and only the network remembers.
 *
 * Reversed settlements are returned too, with their reversed_at, because a
 * refund must subtract from exposure rather than being silently absent.
 */
app.get('/settlements-by-payer/:payer', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json(db.prepare(`SELECT tx_id, intent_ref, to_address, amount_cents, created_at, reversed_at
                       FROM settlements WHERE from_address = ? AND created_at >= ?
                       ORDER BY created_at DESC`).all(req.params.payer, since));
});

app.get('/balances', (_req, res) => {
  res.json(db.prepare(`SELECT address, balance_cents FROM accounts`).all()
    .map(a => ({ address: a.address, balance: euros(a.balance_cents) })));
});

// DEV ONLY — see the note in verifier-service.js. Same guard, same reason.
if (process.env.ALLOW_DEV_RESET === '1') {
  app.post('/dev/reset', (_req, res) => {
    db.exec(`DELETE FROM settlements; DELETE FROM accounts;`);
    console.log('🧹 DEV RESET — settlements and balances cleared');
    res.json({ ok: true });
  });
}

app.listen(4001, () => console.log('FACILITATOR (settlement layer) on http://localhost:4001\n'));
