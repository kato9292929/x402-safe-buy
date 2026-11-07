// Offline test fixtures: local HTTP servers for the Probe, a seller and a JSON-RPC node.
import { generateKeyPairSync, sign } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { AUTHORIZATION_USED, topicAddr } from "../src/chains/base.js";
import { USDC } from "../src/constants.js";
import { RECEIPT_HEADER, WELL_KNOWN_PATH, encodeReceipt, receiptSigningBytes, sha256Hex, type Receipt } from "@x402jp/delivery-receipt-verify";

export type Srv = { url: string; close: () => Promise<void> };

export async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>): Promise<Srv> {
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      Promise.resolve(handler(req, res, Buffer.concat(chunks))).catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

export const PAY_TO_BASE = "0x2222222222222222222222222222222222222222";
export const PAY_TO_SOL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
export const FEE_PAYER_SOL = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";

/** Probe mock: GET /scores/:host → doc (or 404), POST /reports → recorded. */
export async function probeServer(doc: Record<string, unknown> | null | "error") {
  const reports: any[] = [];
  const s = await serve((req, res, body) => {
    if (req.method === "POST" && req.url === "/reports") {
      reports.push(JSON.parse(body.toString("utf8")));
      res.statusCode = 202;
      return void res.end("{}");
    }
    if (req.url?.startsWith("/scores/")) {
      if (doc === "error") {
        res.statusCode = 503;
        return void res.end("down");
      }
      if (!doc) {
        res.statusCode = 404;
        return void res.end("{}");
      }
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify(doc));
    }
    res.statusCode = 404;
    res.end();
  });
  return { ...s, reports };
}

export type SellerOpts = {
  amount?: string;
  chain?: "base" | "solana";
  /** Extra fields merged into the 402 document (e.g. extensions). */
  doc?: Record<string, unknown>;
  /** What the paid request returns. */
  paid?: { status: number; body: string; settleTx?: string | null; receipt?: boolean };
  /** Answer to a refetch (X-Payment-Refetch). */
  refetch?: { status: number; body: string };
  /** Publish /.well-known/x402-receipt.json and sign receipts. */
  receipts?: boolean;
  v1?: boolean;
};

export async function sellerServer(o: SellerOpts = {}) {
  const amount = o.amount ?? "5000";
  const chain = o.chain ?? "base";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const counts = { unpaid: 0, paid: 0, refetch: 0, wellKnown: 0 };
  const seen: { paymentHeader?: string; refetchHeader?: string; method?: string; body?: string; paidMethod?: string; paidBody?: string } = {};
  let base = "";
  const accept =
    chain === "base"
      ? { scheme: "exact", network: o.v1 ? "base" : "eip155:8453", asset: USDC.base, payTo: PAY_TO_BASE, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }
      : {
          scheme: "exact", network: o.v1 ? "solana" : "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: USDC.solana, payTo: PAY_TO_SOL, maxTimeoutSeconds: 60,
          extra: { feePayer: FEE_PAYER_SOL, recentBlockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1000 },
        };
  const doc402 = () =>
    o.v1
      ? { x402Version: 1, error: "payment required", accepts: [{ ...accept, maxAmountRequired: amount, resource: `${base}/data`, description: "", mimeType: "application/json" }], ...(o.doc ?? {}) }
      : { x402Version: 2, resource: { url: `${base}/data`, description: "", mimeType: "application/json" }, accepts: [{ ...accept, amount }], ...(o.doc ?? {}) };

  const signReceipt = (paymentId: string, body: string, delivery: "first" | "refetch") => {
    const bytes = Buffer.from(body);
    const payload = {
      v: 1 as const, payment_id: paymentId, network: accept.network, resource: `${base}/data`, body_sha256: sha256Hex(bytes),
      content_length: bytes.length, issued_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), delivery, key_id: "k1",
    };
    const sig = sign(null, receiptSigningBytes(payload), privateKey).toString("base64url");
    return encodeReceipt({ ...payload, sig } as Receipt);
  };

  const paymentIdOf = (header: string) => {
    const p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return p?.payload?.authorization?.nonce as string | undefined;
  };

  const s = await serve((req, res, body) => {
    if (req.url === WELL_KNOWN_PATH) {
      counts.wellKnown++;
      if (!o.receipts) {
        res.statusCode = 404;
        return void res.end();
      }
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify({ keys: [{ key_id: "k1", alg: "Ed25519", public_key: jwk.x }], refetch_window_s: 604800, refetch_header: "X-Payment-Refetch" }));
    }
    const pay = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;
    if (!pay) {
      counts.unpaid++;
      seen.method = req.method;
      seen.body = body.toString("utf8");
      res.statusCode = 402;
      const d = doc402();
      if (o.v1) {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify(d));
      }
      res.setHeader("payment-required", Buffer.from(JSON.stringify(d)).toString("base64"));
      return void res.end("{}");
    }
    const refetchId = req.headers["x-payment-refetch"] as string | undefined;
    if (refetchId) {
      counts.refetch++;
      seen.refetchHeader = refetchId;
      const r = o.refetch ?? { status: 404, body: "" };
      res.statusCode = r.status;
      if (r.status === 200 && o.receipts) res.setHeader(RECEIPT_HEADER, signReceipt(refetchId, r.body, "refetch"));
      return void res.end(r.body);
    }
    counts.paid++;
    seen.paymentHeader = pay;
    seen.paidMethod = req.method;
    seen.paidBody = body.toString("utf8");
    const p = o.paid ?? { status: 200, body: '{"ok":true}' };
    res.statusCode = p.status;
    if (p.settleTx) {
      const settle = { success: true, transaction: p.settleTx, network: accept.network, payer: "x" };
      res.setHeader(o.v1 ? "x-payment-response" : "payment-response", Buffer.from(JSON.stringify(settle)).toString("base64"));
    }
    if (p.receipt && o.receipts && p.status === 200) {
      const id = chain === "base" ? paymentIdOf(pay) : p.settleTx;
      if (id) res.setHeader(RECEIPT_HEADER, signReceipt(id, p.body, "first"));
    }
    res.setHeader("content-type", "application/json");
    res.end(p.body);
  });
  base = s.url;
  return { ...s, dataUrl: `${s.url}/data`, counts, seen };
}

/**
 * Base JSON-RPC mock. When `landed`, eth_getLogs returns an AuthorizationUsed log for the
 * queried (payer, nonce) and the receipt carries a USDC Transfer of `transferred` to PAY_TO.
 */
export async function baseRpcServer(o: { landed: boolean; transferred?: string; txHash?: string }) {
  const txHash = o.txHash ?? "0x" + "ab".repeat(32);
  let payer: string | null = null;
  const calls: string[] = [];
  const s = await serve((req, res, body) => {
    const { method, params } = JSON.parse(body.toString("utf8"));
    calls.push(method);
    let result: unknown = null;
    if (method === "eth_blockNumber") result = "0x1000";
    if (method === "eth_getLogs") {
      const topics = params[0].topics;
      payer = "0x" + topics[1].slice(26);
      result = o.landed && topics[0] === AUTHORIZATION_USED ? [{ transactionHash: txHash, topics, address: USDC.base, data: "0x" }] : [];
    }
    if (method === "eth_getTransactionReceipt") {
      result =
        o.landed && params[0] === txHash
          ? {
              status: "0x1", blockNumber: "0x1000", from: "0x9999999999999999999999999999999999999999",
              logs: [{
                address: USDC.base,
                topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topicAddr(payer ?? "0x0"), topicAddr(PAY_TO_BASE)],
                data: "0x" + BigInt(o.transferred ?? "5000").toString(16).padStart(64, "0"),
              }],
            }
          : null;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
  return { ...s, txHash, calls, setPayer: (p: string) => (payer = p) };
}
