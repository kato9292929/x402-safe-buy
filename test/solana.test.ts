import assert from "node:assert/strict";
import { after, test } from "node:test";
import bs58 from "bs58";
import { generateKeyPairSigner } from "@solana/kit";
import { USDC } from "../src/constants.js";
import { type AttemptRecord, safeBuy } from "../src/index.js";
import { PAY_TO_SOL, type Srv, probeServer, sellerServer, serve } from "./helpers.js";

const open: Srv[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close()));
});

/** A throwaway Solana key as a 64-byte secret (private seed + public key), base58. */
async function throwawaySolanaSecret(): Promise<{ secret: string; address: string }> {
  const signer = await generateKeyPairSigner(true);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", signer.keyPair.privateKey));
  const seed = pkcs8.slice(-32);
  const pub = bs58.decode(signer.address);
  return { secret: bs58.encode(new Uint8Array([...seed, ...pub])), address: signer.address };
}

/** USDC mint account (82-byte SPL mint, 6 decimals, initialized) owned by the Token program. */
function mintAccount() {
  const data = new Uint8Array(82);
  data[44] = 6;
  data[45] = 1;
  return {
    data: [Buffer.from(data).toString("base64"), "base64"], executable: false, lamports: 1461600,
    owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 0, space: 82,
  };
}

async function solanaRpc(state: { payerSig: string | null; payer: string; landed: boolean; transferred: string }) {
  const TX = "5".repeat(64);
  const bal = (owner: string, amount: string) => ({ mint: USDC.solana, owner, uiTokenAmount: { amount, decimals: 6 } });
  const s = await serve((_req, res, body) => {
    const { method, params } = JSON.parse(body.toString("utf8"));
    let result: unknown = null;
    if (method === "getAccountInfo") result = { context: { slot: 1 }, value: mintAccount() };
    if (method === "getSignaturesForAddress") result = state.landed ? [{ signature: TX, slot: 1, err: null }] : [];
    if (method === "getTransaction" && state.landed && params[0] === TX) {
      result = {
        slot: 1,
        meta: {
          err: null,
          preTokenBalances: [bal(state.payer, "1000000"), bal(PAY_TO_SOL, "0")],
          postTokenBalances: [bal(state.payer, String(1_000_000n - BigInt(state.transferred))), bal(PAY_TO_SOL, state.transferred)],
        },
        transaction: { signatures: [TX, state.payerSig], message: { accountKeys: [] } },
      };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
  open.push(s);
  return { ...s, TX };
}

test("Solana: signs with a throwaway key, finds our signature on chain when no settlement header → delivered", async () => {
  const { secret, address } = await throwawaySolanaSecret();
  const probe = await probeServer(null);
  const seller = await sellerServer({ chain: "solana", paid: { status: 200, body: '{"sol":true}' } });
  open.push(probe, seller);
  const state = { payerSig: null as string | null, payer: address, landed: true, transferred: "5000" };
  const rpc = await solanaRpc(state);
  const attempts: AttemptRecord[] = [];
  const r = await safeBuy(seller.dataUrl, {
    probeUrl: probe.url,
    maxPrice: 0.01,
    chain: "solana",
    signer: { solanaSecretKey: secret },
    rpc: { solana: rpc.url },
    findTimeoutMs: 300,
    pollIntervalMs: 50,
    onAttempt: (rec) => {
      attempts.push(rec);
      if (rec.payer_key.chain === "solana") state.payerSig = rec.payer_key.payer_signature;
    },
  });
  assert.equal(r.outcome, "delivered", JSON.stringify(r.stages));
  assert.equal(r.tx, rpc.TX);
  assert.equal(r.tx_source, "onchain_search");
  assert.equal(r.network, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].payer_key.payer, address);
  assert.ok(!JSON.stringify(r).includes(secret), "no key material in the result");
});

test("Solana: payer moved more USDC than offered → overcharged", async () => {
  const { secret, address } = await throwawaySolanaSecret();
  const probe = await probeServer(null);
  const seller = await sellerServer({ chain: "solana", paid: { status: 200, body: "{}" } });
  open.push(probe, seller);
  const state = { payerSig: null as string | null, payer: address, landed: true, transferred: "7000" };
  const rpc = await solanaRpc(state);
  const r = await safeBuy(seller.dataUrl, {
    probeUrl: probe.url, maxPrice: 0.01, chain: "any", signer: { solanaSecretKey: secret }, rpc: { solana: rpc.url },
    findTimeoutMs: 300, pollIntervalMs: 50,
    onAttempt: (rec) => { if (rec.payer_key.chain === "solana") state.payerSig = rec.payer_key.payer_signature; },
  });
  assert.equal(r.outcome, "overcharged", JSON.stringify(r.stages));
  assert.equal(r.transferred, "7000");
});
