import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey } from "viem/accounts";
import { bodyForAgent, createSafeBuyMcpServer } from "../src/mcp.js";
import { type Srv, baseRpcServer, probeServer, sellerServer } from "./helpers.js";

const open: Srv[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close()));
});

async function connect(env: Record<string, string | undefined>, defaults = {}) {
  const server = createSafeBuyMcpServer({ env, defaults });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  return client;
}

const textOf = (r: any) => r.content[0].text as string;

test("MCP: lists check_seller, safe_buy, verify_receipt; no key arguments anywhere", async () => {
  const client = await connect({});
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_seller", "safe_buy", "verify_receipt"]);
  for (const t of tools) {
    const props = Object.keys((t.inputSchema as any).properties ?? {});
    assert.ok(!props.some((p) => /key|secret|signer/i.test(p)), `${t.name}: ${props}`);
  }
  const buy = tools.find((t) => t.name === "safe_buy")!;
  assert.ok((buy.inputSchema as any).required.includes("maxPrice"));
  await client.close();
});

test("MCP: check_seller returns the stages and the offer", async () => {
  const probe = await probeServer(null);
  const seller = await sellerServer({});
  open.push(probe, seller);
  const client = await connect({ SAFE_BUY_PROBE_URL: probe.url });
  const r = await client.callTool({ name: "check_seller", arguments: { url: seller.dataUrl, maxPrice: "$0.01" } });
  const out = JSON.parse(textOf(r));
  assert.equal(out.ok, true);
  assert.deepEqual(out.stages.map((s: any) => s.name), ["probe", "402", "price"]);
  assert.equal(out.offer.amount, "5000");
  assert.equal(seller.counts.paid, 0);
  await client.close();
});

test("MCP: safe_buy without a configured wallet errors; above the server cap errors; with a wallet returns body text + evidence", async () => {
  const probe = await probeServer(null);
  const seller = await sellerServer({ paid: { status: 200, body: '{"hello":"world"}' } });
  const rpc = await baseRpcServer({ landed: true });
  open.push(probe, seller, rpc);
  const noKey = await connect({ SAFE_BUY_PROBE_URL: probe.url });
  const r0: any = await noKey.callTool({ name: "safe_buy", arguments: { url: seller.dataUrl, maxPrice: 0.01 } });
  assert.equal(r0.isError, true);
  assert.match(textOf(r0), /no wallet configured/);

  const key = generatePrivateKey();
  const client = await connect(
    { SAFE_BUY_PROBE_URL: probe.url, SAFE_BUY_EVM_PRIVATE_KEY: key, BASE_RPC_URL: rpc.url },
    { findTimeoutMs: 300, pollIntervalMs: 50 },
  );
  const capped: any = await client.callTool({ name: "safe_buy", arguments: { url: seller.dataUrl, maxPrice: 5 } });
  assert.equal(capped.isError, true);
  assert.match(textOf(capped), /above the server cap/);
  assert.equal(seller.counts.paid, 0);

  const r: any = await client.callTool({ name: "safe_buy", arguments: { url: seller.dataUrl, maxPrice: 0.01 } });
  const out = JSON.parse(textOf(r));
  assert.equal(out.outcome, "delivered", textOf(r));
  assert.equal(out.body_text, '{"hello":"world"}');
  assert.equal(out.tx, rpc.txHash);
  assert.ok(!textOf(r).includes(key.slice(2)), "no key material");
  await client.close();
});

test("bodyForAgent: text truncated at 50 KB, small binary as base64", () => {
  const big = new Uint8Array(Buffer.from("a".repeat(60 * 1024)));
  const t = bodyForAgent(big);
  assert.equal((t.body_text as string).length, 50 * 1024);
  assert.equal(t.body_truncated, true);
  const bin = bodyForAgent(new Uint8Array([0xff, 0xfe, 0x00]));
  assert.equal(bin.body_base64, "//4A");
});
