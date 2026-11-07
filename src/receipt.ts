// Delivery Receipts (kato9292929/delivery-receipt): the seller's key document and
// verification of a receipt against the exact body bytes.
import { USER_AGENT } from "./constants.js";
import {
  RECEIPT_HEADER,
  REFETCH_HEADER,
  WELL_KNOWN_PATH,
  type WellKnown,
  parseWellKnown,
  verifyReceipt as verifyReceiptCore,
} from "@x402jp/delivery-receipt-verify";

export { RECEIPT_HEADER, REFETCH_HEADER, WELL_KNOWN_PATH, type WellKnown };

export type WellKnownLookup = { advertised: boolean; wellKnown: WellKnown | null; error: string | null };

/** Fetch `<origin>/.well-known/x402-receipt.json`. advertised = valid document with at least one key. */
export async function fetchReceiptKeys(url: string, timeoutMs = 5000): Promise<WellKnownLookup> {
  let res: Response;
  try {
    res = await fetch(new URL(WELL_KNOWN_PATH, new URL(url).origin), {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    return { advertised: false, wellKnown: null, error: e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e) };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { advertised: false, wellKnown: null, error: `HTTP ${res.status}` };
  }
  try {
    const wk = parseWellKnown(await res.json());
    return { advertised: wk.keys.length > 0, wellKnown: wk, error: null };
  } catch (e: any) {
    return { advertised: false, wellKnown: null, error: `invalid ${WELL_KNOWN_PATH}: ${e?.message ?? e}` };
  }
}

export type ReceiptCheck = { header: string; ok: boolean; reason: string | null };

/** Verify a receipt header against body bytes with a known key document. */
export function checkReceipt(header: string, body: Uint8Array, wellKnown: WellKnown | null, paymentId: string | null): ReceiptCheck {
  if (!wellKnown) return { header, ok: false, reason: `receipt_key_unknown (no usable ${WELL_KNOWN_PATH})` };
  const v = verifyReceiptCore({ header, body, wellKnown, expect: paymentId ? { payment_id: paymentId } : undefined });
  return v.ok ? { header, ok: true, reason: null } : { header, ok: false, reason: v.detail ? `${v.reason}: ${v.detail}` : v.reason };
}

export type VerifyReceiptArgs = {
  /** The paid resource URL (its origin serves the key document). */
  url: string;
  /** Raw X-Delivery-Receipt header value. */
  header: string;
  /** Exact response body bytes. */
  body: Uint8Array;
  /** Expected payment_id: Solana tx signature, Base EIP-3009 nonce. */
  paymentId?: string | null;
};

/** Fetch the seller's key document and verify a receipt. */
export async function verifyReceipt(args: VerifyReceiptArgs): Promise<ReceiptCheck & { key_document: string | null }> {
  const wk = await fetchReceiptKeys(args.url);
  const r = wk.wellKnown
    ? checkReceipt(args.header, args.body, wk.wellKnown, args.paymentId ?? null)
    : { header: args.header, ok: false, reason: `receipt_key_unknown (${WELL_KNOWN_PATH}: ${wk.error})` };
  return { ...r, key_document: wk.wellKnown ? new URL(WELL_KNOWN_PATH, new URL(args.url).origin).toString() : null };
}
