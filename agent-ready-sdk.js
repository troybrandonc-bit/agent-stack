/**
 * agent-ready SDK (the OPEN half of the hybrid model).
 *
 * This is what you'd publish on npm for free. A merchant adds agent
 * verification to any Express route in three lines:
 *
 *   const agentReady = require('agent-ready-sdk');
 *   const verify = agentReady({ apiKey: 'mk_...', verifierUrl: '...' });
 *   app.post('/checkout', verify, handler);
 *
 * It contains NO security logic — it forwards the request's signature
 * material to YOUR hosted verifier and obeys the verdict. The merchant
 * can read every line (trust), but the value lives server-side (moat).
 */

function agentReady({ apiKey, verifierUrl = 'http://localhost:4000' }) {
  if (!apiKey) throw new Error('agent-ready: apiKey is required');

  return async function verifyAgentMiddleware(req, res, next) {
    try {
      const response = await fetch(verifierUrl + '/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({
          method: req.method,
          path: req.path,
          bodyString: req.rawBody ?? '',
          headers: {
            'signature-input': req.header('Signature-Input'),
            'signature': req.header('Signature'),
            'content-digest': req.header('Content-Digest'),
          },
          amountCents: Number.isInteger(req.body?.amountCents) ? req.body.amountCents : undefined,
        }),
      });

      const result = await response.json();

      if (result.verdict !== 'allow') {
        return res.status(401).json({ error: result.reason ?? 'Agent verification failed.' });
      }

      req.agent = result.agent; // { id, owner } — verified identity
      req.agentHoldId = result.holdId ?? null;
      next();
    } catch (err) {
      // Fail CLOSED for payments: if the verifier is unreachable,
      // reject rather than accept unverified traffic.
      return res.status(503).json({ error: 'Agent verification unavailable — request rejected (fail-closed).' });
    }
  };
}

/** Capture: report a completed purchase so it counts against the mandate. */
agentReady.commit = function ({ apiKey, verifierUrl = 'http://localhost:4000' }) {
  return async function commitSpend(agentId, amountCents, holdId) {
    try {
      await fetch(verifierUrl + '/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({ agentId, amountCents, holdId }),
      });
    } catch {
      // If this fails, verify and commit have diverged — real systems
      // reconcile with a retry queue. Logged and moved on, for now.
      console.error('commit failed — spend not recorded (reconciliation needed)');
    }
  };
};

/** Release a hold when the purchase fails after authorization. */
agentReady.release = function ({ apiKey, verifierUrl = 'http://localhost:4000' }) {
  return async function releaseHold(holdId) {
    if (!holdId) return;
    try {
      await fetch(verifierUrl + '/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({ holdId }),
      });
    } catch { /* hold expires on its own in 60s — degraded but safe */ }
  };
};

module.exports = agentReady;
