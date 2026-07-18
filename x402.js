/**
 * x402 helpers — both sides of the payment handshake.
 *
 * THE FLOW (this is the actual x402 choreography):
 *   1. Client calls a paid endpoint with no payment
 *   2. Server answers HTTP 402 + paymentRequirements JSON (the terms)
 *   3. Client builds a signed payment authorization, base64s it into
 *      an X-PAYMENT header, and RETRIES the same request
 *   4. Server hands the payment to the facilitator to settle,
 *      and only serves the goods if settlement succeeds
 */

const crypto = require('crypto');

const FACILITATOR = 'http://localhost:4001';

/** SERVER SIDE: Express middleware that puts a price on a route. */
function paymentRequired({ payTo, amountCents, description, onFailure, beforeSettle }) {
  return async function x402Middleware(req, res, next) {
    // Any exit from this middleware that isn't next() means the purchase
    // did NOT happen — so whatever the identity layer held must be freed
    // IMMEDIATELY. This matters most on the normal path: the 402 reply
    // below is answered by a RETRY carrying payment, and that retry places
    // its own hold. Without this release, every purchase would hold twice.
    const fail = async (fn) => { await onFailure?.(req); return fn(); };

    const cents = typeof amountCents === 'function' ? amountCents(req) : amountCents;
    if (!Number.isInteger(cents) || cents <= 0) {
      return fail(() => res.status(400).json({ error: 'No price for this request.' }));
    }
    const requirements = {
      scheme: 'mock-exact',                    // real x402: 'exact' (EIP-3009 USDC)
      network: 'local-ledger',                 // real x402: 'base-sepolia' / 'base'
      payTo,
      maxAmountRequiredCents: cents,
      resource: req.originalUrl,
      description,
    };

    const paymentHeader = req.header('X-PAYMENT');
    if (!paymentHeader) {
      // Step 2: the famous status code, dormant in HTTP since 1997,
      // finally doing its job. The agent will retry WITH payment.
      return fail(() => res.status(402).json({ x402Version: 1, accepts: [requirements] }));
    }

    let paymentPayload;
    try {
      paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
    } catch {
      return fail(() => res.status(400).json({ error: 'Malformed X-PAYMENT header.' }));
    }

    // The ref the payer signed must be the ref we're about to file this
    // purchase under. If they disagree, our books point at a settlement
    // that will never carry our ref, and recovery would find nothing.
    // The agent mints the ref because the agent signs it; we only insist
    // that it told us the same story twice.
    const intentRef = req.body?.intentId ?? null;
    if (paymentPayload?.authorization?.intentRef !== intentRef) {
      return fail(() => res.status(400).json({
        error: 'intentId in the request does not match intentRef in the payment.',
      }));
    }
    req.intentRef = intentRef;

    // WRITE THE INTENT BEFORE THE SIDE EFFECT. Everything after this line
    // is recoverable; everything before it never happened.
    if (intentRef) await beforeSettle?.(req, intentRef);

    // Step 4: settle via the facilitator before serving anything.
    const settle = await fetch(FACILITATOR + '/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentPayload, paymentRequirements: requirements }),
    }).then(r => r.json()).catch(() => ({ success: false, errorReason: 'Facilitator unreachable.' }));

    if (!settle.success) {
      // Payment declined AFTER we held mandate room — free it now rather
      // than locking the agent's budget for the hold's whole TTL.
      return fail(() => res.status(402).json({ error: 'Payment failed: ' + settle.errorReason, accepts: [requirements] }));
    }

    res.setHeader('X-PAYMENT-RESPONSE',
      Buffer.from(JSON.stringify({ success: true, transaction: settle.transaction })).toString('base64'));
    req.payment = { transaction: settle.transaction, amountCents };
    next();
  };
}

/** CLIENT SIDE: build the signed X-PAYMENT header for given requirements. */
function buildPayment({ requirements, from, privateKey, intentRef }) {
  const authorization = {
    from,
    to: requirements.payTo,
    amountCents: requirements.maxAmountRequiredCents,
    nonce: crypto.randomBytes(16).toString('hex'),   // one settlement per nonce
    validBefore: Date.now() + 60_000,
    intentRef,                                       // the payer's correlation ref
  };
  const authString = ['x402-mock-v1', authorization.from, authorization.to,
    authorization.amountCents, authorization.nonce, authorization.validBefore,
    authorization.intentRef ?? ''].join('|');
  const signature = crypto.sign(null, Buffer.from(authString), privateKey).toString('base64');

  return Buffer.from(JSON.stringify({ x402Version: 1, scheme: requirements.scheme, authorization, signature }))
    .toString('base64');
}

/** CLIENT SIDE: fetch that automatically handles the 402 → pay → retry dance. */
async function payingFetch(url, options, { from, privateKey }) {
  const first = await fetch(url, options);
  if (first.status !== 402) return first;

  const terms = await first.json();
  const requirements = terms.accepts?.[0];
  if (!requirements) throw new Error('402 without payment requirements');

  console.log(`  💳 402 received — paying ${(requirements.maxAmountRequiredCents / 100).toFixed(2)}€ to ${requirements.payTo} and retrying`);

  const xPayment = buildPayment({ requirements, from, privateKey });
  return fetch(url, { ...options, headers: { ...options.headers, 'X-PAYMENT': xPayment } });
}

module.exports = { paymentRequired, buildPayment, payingFetch };
