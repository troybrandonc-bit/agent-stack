/**
 * RFC 9421 — HTTP Message Signatures (minimal, correct subset).
 * Plus RFC 9530 Content-Digest for request bodies.
 *
 * This replaces our homemade X-Signature headers with the real
 * standard the payment industry builds on (Visa TAP, etc.).
 *
 * How the standard works, in short:
 *
 * 1. The signer picks "covered components" — the parts of the request
 *    being signed. Ours: @method, @path, content-digest.
 * 2. It builds a canonical "signature base": one line per component,
 *    `"name": value`, ending with a `"@signature-params"` line that
 *    encodes the component list + metadata (created, keyid, nonce, alg).
 * 3. It signs the base and sends TWO headers:
 *      Signature-Input: sig1=("@method" "@path" "content-digest");created=...;keyid="...";nonce="...";alg="ed25519"
 *      Signature:       sig1=:base64signature:
 * 4. The verifier reconstructs the exact same base from the received
 *    request + the Signature-Input header, and verifies.
 *
 * Anything tampered → different base → signature dies. Same idea as
 * our v2, but expressed in the interoperable grammar every serious
 * implementation speaks.
 */

const crypto = require('crypto');

const COVERED = ['@method', '@path', 'content-digest'];

/** RFC 9530 Content-Digest header value for a body string. */
function contentDigest(bodyString) {
  const hash = crypto.createHash('sha256').update(bodyString).digest('base64');
  return `sha-256=:${hash}:`;
}

/** The `sig1=(...)` inner value of Signature-Input, minus the label. */
function signatureParams({ created, keyid, nonce }) {
  const components = COVERED.map(c => `"${c}"`).join(' ');
  return `(${components});created=${created};keyid="${keyid}";nonce="${nonce}";alg="ed25519"`;
}

/** Canonical signature base per RFC 9421 §2.5. */
function signatureBase({ method, path, digest, params }) {
  return [
    `"@method": ${method.toUpperCase()}`,
    `"@path": ${path}`,
    `"content-digest": ${digest}`,
    `"@signature-params": ${params}`,
  ].join('\n');
}

/**
 * SIGN a request. Returns the headers to attach.
 * @param {crypto.KeyObject} privateKey Ed25519
 */
function signRequest({ method, path, bodyString, keyid, privateKey, nonce, created }) {
  created = created ?? Math.floor(Date.now() / 1000);
  nonce = nonce ?? crypto.randomBytes(16).toString('hex');

  const digest = contentDigest(bodyString);
  const params = signatureParams({ created, keyid, nonce });
  const base = signatureBase({ method, path, digest, params });

  const signature = crypto.sign(null, Buffer.from(base), privateKey).toString('base64');

  return {
    'Content-Digest': digest,
    'Signature-Input': `sig1=${params}`,
    'Signature': `sig1=:${signature}:`,
  };
}

/** Parse `Signature-Input: sig1=(...)...` into its parts. */
function parseSignatureInput(header) {
  const m = /^sig1=\((?<components>[^)]*)\);created=(?<created>\d+);keyid="(?<keyid>[^"]+)";nonce="(?<nonce>[^"]+)";alg="(?<alg>[^"]+)"$/
    .exec(header ?? '');
  if (!m) return null;

  return {
    components: m.groups.components.split(' ').map(s => s.replaceAll('"', '')),
    created: Number(m.groups.created),
    keyid: m.groups.keyid,
    nonce: m.groups.nonce,
    alg: m.groups.alg,
  };
}

/** Parse `Signature: sig1=:base64:` */
function parseSignature(header) {
  const m = /^sig1=:(?<b64>[A-Za-z0-9+/=]+):$/.exec(header ?? '');
  return m ? Buffer.from(m.groups.b64, 'base64') : null;
}

/**
 * VERIFY a request. Pure function: no registry/nonce policy here —
 * the caller supplies the public key and applies its own policy.
 * Returns { ok, reason?, parsed? }.
 */
function verifyRequest({ method, path, bodyString, headers, publicKeyPem, maxAgeSeconds = 30 }) {
  const parsed = parseSignatureInput(headers['signature-input']);
  if (!parsed) return { ok: false, reason: 'Missing or malformed Signature-Input header.' };

  if (parsed.alg !== 'ed25519') {
    return { ok: false, reason: `Unsupported algorithm "${parsed.alg}".` };
  }

  // The verifier requires its mandatory components to be covered —
  // otherwise a signer could "validly sign" almost nothing.
  for (const required of COVERED) {
    if (!parsed.components.includes(required)) {
      return { ok: false, reason: `Required component "${required}" not covered by signature.` };
    }
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - parsed.created);
  if (age > maxAgeSeconds) {
    return { ok: false, reason: `Signature created ${age}s ago — outside the ${maxAgeSeconds}s window (replay?).`, parsed };
  }

  // Verify the body actually matches the signed digest
  const expectedDigest = contentDigest(bodyString);
  if (headers['content-digest'] !== expectedDigest) {
    return { ok: false, reason: 'Content-Digest does not match the body — body tampered.', parsed };
  }

  const signature = parseSignature(headers['signature']);
  if (!signature) return { ok: false, reason: 'Missing or malformed Signature header.', parsed };

  if (!publicKeyPem) return { ok: false, reason: 'No public key supplied for verification.', parsed };

  const params = signatureParams(parsed);
  const base = signatureBase({ method, path, digest: headers['content-digest'], params });

  const valid = crypto.verify(null, Buffer.from(base), publicKeyPem, signature);
  if (!valid) return { ok: false, reason: 'Signature verification failed — request tampered or key mismatch.', parsed };

  return { ok: true, parsed };
}

module.exports = { signRequest, verifyRequest, contentDigest, parseSignatureInput };
