import assert from "node:assert/strict";
import { after, test } from "node:test";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type AttemptRecord, type SafeBuyOptions, checkSeller, safeBuy } from "../src/index.js";
import { type Srv, baseRpcServer, probeServer, sellerServer } from "./helpers.js";

const open: Srv[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close()));
});
const track = <T extends Srv>(s: T) => (open.push(s), s);

/** A prebuilt client whose signing calls are counted (to prove nothing was signed). */
function spyClient(key = generatePrivateKey(), rpcUrl = "http://127.0.0.1:1") {
  const client = x402Client.fromConfig({ schemes: [] });
  client.register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(key), { rpcUrl }));
  let signs = 0;
  const orig = client.createPaymentPayload.bind(client);
  client.createPaymentPayload = (async (...args: Parameters<typeof orig>) => {
    signs++;
    return orig(...args);
  }) as typeof client.createPaymentPayload;
  return { client, signs: () => signs };
}

async function setup(o: {
  probe?: Record<string, unknown> | null | "error";
  seller?: Parameters<typeof sellerServer>[0];
  rpc?: Parameters<typeof baseRpcServer>[0];
}) {
  const probe = track(await probeServer(o.probe ?? null));
  const seller = track(await sellerServer(o.seller));
  const rpc = track(await baseRpcServer(o.rpc ?? { landed: false }));
  const key = generatePrivateKey();
  const payer = privateKeyToAccount(key).address;
  rpc.setPayer(payer);
  const attempts: AttemptRecord[] = [];
  const opts = (extra: Partial<SafeBuyOptions> = {}): SafeBuyOptions => ({
    probeUrl: probe.url,
    maxPrice: "$0.01",
    signer: { evmPrivateKey: key },
    rpc: { base: rpc.url },
    findTimeoutMs: 300,
    pollIntervalMs: 50,
    onAttempt: (r) => void attempts.push(r),
    ...extra,
  });
  return { probe, seller, rpc, key, payer, attempts, opts };
}

test("stops at probe when the last paid purchase was not_delivered (nothing signed, seller never asked)", async () => {
  const { seller, opts, attempts } = await setup({ probe: { host: "127.0.0.1", last_paid: { date: "2026-10-30", outcome: "not_delivered" } } });
  const spy = spyClient();
  const r = await safeBuy(seller.dataUrl, opts({ signer: undefined, client: spy.client }));
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "refused");
  assert.equal(r.stopped_at, "probe");
  assert.match(r.reason!, /2026-10-30/);
  assert.match(r.reason!, /not_delivered/);
  assert.equal(spy.signs(), 0);
  assert.equal(attempts.length, 0);
  assert.equal(seller.counts.unpaid + seller.counts.paid, 0);
});

test("stops at probe when the last paid purchase was overcharged", async () => {
  const { seller, opts, attempts } = await setup({ probe: { last_paid: { date: "2026-10-28", outcome: "overcharged" } } });
  const r = await safeBuy(seller.dataUrl, opts());
  assert.equal(r.stopped_at, "probe");
  assert.match(r.reason!, /overcharged.*|2026-10-28/);
  assert.match(r.reason!, /2026-10-28/);
  assert.equal(attempts.length, 0);
});

test("probe buyable_without_input === false without input → stop; probe 404 / 5xx → continue", async () => {
  const a = await setup({ probe: { buyable_without_input: false, requires_input_reason: { reason: "requires_input: method POST" } } });
  const r = await checkSeller(a.seller.dataUrl, { probeUrl: a.probe.url });
  assert.equal(r.stopped_at, "probe");
  assert.match(r.reason!, /not buyable without input/);

  const b = await setup({ probe: null });
  const r2 = await checkSeller(b.seller.dataUrl, { probeUrl: b.probe.url, maxPrice: 0.01 });
  assert.equal(r2.ok, true, JSON.stringify(r2.stages));
  assert.deepEqual(r2.stages[0], { name: "probe", ok: true, detail: "no data" });
  assert.equal(r2.offer?.amount, "5000");
  assert.equal(r2.offer?.chain, "base");

  const c = await setup({ probe: "error" });
  const r3 = await checkSeller(c.seller.dataUrl, { probeUrl: c.probe.url });
  assert.equal(r3.ok, true);
  assert.match(r3.stages[0].detail, /unavailable \(HTTP 503\)/);
});

test("required input declared in the 402 (bazaar) without input → stop at 402; with input → passes and is sent", async () => {
  const bazaar = { extensions: { bazaar: { info: { input: { type: "http", method: "POST", bodyType: "json", body: { q: "x" } } } } } };
  const s = await setup({ seller: { doc: bazaar } });
  const spy = spyClient();
  const r = await safeBuy(s.seller.dataUrl, s.opts({ signer: undefined, client: spy.client }));
  assert.equal(r.stopped_at, "402");
  assert.match(r.reason!, /requires_input: method POST/);
  assert.equal(spy.signs(), 0);
  assert.equal(s.attempts.length, 0);

  const ok = await checkSeller(s.seller.dataUrl, { probeUrl: s.probe.url, input: { body: { q: "tokyo" } } });
  assert.equal(ok.ok, true, ok.reason ?? "");
  assert.equal(s.seller.seen.method, "POST");
  assert.equal(s.seller.seen.body, '{"q":"tokyo"}');
});

test("v1 outputSchema with a required query field → stop at 402", async () => {
  const s = await setup({ seller: { v1: true } });
  // inject an outputSchema through the doc override: v1 accepts are rebuilt, so use a v1 doc with outputSchema
  const s2 = await setup({
    seller: {
      v1: true,
      doc: {
        accepts: [{
          scheme: "exact", network: "base", maxAmountRequired: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x2222222222222222222222222222222222222222", resource: "http://x/data", maxTimeoutSeconds: 60,
          outputSchema: { input: { type: "http", method: "GET", queryParams: { city: { type: "string", required: true } } } },
        }],
      },
    },
  });
  const plain = await checkSeller(s.seller.dataUrl, { probeUrl: s.probe.url });
  assert.equal(plain.ok, true, plain.reason ?? "");
  assert.equal(plain.offer?.spec_version, "v1");
  const r = await checkSeller(s2.seller.dataUrl, { probeUrl: s2.probe.url });
  assert.equal(r.stopped_at, "402");
  assert.match(r.reason!, /query: city/);
});

test("price above maxPrice → stops before signing (signer and onAttempt never called)", async () => {
  const s = await setup({ seller: { amount: "10001" } });
  const spy = spyClient();
  const r = await safeBuy(s.seller.dataUrl, s.opts({ signer: undefined, client: spy.client, maxPrice: 0.01 }));
  assert.equal(r.ok, false);
  assert.equal(r.stopped_at, "price");
  assert.match(r.reason!, /\$0\.010001 > maxPrice \$0\.01/);
  assert.equal(spy.signs(), 0);
  assert.equal(s.attempts.length, 0);
  assert.equal(s.seller.counts.paid, 0);
  assert.equal(r.payer_key, null);
});

test("maxPrice is required", async () => {
  await assert.rejects(() => safeBuy("http://127.0.0.1:1/x", { signer: { evmPrivateKey: generatePrivateKey() } } as any), /maxPrice is required/);
});

test("catalog price differs from the 402 → price_mismatch, unless allowCatalogMismatch", async () => {
  const s = await setup({ seller: { amount: "5000" } });
  s.probe.close();
  const probe = track(await probeServer({ catalog: { url: s.seller.dataUrl, price_usd: 0.001 } }));
  const spy = spyClient();
  const r = await safeBuy(s.seller.dataUrl, s.opts({ probeUrl: probe.url, signer: undefined, client: spy.client }));
  assert.equal(r.stopped_at, "price");
  assert.equal(r.reason, "price_mismatch (catalog $0.001, 402 $0.005)");
  assert.equal(spy.signs(), 0);
  const allowed = await checkSeller(s.seller.dataUrl, { probeUrl: probe.url, maxPrice: 0.01, allowCatalogMismatch: true });
  assert.equal(allowed.ok, true);
  assert.match(allowed.stages.find((x) => x.name === "price")!.detail, /allowed by allowCatalogMismatch/);
});

test("200 with a settlement header → tx verified on chain → delivered", async () => {
  const txHash = "0x" + "cd".repeat(32);
  const s = await setup({ seller: { paid: { status: 200, body: '{"data":1}', settleTx: txHash } }, rpc: { landed: true, txHash } });
  const r = await safeBuy(s.seller.dataUrl, s.opts());
  assert.equal(r.outcome, "delivered", JSON.stringify(r.stages));
  assert.equal(r.ok, true);
  assert.equal(r.tx, txHash);
  assert.equal(r.tx_source, "settle_header");
  assert.equal(r.transferred, "5000");
  assert.equal(Buffer.from(r.body!).toString(), '{"data":1}');
  assert.equal(r.status, 200);
  assert.match(r.content_type!, /json/);
});

test("200 without a settlement header → chain search finds our payment → delivered; onAttempt ran before sending", async () => {
  const s = await setup({ seller: { paid: { status: 200, body: '{"data":2}' } }, rpc: { landed: true } });
  let paidAtAttempt = -1;
  const r = await safeBuy(s.seller.dataUrl, s.opts({ onAttempt: (rec) => { s.attempts.push(rec); paidAtAttempt = s.seller.counts.paid; } }));
  assert.equal(r.outcome, "delivered", JSON.stringify(r.stages));
  assert.equal(r.tx, s.rpc.txHash);
  assert.equal(r.tx_source, "onchain_search");
  assert.equal(paidAtAttempt, 0, "onAttempt is called before the paid request");
  assert.equal(s.attempts.length, 1);
  const rec = s.attempts[0];
  assert.equal(rec.payer_key.chain, "base");
  if (rec.payer_key.chain === "base") {
    assert.match(rec.payer_key.authorization_nonce, /^0x[0-9a-f]{64}$/);
    assert.match(rec.payer_key.authorization_signature_sha256, /^[0-9a-f]{64}$/);
    // the raw EIP-3009 signature is never handed out
    const raw = JSON.parse(Buffer.from(s.seller.seen.paymentHeader!, "base64").toString()).payload.signature;
    assert.ok(!JSON.stringify(rec).includes(raw.slice(2)));
    assert.ok(!JSON.stringify(r).includes(raw.slice(2)));
  }
  assert.equal(rec.payer_key.payer.toLowerCase(), s.payer.toLowerCase());
  assert.deepEqual(r.payer_key, rec.payer_key);
  assert.ok(!JSON.stringify(r.payer_key).includes(s.key.slice(2)), "no key material");
});

test("200 without a settlement header and nothing on chain → delivered_unsettled", async () => {
  const s = await setup({ seller: { paid: { status: 200, body: "free lunch" } }, rpc: { landed: false } });
  const r = await safeBuy(s.seller.dataUrl, s.opts());
  assert.equal(r.outcome, "delivered_unsettled");
  assert.equal(r.tx, null);
  assert.ok(s.rpc.calls.includes("eth_getLogs"));
  assert.equal(Buffer.from(r.body!).toString(), "free lunch");
});

test("non-200 after payment, tx found, seller keeps receipts → refetch → delivered with refetched:true", async () => {
  const s = await setup({
    seller: { paid: { status: 500, body: "oops" }, refetch: { status: 200, body: '{"data":"late"}' }, receipts: true },
    rpc: { landed: true },
  });
  const r = await safeBuy(s.seller.dataUrl, s.opts());
  assert.equal(r.outcome, "delivered", JSON.stringify(r.stages));
  assert.equal(r.refetched, true);
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(r.body!).toString(), '{"data":"late"}');
  assert.equal(r.receipt?.ok, true);
  assert.equal(s.seller.counts.refetch, 1);
  assert.equal(s.seller.counts.paid, 1, "the payment is sent once");
  if (r.payer_key?.chain === "base") assert.equal(s.seller.seen.refetchHeader, r.payer_key.authorization_nonce);
  assert.equal(r.stages.find((x) => x.name === "refetch")?.ok, true);
});

test("non-200 after payment, tx found, no receipts → not_delivered", async () => {
  const s = await setup({ seller: { paid: { status: 500, body: "oops" } }, rpc: { landed: true } });
  const r = await safeBuy(s.seller.dataUrl, s.opts());
  assert.equal(r.outcome, "not_delivered");
  assert.equal(r.ok, false);
  assert.equal(r.refetched, false);
  assert.equal(s.seller.counts.refetch, 0);
});

test("402 again after payment and nothing on chain → rejected", async () => {
  const s = await setup({ seller: { paid: { status: 402, body: "{}" } }, rpc: { landed: false } });
  const r = await safeBuy(s.seller.dataUrl, s.opts());
  assert.equal(r.outcome, "rejected");
  assert.equal(r.status, 402);
});

test("transferred amount > offered → overcharged", async () => {
  const s = await setup({ seller: { paid: { status: 200, body: "{}" } }, rpc: { landed: true, transferred: "9000" } });
  const r = await safeBuy(s.seller.dataUrl, s.opts());
  assert.equal(r.outcome, "overcharged");
  assert.equal(r.ok, false);
  assert.equal(r.transferred, "9000");
  assert.equal(r.amount, "5000");
});

test("X-Delivery-Receipt on the 200 is verified", async () => {
  const s = await setup({ seller: { paid: { status: 200, body: '{"r":1}', receipt: true }, receipts: true }, rpc: { landed: true } });
  const r = await safeBuy(s.seller.dataUrl, s.opts());
  assert.equal(r.outcome, "delivered");
  assert.equal(r.receipt?.ok, true, r.receipt?.reason ?? "");
  assert.equal(r.stages.find((x) => x.name === "receipt")?.ok, true);
});

test("report: anonymized payload without payer, tx, payer_key, body or query", async () => {
  const s = await setup({ seller: { paid: { status: 200, body: '{"secret":"BODY-CONTENT"}' } }, rpc: { landed: true } });
  const r = await safeBuy(`${s.seller.dataUrl}?city=tokyo`, s.opts({ report: true }));
  assert.equal(r.outcome, "delivered");
  assert.equal(s.probe.reports.length, 1);
  const rep = s.probe.reports[0];
  assert.deepEqual(Object.keys(rep).sort(), [
    "amount", "host", "http_status", "latency_ms", "network", "onchain_found", "outcome", "receipt_ok", "refetched", "sdk", "settled_header", "ts", "url", "v",
  ]);
  assert.equal(rep.v, 1);
  assert.equal(rep.url, s.seller.dataUrl);
  assert.equal(rep.outcome, "delivered");
  assert.equal(rep.onchain_found, true);
  assert.equal(rep.settled_header, false);
  assert.match(rep.sdk, /^@x402jp\/safe-buy@\d/);
  const text = JSON.stringify(rep).toLowerCase();
  assert.ok(!text.includes(s.payer.toLowerCase().slice(2)), "no payer address");
  assert.ok(!text.includes(s.rpc.txHash.slice(2)), "no tx");
  if (r.payer_key?.chain === "base") {
    assert.ok(!text.includes(r.payer_key.authorization_nonce.slice(2)), "no nonce");
    assert.ok(!text.includes(r.payer_key.authorization_signature_sha256), "no signature hash");
  }
  assert.ok(!text.includes("body-content"), "no body");
  assert.ok(!text.includes("tokyo"), "no query");
});

test("report failure never fails the purchase; no report unless report === true", async () => {
  const s = await setup({ seller: { paid: { status: 200, body: "{}" } }, rpc: { landed: true } });
  const r = await safeBuy(s.seller.dataUrl, s.opts());
  assert.equal(s.probe.reports.length, 0);
  assert.equal(r.stages.some((x) => x.name === "report"), false);
  await s.probe.close();
  // Probe is now down: the lookup is "unavailable" and the report fails, the purchase still succeeds.
  const r2 = await safeBuy(s.seller.dataUrl, s.opts({ report: true }));
  assert.equal(r2.outcome, "delivered");
  assert.equal(r2.stages.find((x) => x.name === "report")?.ok, false);
});

test("onAttempt throwing → payment is not sent", async () => {
  const s = await setup({});
  const r = await safeBuy(s.seller.dataUrl, s.opts({ onAttempt: () => { throw new Error("ledger down"); } }));
  assert.equal(r.stopped_at, "pay");
  assert.match(r.reason!, /ledger down/);
  assert.equal(s.seller.counts.paid, 0);
});

test("chain 'solana' without a Solana accept → stop at 402", async () => {
  const s = await setup({});
  const r = await checkSeller(s.seller.dataUrl, { probeUrl: s.probe.url, chain: "solana" });
  assert.equal(r.stopped_at, "402");
  assert.match(r.reason!, /no exact official-USDC accept/);
});
