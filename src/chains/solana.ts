// Solana mainnet: the buyer's own signature in an x402 exact-SVM payment tx, finding that
// tx on chain, and checking the USDC transfer in it. Ported from seller-probe src/chains/solana.ts.
import bs58 from "bs58";
import { createKeyPairSignerFromBytes, getBase64Encoder, getTransactionDecoder } from "@solana/kit";
import { USDC } from "../constants.js";
import { type ChainSearch, type TransferCheck, rpc, sleep } from "./rpc.js";

/** Build a signer from a base58 or JSON-array 64-byte secret key. The key is never kept elsewhere. */
export async function solanaSignerFrom(secret: string) {
  const t = secret.trim();
  const bytes = t.startsWith("[") ? Uint8Array.from(JSON.parse(t)) : bs58.decode(t);
  if (bytes.length !== 64) throw new Error(`Solana secret key must be 64 bytes, got ${bytes.length}`);
  return createKeyPairSignerFromBytes(bytes);
}

function decodeTx(payload: any) {
  const b64 = payload?.payload?.transaction;
  if (typeof b64 !== "string") throw new Error("SVM payload has no payload.transaction");
  return getTransactionDecoder().decode(getBase64Encoder().encode(b64));
}

const signed = (sig: Uint8Array | null | undefined): sig is Uint8Array => !!sig && !sig.every((b) => b === 0);

/**
 * The payer's address and signature inside payload.payload.transaction. The payer is the
 * signer that has already signed (the facilitator's fee-payer slot is still empty), or
 * `payer` when given.
 */
export function payerSignature(payload: any, payer?: string): { payer: string; signature: string } {
  const tx = decodeTx(payload);
  const sigs = tx.signatures as Record<string, Uint8Array | null>;
  const entry = payer ? ([payer, sigs[payer]] as const) : Object.entries(sigs).find(([, s]) => signed(s));
  if (!entry || !signed(entry[1])) throw new Error("payer signature missing in payment tx");
  return { payer: entry[0], signature: bs58.encode(entry[1]) };
}

/** Pure: how much USDC a jsonParsed getTransaction result moved out of payer and into payTo. */
export function checkSolanaTransfer(tx: any, w: { payer: string; payTo: string; amount: bigint }): TransferCheck {
  if (!tx) return { ok: false, reason: "transaction not found", transferred: null, received_by_pay_to: null };
  const delta = (owner: string): bigint => {
    const amt = (list: any[]): bigint =>
      (list ?? []).filter((b) => b.mint === USDC.solana && b.owner === owner).reduce((s, b) => s + BigInt(b.uiTokenAmount?.amount ?? "0"), 0n);
    return amt(tx.meta?.postTokenBalances) - amt(tx.meta?.preTokenBalances);
  };
  if (tx.meta?.err) return { ok: false, reason: `transaction failed: ${JSON.stringify(tx.meta.err)}`, transferred: "0", received_by_pay_to: "0" };
  const transferred = -delta(w.payer);
  const toPayTo = delta(w.payTo);
  const out = { transferred: transferred.toString(), received_by_pay_to: toPayTo.toString() };
  if (transferred !== w.amount) return { ok: false, reason: `payer USDC out ${transferred} != offered ${w.amount}`, ...out };
  if (toPayTo !== w.amount) return { ok: false, reason: `payTo USDC in ${toPayTo} != offered ${w.amount}`, ...out };
  return { ok: true, reason: "USDC transfer payer->payTo matches the 402", ...out };
}

async function getTx(sig: string, s: ChainSearch) {
  return rpc(s.rpcUrl, "getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
}

/** Poll for a known signature (a settled tx can take a few seconds to be visible at `confirmed`). */
export async function getSolanaTx(sig: string, s: ChainSearch): Promise<any | null> {
  const until = Date.now() + s.timeoutMs;
  do {
    const tx = await getTx(sig, s).catch(() => null);
    if (tx) return tx;
    if (Date.now() >= until) break;
    await sleep(s.pollMs);
  } while (Date.now() < until);
  return null;
}

/**
 * Look for a landed tx carrying our own signature among recent transactions that touch
 * the payer. In an x402 exact-SVM tx the tx id is the fee payer's (facilitator's)
 * signature, so our signature is matched against every signature of each candidate.
 */
export async function findSolanaPayment(payer: string, payerSig: string, s: ChainSearch, limit = 20): Promise<{ signature: string; tx: any } | null> {
  const seen = new Set<string>();
  const until = Date.now() + s.timeoutMs;
  do {
    const sigs: any[] = await rpc<any[]>(s.rpcUrl, "getSignaturesForAddress", [payer, { limit, commitment: "confirmed" }]).catch(() => []);
    for (const x of sigs ?? []) {
      if (seen.has(x.signature)) continue;
      seen.add(x.signature);
      const tx = await getTx(x.signature, s).catch(() => null);
      if (tx?.transaction?.signatures?.includes(payerSig)) return { signature: tx.transaction.signatures[0] ?? x.signature, tx };
    }
    if (Date.now() >= until) break;
    await sleep(s.pollMs);
  } while (Date.now() < until);
  return null;
}
