import { createHash, createVerify, createPublicKey } from "crypto";
import axios from "axios";
import { httpbis } from "http-message-signatures";
import config from "../config/index.js";

/**
 * RFC-9421 HTTP Message Signature verification for PawaPay callbacks.
 *
 * PawaPay signs every deposit/payout callback with an ECDSA P-256 signature
 * (algorithm "ecdsa-p256-sha256"). Each request carries:
 *   Signature, Signature-Input, Signature-Date, Content-Digest, Content-Type
 * and the signature base covers:
 *   @method, @authority, @path, signature-date, content-digest, content-type.
 *
 * Verification keys are published at GET {PAWAPAY_BASE_URL}/public-key/http
 * (Bearer auth) as a JSON array of { id, key } where key is a PEM public key.
 *
 * The canonicalisation (signature base construction) is done by the
 * http-message-signatures library — never hand-rolled here.
 *
 * The verification logic below (verifySignedCallback) is kept pure and
 * network-free so it can be unit-tested in isolation (see
 * scripts/test-pawapay-signature.mjs); the Express glue lives at the bottom.
 */

/**
 * Verify a signed callback. Pure: no network, no Express.
 *
 * @param {{ method: string, url: string, headers: object, body: Buffer }} message
 *        header keys must be lowercase; body is the raw request bytes.
 * @param {(params: { keyid: string }) => Promise<object|null>} keyLookup
 *        resolves the signing key id to an RFC-9421 verifier, or null.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function verifySignedCallback(message, keyLookup) {
  // 1. Content-Digest: the signature only binds the digest header, so we must
  //    independently confirm the digest actually matches the received body.
  let digest;
  try {
    // extractHeader returns an array of the matched member values.
    digest = httpbis.extractHeader(
      "content-digest",
      new Map([["key", "sha-512"]]),
      message
    );
  } catch {
    return { ok: false, reason: "missing-digest" };
  }
  const member = Array.isArray(digest) ? digest[0] : digest;
  if (!member) return { ok: false, reason: "missing-digest" };

  // Member value looks like `:<base64>:` (sfv byte-sequence) — strip the
  // surrounding colons to get the raw base64 digest.
  const received = String(member).replace(/^:/, "").replace(/:$/, "");
  const expected = createHash("sha512").update(message.body).digest("base64");
  if (received !== expected) return { ok: false, reason: "digest-mismatch" };

  // 2. Signature: the library throws on malformed input / unknown key and
  //    returns falsy on a bad signature — either way it's a failure.
  try {
    const valid = await httpbis.verifyMessage({ keyLookup }, message);
    if (!valid) return { ok: false, reason: "signature-invalid" };
  } catch {
    return { ok: false, reason: "signature-invalid" };
  }

  return { ok: true };
}

// Module-level cache of PawaPay's public keys with a 12-hour TTL. Key rotation
// is handled by forcing one refetch when a keyid misses the cache.
const KEY_TTL_MS = 12 * 60 * 60 * 1000;
const keyCache = new Map(); // id -> { pem, publicKey }
let keyCacheFetchedAt = 0;

async function fetchPublicKeys() {
  const { data } = await axios.get(
    `${config.pawapay.baseUrl}/public-key/http`,
    {
      headers: { Authorization: `Bearer ${config.pawapay.apiToken}` },
      timeout: 20000,
    }
  );
  keyCache.clear();
  for (const entry of Array.isArray(data) ? data : []) {
    // Strict String(...) comparison on both sides — PawaPay's own example repo
    // buggily uses `=` (assignment) here; we deliberately do not copy that.
    keyCache.set(String(entry.id), {
      pem: entry.key,
      publicKey: createPublicKey(entry.key),
    });
  }
  keyCacheFetchedAt = Date.now();
}

function buildVerifier(id, publicKey) {
  return {
    id,
    algs: ["ecdsa-p256-sha256"],
    async verify(data, signature) {
      return createVerify("SHA256").update(data).verify(publicKey, signature);
    },
  };
}

/**
 * Build an RFC-9421 keyLookup backed by PawaPay's published public keys,
 * cached for 12 hours with a rotation-aware refetch on cache miss.
 */
export function createPawaPayKeyLookup() {
  return async function keyLookup(params) {
    const wanted = String(params.keyid);

    const stale = Date.now() - keyCacheFetchedAt > KEY_TTL_MS;
    if (keyCache.size === 0 || stale) await fetchPublicKeys();

    let entry = keyCache.get(wanted);
    if (!entry) {
      // Miss could mean a rotated key we haven't fetched yet — force one refetch.
      await fetchPublicKeys();
      entry = keyCache.get(wanted);
    }
    if (!entry) return null;

    return buildVerifier(wanted, entry.publicKey);
  };
}

// One shared keyLookup for the middleware so the cache is process-wide.
const cachedKeyLookup = createPawaPayKeyLookup();

const REQUIRED_HEADERS = [
  "signature",
  "signature-input",
  "signature-date",
  "content-digest",
];

/**
 * Express middleware guarding PawaPay callback routes.
 *
 * Gated by PAWAPAY_VERIFY_CALLBACKS: when off (dev / simulated payments, or
 * Postman testing) it's a no-op so callbacks flow through unverified.
 */
export function verifyPawaPayCallbackMiddleware() {
  return async function (req, res, next) {
    if (!config.pawapay.verifyCallbacks) return next();

    if (!req.rawBody || REQUIRED_HEADERS.some((h) => !req.headers[h])) {
      return res.status(401).json({ error: "Signature required" });
    }

    try {
      // @authority = Host header (ngrok forwards it correctly);
      // @path = originalUrl. The scheme is not part of the signature base.
      const message = {
        method: req.method,
        url: `https://${req.headers.host}${req.originalUrl}`,
        headers: req.headers,
        body: req.rawBody,
      };
      const result = await verifySignedCallback(message, cachedKeyLookup);
      if (!result.ok) {
        console.warn(
          `[WEBHOOK] rejected callback ${req.originalUrl}: ${result.reason}`
        );
        return res.status(401).json({ error: "Invalid signature" });
      }
      return next();
    } catch (err) {
      // Never let verification crash the request — treat any throw as a 401.
      console.warn(
        `[WEBHOOK] verification error on ${req.originalUrl}: ${err.message}`
      );
      return res.status(401).json({ error: "Invalid signature" });
    }
  };
}

export default {
  verifySignedCallback,
  createPawaPayKeyLookup,
  verifyPawaPayCallbackMiddleware,
};
