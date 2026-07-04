/**
 * In-process test for RFC-9421 PawaPay callback verification.
 *
 * No server, no network: generates an ephemeral EC P-256 keypair, signs a fake
 * deposit callback exactly the way PawaPay does (per their signatures-node
 * example), then runs verifySignedCallback against four scenarios.
 *
 *   npm run test:webhook-sig
 *
 * Exits 1 if any case fails.
 */
import {
  createHash,
  createSign,
  createVerify,
  generateKeyPairSync,
} from "crypto";
import { httpbis } from "http-message-signatures";
import { verifySignedCallback } from "../src/middleware/pawapaySignature.js";

const KEY_ID = "HTTP_EC_P256_KEY:1";
const DEPOSIT_URL = "https://example.ngrok.io/api/webhooks/pawapay/deposit";
const PAYOUT_URL = "https://example.ngrok.io/api/webhooks/pawapay/payout";

const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

// keyLookup closed over the generated public key; unknown ids resolve to null.
const keyLookup = async (params) => {
  if (String(params.keyid) !== KEY_ID) return null;
  return {
    id: KEY_ID,
    algs: ["ecdsa-p256-sha256"],
    async verify(data, signature) {
      return createVerify("SHA256").update(data).verify(publicKey, signature);
    },
  };
};

/**
 * Sign a callback the PawaPay way and return { headers, body } ready to feed
 * into verifySignedCallback (lowercased header keys, raw body Buffer).
 */
async function signCallback(url, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const contentDigest =
    "sha-512=:" + createHash("sha512").update(body).digest("base64") + ":";

  const headers = {
    "content-type": "application/json",
    "content-digest": contentDigest,
    "signature-date": new Date().toISOString(),
  };

  const signer = {
    id: KEY_ID,
    alg: "ecdsa-p256-sha256",
    sign: (data) => createSign("SHA256").update(data).sign(privateKey),
  };

  const signed = await httpbis.signMessage(
    {
      key: signer,
      name: "sig-pp",
      fields: [
        "@method",
        "@authority",
        "@path",
        "signature-date",
        "content-digest",
        "content-type",
      ],
    },
    { method: "POST", url, headers }
  );

  // signMessage capitalises Signature / Signature-Input; Express delivers all
  // header keys lowercase, so mirror that for the pure function's contract.
  const lower = {};
  for (const [k, v] of Object.entries(signed.headers)) lower[k.toLowerCase()] = v;

  return { headers: lower, body };
}

let failures = 0;
function check(name, pass, detail) {
  const status = pass ? "PASS" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

async function main() {
  console.log("PawaPay signature verification tests\n");

  const deposit = await signCallback(DEPOSIT_URL, {
    depositId: "dep-123",
    status: "COMPLETED",
  });

  // (a) valid callback → ok
  {
    const message = { method: "POST", url: DEPOSIT_URL, ...deposit };
    const res = await verifySignedCallback(message, keyLookup);
    check("valid callback → ok", res.ok === true, `reason=${res.reason}`);
  }

  // (b) tampered body → digest-mismatch
  {
    const tampered = Buffer.from(
      JSON.stringify({ depositId: "dep-123", status: "FAILED" })
    );
    const message = {
      method: "POST",
      url: DEPOSIT_URL,
      headers: deposit.headers,
      body: tampered,
    };
    const res = await verifySignedCallback(message, keyLookup);
    check(
      "tampered body → digest-mismatch",
      res.ok === false && res.reason === "digest-mismatch",
      `reason=${res.reason}`
    );
  }

  // (c) same signature verified against the payout path → signature-invalid
  {
    const message = {
      method: "POST",
      url: PAYOUT_URL,
      headers: deposit.headers,
      body: deposit.body,
    };
    const res = await verifySignedCallback(message, keyLookup);
    check(
      "wrong path (@path mismatch) → signature-invalid",
      res.ok === false && res.reason === "signature-invalid",
      `reason=${res.reason}`
    );
  }

  // (d) unknown keyid → signature-invalid
  {
    const message = { method: "POST", url: DEPOSIT_URL, ...deposit };
    const res = await verifySignedCallback(message, async () => null);
    check(
      "unknown keyid → signature-invalid",
      res.ok === false && res.reason === "signature-invalid",
      `reason=${res.reason}`
    );
  }

  console.log(
    `\n${failures === 0 ? "All cases passed." : `${failures} case(s) failed.`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test harness error:", err);
  process.exit(1);
});
