import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { atomicToUsd, inputRequirement, parse402, selectAccept, usdToAtomic, verifyReceipt } from "../src/index.js";
import { checkBaseTransfer, topicAddr } from "../src/chains/base.js";
import { buildReport } from "../src/report.js";
import { encodeReceipt, receiptSigningBytes, sha256Hex, WELL_KNOWN_PATH } from "../src/vendor/delivery-receipt-verify.js";
import { serve } from "./helpers.js";

test("usdToAtomic / atomicToUsd", () => {
  assert.equal(usdToAtomic(0.01), 10_000n);
  assert.equal(usdToAtomic("$0.01"), 10_000n);
  assert.equal(usdToAtomic("0.0000019"), 1n, "truncates past 6 decimals");
  assert.equal(usdToAtomic(1), 1_000_000n);
  assert.throws(() => usdToAtomic("ten"));
  assert.throws(() => usdToAtomic(-1));
  assert.equal(atomicToUsd(10_000n), "$0.01");
  assert.equal(atomicToUsd("10001"), "$0.010001");
  assert.equal(atomicToUsd(1_500_000n), "$1.50");
});

const B = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const S = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const doc = {
  x402Version: 2,
  resource: { url: "https://s.example/x" },
  accepts: [
    { scheme: "exact", network: "eip155:8453", amount: "1", asset: "0x4444444444444444444444444444444444444444", payTo: "0x2" },
    { scheme: "upto", network: "eip155:8453", amount: "2", asset: B, payTo: "0x2" },
    { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "3", asset: S, payTo: "So1" },
    { scheme: "exact", network: "eip155:8453", amount: "4", asset: B.toLowerCase(), payTo: "0x2" },
  ],
};
const parsed = parse402((n) => (n === "payment-required" ? Buffer.from(JSON.stringify(doc)).toString("base64") : null), "");

test("selectAccept: exact + official USDC on the requested chain; any prefers Base", () => {
  assert.equal(selectAccept(parsed, "base")?.amount, "4");
  assert.equal(selectAccept(parsed, "solana")?.amount, "3");
  assert.equal(selectAccept(parsed, "any")?.amount, "4");
  assert.equal(selectAccept(parsed, "any", ["solana"])?.amount, "3");
});

test("inputRequirement: bazaar JSON-schema form", () => {
  const p = parse402(() => null, JSON.stringify({
    x402Version: 2, accepts: [],
    extensions: { bazaar: { schema: { properties: { input: { properties: { method: { const: "POST" } } } } } } },
  }));
  assert.deepEqual(inputRequirement(p), { requires: true, reason: "method POST", source: "bazaar" });
  assert.equal(inputRequirement(parsed).requires, false);
});

test("checkBaseTransfer reports what left the payer", () => {
  const payer = "0x1111111111111111111111111111111111111111";
  const payTo = "0x2222222222222222222222222222222222222222";
  const log = (to: string, v: number) => ({
    address: B, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topicAddr(payer), topicAddr(to)], data: "0x" + v.toString(16),
  });
  const ok = checkBaseTransfer({ status: "0x1", logs: [log(payTo, 5000)] }, { payer, payTo, amount: 5000n });
  assert.equal(ok.ok, true);
  const over = checkBaseTransfer({ status: "0x1", logs: [log(payTo, 5000), log("0x3333333333333333333333333333333333333333", 100)] }, { payer, payTo, amount: 5000n });
  assert.equal(over.ok, false);
  assert.equal(over.transferred, "5100");
  assert.equal(over.received_by_pay_to, "5000");
});

test("buildReport strips the query string", () => {
  const r = buildReport({
    host: "s.example", url: "https://s.example/x?q=secret#f", network: "eip155:8453", amount: "1", outcome: "delivered",
    http_status: 200, latency_ms: 1, settled_header: true, onchain_found: true, receipt_ok: null, refetched: false,
  });
  assert.equal(r.url, "https://s.example/x");
});

test("verifyReceipt fetches the key document and checks signature, body and payment_id", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as any).x;
  const s = await serve((req, res) => {
    if (req.url === WELL_KNOWN_PATH) return void res.end(JSON.stringify({ keys: [{ key_id: "k", alg: "Ed25519", public_key: x }], refetch_window_s: 86400, refetch_header: "X-Payment-Refetch" }));
    res.statusCode = 404;
    res.end();
  });
  try {
    const body = new Uint8Array(Buffer.from("hello"));
    const payload = {
      v: 1 as const, payment_id: "0x" + "aa".repeat(32), network: "eip155:8453", resource: `${s.url}/x`, body_sha256: sha256Hex(body),
      content_length: body.length, issued_at: "2026-11-01T00:00:00Z", delivery: "first" as const, key_id: "k",
    };
    const header = encodeReceipt({ ...payload, sig: sign(null, receiptSigningBytes(payload), privateKey).toString("base64url") });
    assert.equal((await verifyReceipt({ url: `${s.url}/x`, header, body, paymentId: payload.payment_id.toUpperCase().replace("0X", "0x") })).ok, true);
    const bad = await verifyReceipt({ url: `${s.url}/x`, header, body: new Uint8Array(Buffer.from("hellO")), paymentId: payload.payment_id });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "receipt_hash_mismatch");
    const wrongId = await verifyReceipt({ url: `${s.url}/x`, header, body, paymentId: "0x" + "bb".repeat(32) });
    assert.match(wrongId.reason!, /payment_id mismatch/);
  } finally {
    await s.close();
  }
});
