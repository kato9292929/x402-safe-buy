// Base mainnet: finding and checking an x402 exact-EVM payment (EIP-3009
// transferWithAuthorization). The payer never sends a tx; the facilitator does, so the
// payer-side key is the authorization nonce, consumed on chain by USDC's
// AuthorizationUsed(authorizer, nonce) event. Ported from seller-probe src/chains/base.ts.
import { USDC } from "../constants.js";
import { type ChainSearch, type TransferCheck, rpc, sleep } from "./rpc.js";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const AUTHORIZATION_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

export const topicAddr = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** The EIP-3009 authorization in an exact-EVM payload (Permit2 payloads are not supported). */
export function evmAuthorization(payload: any): { nonce: string; signature: string; from: string; to: string; value: string } {
  const p = payload?.payload;
  if (!p?.authorization?.nonce || !p?.signature) throw new Error("EVM payload is not an EIP-3009 authorization");
  return { nonce: p.authorization.nonce, signature: p.signature, from: p.authorization.from, to: p.authorization.to, value: String(p.authorization.value) };
}

/** Pure: how much USDC this receipt moved from payer (in total) and to payTo, vs the offered amount. */
export function checkBaseTransfer(receipt: any, w: { payer: string; payTo: string; amount: bigint }): TransferCheck {
  if (!receipt) return { ok: false, reason: "receipt not found", transferred: null, received_by_pay_to: null };
  if (receipt.status !== "0x1") return { ok: false, reason: "transaction reverted", transferred: "0", received_by_pay_to: "0" };
  const usdcTransfers = (receipt.logs ?? []).filter(
    (l: any) => l.address?.toLowerCase() === USDC.base.toLowerCase() && l.topics?.[0] === TRANSFER && l.topics?.[1]?.toLowerCase() === topicAddr(w.payer),
  );
  const sum = (ls: any[]) => ls.reduce((s, l) => s + BigInt(l.data), 0n);
  const transferred = sum(usdcTransfers);
  const toPayTo = sum(usdcTransfers.filter((l: any) => l.topics?.[2]?.toLowerCase() === topicAddr(w.payTo)));
  const out = { transferred: transferred.toString(), received_by_pay_to: toPayTo.toString() };
  if (transferred === 0n) return { ok: false, reason: "no USDC Transfer from payer in receipt", ...out };
  if (transferred !== w.amount) return { ok: false, reason: `USDC transferred ${transferred} != offered ${w.amount}`, ...out };
  if (toPayTo !== w.amount) return { ok: false, reason: `USDC to payTo ${toPayTo} != offered ${w.amount}`, ...out };
  return { ok: true, reason: "USDC transfer payer->payTo matches the 402", ...out };
}

/** Poll for a known tx hash's receipt (it can take a moment to be visible). */
export async function getBaseReceipt(txHash: string, s: ChainSearch): Promise<any | null> {
  const until = Date.now() + s.timeoutMs;
  do {
    const r = await rpc(s.rpcUrl, "eth_getTransactionReceipt", [txHash]).catch(() => null);
    if (r) return r;
    if (Date.now() >= until) break;
    await sleep(s.pollMs);
  } while (Date.now() < until);
  return null;
}

/** The tx that consumed our authorization nonce (searched in the last ~hour of blocks), if any. */
export async function findBasePayment(payer: string, nonce: string, s: ChainSearch): Promise<{ hash: string; receipt: any } | null> {
  const until = Date.now() + s.timeoutMs;
  do {
    const latestHex = await rpc<string>(s.rpcUrl, "eth_blockNumber", []).catch(() => null);
    if (latestHex) {
      const latest = parseInt(latestHex, 16);
      const from = Math.max(0, latest - 1800);
      const logs: any[] = await rpc<any[]>(s.rpcUrl, "eth_getLogs", [
        { address: USDC.base, fromBlock: "0x" + from.toString(16), toBlock: "0x" + latest.toString(16), topics: [AUTHORIZATION_USED, topicAddr(payer), nonce.toLowerCase()] },
      ]).catch(() => []);
      if (logs?.length) {
        const hash = logs[0].transactionHash;
        return { hash, receipt: await getBaseReceipt(hash, s) };
      }
    }
    if (Date.now() >= until) break;
    await sleep(s.pollMs);
  } while (Date.now() < until);
  return null;
}
