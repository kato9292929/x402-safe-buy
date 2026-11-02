// MCP server exposing check_seller, safe_buy and verify_receipt. Signing keys come only
// from the server's environment (SAFE_BUY_EVM_PRIVATE_KEY / SAFE_BUY_SOLANA_SECRET_KEY),
// never from tool arguments, and are never echoed back.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VERSION } from "./constants.js";
import { atomicToUsd, usdToAtomic } from "./price.js";
import { verifyReceipt } from "./receipt.js";
import { type SafeBuyOptions, type SafeBuyResult, checkSeller, safeBuy } from "./safe-buy.js";

export const BODY_LIMIT_BYTES = 50 * 1024;
/** Default ceiling on any maxPrice an agent passes to safe_buy (USD). Override with SAFE_BUY_MAX_PRICE_CAP. */
export const DEFAULT_MAX_PRICE_CAP = "0.10";

export type McpConfig = {
  /** Where keys and settings are read from (default process.env). */
  env?: Record<string, string | undefined>;
  /** Extra safeBuy options for every call (tests: rpc, findTimeoutMs, pollIntervalMs). Keys are not accepted here. */
  defaults?: Omit<Partial<SafeBuyOptions>, "signer" | "client" | "maxPrice">;
};

const chain = z.enum(["base", "solana", "any"]).optional().describe('Chain to pay on (default "any": Base, then Solana)');
const price = z.union([z.number().positive(), z.string()]);
const input = z
  .object({
    method: z.string().optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.any().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .optional()
  .describe("Request input for endpoints that need more than a bare GET");

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

/** Body as UTF-8 text (truncated) when it decodes, else base64 when small enough. */
export function bodyForAgent(body: Uint8Array | null): Record<string, unknown> {
  if (!body) return { body_bytes: 0 };
  const truncated = body.length > BODY_LIMIT_BYTES;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, BODY_LIMIT_BYTES));
    return { body_bytes: body.length, body_text: text, body_truncated: truncated };
  } catch {
    // A cut in the middle of a multi-byte character is still text.
    if (truncated) {
      const t = new TextDecoder("utf-8", { fatal: false }).decode(body.subarray(0, BODY_LIMIT_BYTES));
      if (!/�/.test(t.slice(0, -1))) return { body_bytes: body.length, body_text: t.replace(/�$/, ""), body_truncated: true };
    }
    return truncated
      ? { body_bytes: body.length, body_binary: true, body_truncated: true }
      : { body_bytes: body.length, body_base64: Buffer.from(body).toString("base64"), body_binary: true };
  }
}

/** The evidence fields of a purchase plus the body in agent-readable form. */
export function safeBuyView(r: SafeBuyResult): Record<string, unknown> {
  const { body, probe, ...rest } = r;
  return { ...rest, probe_status: probe.status, ...bodyForAgent(body) };
}

export function createSafeBuyMcpServer(config: McpConfig = {}): McpServer {
  const env = config.env ?? process.env;
  const server = new McpServer({ name: "x402-safe-buy", version: VERSION });
  const probeUrl = config.defaults?.probeUrl || env.SAFE_BUY_PROBE_URL || undefined;

  server.registerTool(
    "check_seller",
    {
      title: "Check an x402 seller (no payment)",
      description:
        "Looks up the seller at the x402 Seller Probe, fetches the 402 offer and checks price/input requirements. Never pays.",
      inputSchema: { url: z.string().url(), chain, maxPrice: price.optional().describe("USD cap, e.g. 0.01 or \"$0.01\""), input },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        return json(await checkSeller(a.url, { ...config.defaults, probeUrl, chain: a.chain, maxPrice: a.maxPrice, input: a.input }));
      } catch (e: any) {
        return fail(`check_seller failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "safe_buy",
    {
      title: "Buy one x402 call safely (spends USDC)",
      description:
        "Pays an x402 seller in USDC only if the Probe record, the 402 offer and the price pass; reconciles the payment on chain, refetches with a Delivery Receipt if needed. Spends real money.",
      inputSchema: {
        url: z.string().url(),
        maxPrice: price.describe("Required USD cap, e.g. 0.01 or \"$0.01\""),
        chain,
        input,
        report: z.boolean().optional().describe("Send an anonymized outcome report to the Probe (default false)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      const signer = { evmPrivateKey: env.SAFE_BUY_EVM_PRIVATE_KEY || undefined, solanaSecretKey: env.SAFE_BUY_SOLANA_SECRET_KEY || undefined };
      if (!signer.evmPrivateKey && !signer.solanaSecretKey) return fail("safe_buy: no wallet configured on the server (SAFE_BUY_EVM_PRIVATE_KEY / SAFE_BUY_SOLANA_SECRET_KEY)");
      let cap: bigint, max: bigint;
      try {
        cap = usdToAtomic(env.SAFE_BUY_MAX_PRICE_CAP || DEFAULT_MAX_PRICE_CAP);
        max = usdToAtomic(a.maxPrice);
      } catch (e: any) {
        return fail(`safe_buy: ${e?.message ?? e}`);
      }
      if (max > cap) return fail(`safe_buy: maxPrice ${atomicToUsd(max)} is above the server cap ${atomicToUsd(cap)} (SAFE_BUY_MAX_PRICE_CAP)`);
      try {
        const r = await safeBuy(a.url, {
          ...config.defaults,
          probeUrl,
          maxPrice: a.maxPrice,
          chain: a.chain,
          input: a.input,
          report: a.report === true,
          signer,
          rpc: { base: env.BASE_RPC_URL, solana: env.SOLANA_RPC_URL, ...config.defaults?.rpc },
        });
        return json(safeBuyView(r));
      } catch (e: any) {
        return fail(`safe_buy failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "verify_receipt",
    {
      title: "Verify an x402 Delivery Receipt",
      description: "Fetches the seller's /.well-known/x402-receipt.json and verifies an X-Delivery-Receipt against the body bytes and payment id.",
      inputSchema: {
        url: z.string().url(),
        receipt: z.string().min(1).describe("X-Delivery-Receipt header value"),
        body_base64: z.string().describe("Exact response body, base64"),
        payment_id: z.string().optional().describe("Solana tx signature or Base EIP-3009 nonce"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        const r = await verifyReceipt({ url: a.url, header: a.receipt, body: new Uint8Array(Buffer.from(a.body_base64, "base64")), paymentId: a.payment_id ?? null });
        return json(r);
      } catch (e: any) {
        return fail(`verify_receipt failed: ${e?.message ?? e}`);
      }
    },
  );

  return server;
}
