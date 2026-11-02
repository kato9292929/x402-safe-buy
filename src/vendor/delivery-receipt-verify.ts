// Vendored from kato9292929/delivery-receipt packages/verify/src/index.ts (commit 915d02e).
// Do not edit here. To be replaced by the npm package @x402jp/delivery-receipt-verify once it is published.
/**
 * @delivery-receipt/verify
 *
 * Buyer-side verifier for x402 Delivery Receipts.
 *
 * This file is intentionally self-contained: it depends only on `node:crypto`
 * and the global `fetch`, so it can be vendor-copied into another repository
 * as a single file. See docs/spec.md for the protocol.
 */
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RECEIPT_VERSION = 1 as const;
/** Response header carrying the encoded receipt. */
export const RECEIPT_HEADER = "X-Delivery-Receipt";
/** Request header a buyer sets (with the payment_id) to ask for a refetch. */
export const REFETCH_HEADER = "X-Payment-Refetch";
/** Path of the seller's public key document. */
export const WELL_KNOWN_PATH = "/.well-known/x402-receipt.json";
/** Minimum refetch window a seller may advertise (24h). */
export const MIN_REFETCH_WINDOW_S = 86_400;
/** Default refetch window / retention (7 days). */
export const DEFAULT_REFETCH_WINDOW_S = 604_800;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Delivery = "first" | "refetch";

/** Every receipt field except `sig`; this is what gets signed. */
export interface ReceiptPayload {
  v: 1;
  /** Solana: transfer tx signature. EVM: EIP-3009 authorization nonce (0x + 64 hex). */
  payment_id: string;
  /** CAIP-2 network id, e.g. "eip155:8453" or "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp". */
  network: string;
  /** Absolute URL of the paid resource. */
  resource: string;
  /** Lowercase hex sha256 of the exact response body bytes. */
  body_sha256: string;
  /** Body length in bytes. */
  content_length: number;
  /** ISO 8601 UTC timestamp of when this receipt was signed. */
  issued_at: string;
  delivery: Delivery;
  key_id: string;
}

export interface Receipt extends ReceiptPayload {
  /** base64url (no padding) Ed25519 signature over canonicalJson(payload). */
  sig: string;
}

export interface WellKnownKey {
  key_id: string;
  alg: "Ed25519";
  /** base64url (no padding) of the raw 32-byte Ed25519 public key. */
  public_key: string;
  /** ISO 8601. Receipts are valid under this key only if issued_at < revoked_at. */
  revoked_at?: string;
}

export interface WellKnown {
  keys: WellKnownKey[];
  refetch_window_s: number;
  refetch_header: string;
}

export type VerifyFailureReason =
  | "receipt_missing"
  | "receipt_bad_signature"
  | "receipt_hash_mismatch"
  | "receipt_key_unknown";

export type VerifyResult =
  | { ok: true; receipt: Receipt }
  | { ok: false; reason: VerifyFailureReason; detail?: string };

export type RefetchFailureReason = "refetch_expired" | "refetch_refused" | VerifyFailureReason;

export type RefetchResult =
  | { ok: true; body: Uint8Array; receipt: Receipt; status: number }
  | { ok: false; reason: RefetchFailureReason; status?: number; detail?: string };

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface VerifyReceiptInput {
  /** Raw value of the X-Delivery-Receipt header (null when absent). */
  header: string | null | undefined;
  /** Exact response body bytes as received. */
  body: Uint8Array;
  wellKnown: WellKnown;
  /** Optional bindings the caller expects the receipt to carry. */
  expect?: { payment_id?: string; resource?: string };
}

export interface RefetchInput {
  url: string;
  /**
   * The ORIGINAL payment header(s) sent with the first request, e.g.
   * `{ "PAYMENT-SIGNATURE": "<base64>" }` (x402 v2) or `{ "X-PAYMENT": "<base64>" }` (v1).
   */
  paymentHeaders: Record<string, string>;
  paymentId: string;
  /** Seller key document; fetched from `<origin>/.well-known/x402-receipt.json` when omitted. */
  wellKnown?: WellKnown;
  fetch?: FetchLike;
  /** Extra request headers (e.g. Accept). */
  headers?: Record<string, string>;
  /** Additionally require receipt.resource to equal this value. */
  expectResource?: string;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** base64url without padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/** Strict base64url decode (no padding, no '+' or '/'). Throws on invalid input. */
export function base64urlDecode(s: string): Uint8Array {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) throw new Error("invalid base64url");
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/** Lowercase hex sha256. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Canonical JSON: object keys sorted (recursively, by UTF-16 code unit order,
 * which equals alphabetical order for ASCII keys), no whitespace. Array order is
 * preserved; `undefined` object members are omitted as in JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",") + "]";
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

/** The exact bytes that are signed: UTF-8 canonical JSON of every field except `sig`. */
export function receiptSigningBytes(receipt: ReceiptPayload | Receipt): Uint8Array {
  const { sig: _sig, ...payload } = receipt as Receipt;
  return new Uint8Array(Buffer.from(canonicalJson(payload), "utf8"));
}

/** Encode a receipt as the X-Delivery-Receipt header value (base64url of its JSON). */
export function encodeReceipt(receipt: Receipt): string {
  return base64urlEncode(new Uint8Array(Buffer.from(canonicalJson(receipt), "utf8")));
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

/** Decode and shape-check an X-Delivery-Receipt header value. Throws on malformed input. */
export function decodeReceipt(header: string): Receipt {
  const json = Buffer.from(base64urlDecode(header.trim())).toString("utf8");
  const r = JSON.parse(json) as Record<string, unknown>;
  if (typeof r !== "object" || r === null || Array.isArray(r)) throw new Error("receipt: not an object");
  if (r.v !== 1) throw new Error("receipt: unsupported version");
  for (const k of ["payment_id", "network", "resource", "body_sha256", "issued_at", "key_id", "sig"] as const) {
    if (typeof r[k] !== "string" || (r[k] as string).length === 0) throw new Error(`receipt: bad ${k}`);
  }
  if (!HEX64_RE.test(r.body_sha256 as string)) throw new Error("receipt: bad body_sha256");
  if (!Number.isSafeInteger(r.content_length) || (r.content_length as number) < 0) {
    throw new Error("receipt: bad content_length");
  }
  if (!ISO_RE.test(r.issued_at as string) || Number.isNaN(Date.parse(r.issued_at as string))) {
    throw new Error("receipt: bad issued_at");
  }
  if (r.delivery !== "first" && r.delivery !== "refetch") throw new Error("receipt: bad delivery");
  return r as unknown as Receipt;
}

/** Import a base64url raw 32-byte Ed25519 public key. */
export function importEd25519PublicKey(publicKeyB64u: string): KeyObject {
  const raw = base64urlDecode(publicKeyB64u);
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64u }, format: "jwk" });
}

// ---------------------------------------------------------------------------
// Well-known document
// ---------------------------------------------------------------------------

/** Shape-check a parsed well-known document. Throws on malformed input. */
export function parseWellKnown(doc: unknown): WellKnown {
  const d = doc as WellKnown;
  if (!d || typeof d !== "object" || !Array.isArray(d.keys)) throw new Error("well-known: missing keys");
  for (const k of d.keys) {
    if (!k || typeof k.key_id !== "string" || typeof k.public_key !== "string" || k.alg !== "Ed25519") {
      throw new Error("well-known: bad key entry");
    }
    if (k.revoked_at !== undefined && Number.isNaN(Date.parse(k.revoked_at))) {
      throw new Error("well-known: bad revoked_at");
    }
  }
  if (typeof d.refetch_window_s !== "number" || d.refetch_window_s < MIN_REFETCH_WINDOW_S) {
    throw new Error("well-known: refetch_window_s must be >= 86400");
  }
  if (typeof d.refetch_header !== "string") throw new Error("well-known: missing refetch_header");
  return d;
}

/** Fetch and validate `<origin>/.well-known/x402-receipt.json`. */
export async function fetchWellKnown(origin: string, opts: { fetch?: FetchLike } = {}): Promise<WellKnown> {
  const f = opts.fetch ?? (globalThis.fetch as FetchLike);
  const url = new URL(WELL_KNOWN_PATH, origin);
  const res = await f(url, { headers: { accept: "application/json" } });
  if (res.status !== 200) throw new Error(`well-known: HTTP ${res.status}`);
  return parseWellKnown(await res.json());
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a receipt against the exact body bytes and the seller's key document.
 *
 * Check order: presence -> key lookup -> signature -> revocation -> body hash -> expectations.
 * An `expect` mismatch is reported as `receipt_bad_signature` (the receipt does not
 * attest to what the caller asked for) with a `detail`.
 */
export function verifyReceipt(input: VerifyReceiptInput): VerifyResult {
  const { header, body, wellKnown, expect } = input;
  if (header === null || header === undefined || header.trim() === "") {
    return { ok: false, reason: "receipt_missing" };
  }
  let receipt: Receipt;
  try {
    receipt = decodeReceipt(header);
  } catch (e) {
    return { ok: false, reason: "receipt_bad_signature", detail: `malformed: ${(e as Error).message}` };
  }

  const key = wellKnown.keys.find((k) => k.key_id === receipt.key_id);
  if (!key || key.alg !== "Ed25519") return { ok: false, reason: "receipt_key_unknown", detail: "unknown key_id" };
  let pub: KeyObject;
  try {
    pub = importEd25519PublicKey(key.public_key);
  } catch {
    return { ok: false, reason: "receipt_key_unknown", detail: "unusable public key" };
  }

  let sigOk = false;
  try {
    const sig = base64urlDecode(receipt.sig);
    sigOk = sig.length === 64 && cryptoVerify(null, receiptSigningBytes(receipt), pub, sig);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: "receipt_bad_signature" };

  if (key.revoked_at !== undefined && !(Date.parse(receipt.issued_at) < Date.parse(key.revoked_at))) {
    return { ok: false, reason: "receipt_key_unknown", detail: "issued at or after key revocation" };
  }

  if (receipt.content_length !== body.byteLength || sha256Hex(body) !== receipt.body_sha256) {
    return { ok: false, reason: "receipt_hash_mismatch" };
  }

  if (expect?.payment_id !== undefined && !samePaymentId(expect.payment_id, receipt.payment_id)) {
    return { ok: false, reason: "receipt_bad_signature", detail: "payment_id mismatch" };
  }
  if (expect?.resource !== undefined && expect.resource !== receipt.resource) {
    return { ok: false, reason: "receipt_bad_signature", detail: "resource mismatch" };
  }
  return { ok: true, receipt };
}

/** EVM nonces are hex and compared case-insensitively; Solana signatures are case-sensitive base58. */
function samePaymentId(a: string, b: string): boolean {
  if (a.startsWith("0x") && b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

// ---------------------------------------------------------------------------
// Refetch
// ---------------------------------------------------------------------------

/**
 * Re-fetch already-paid content by re-sending the original payment header plus
 * `X-Payment-Refetch: <payment_id>`, then verify the returned receipt.
 *
 * 410 -> refetch_expired; any other non-200 (including 402) -> refetch_refused.
 */
export async function refetch(input: RefetchInput): Promise<RefetchResult> {
  const f = input.fetch ?? (globalThis.fetch as FetchLike);
  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    ...input.paymentHeaders,
    [REFETCH_HEADER]: input.paymentId,
  };
  let res: Response;
  try {
    res = await f(input.url, { method: "GET", headers });
  } catch (e) {
    return { ok: false, reason: "refetch_refused", detail: `network error: ${(e as Error).message}` };
  }
  if (res.status === 410) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, reason: "refetch_expired", status: 410 };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, reason: "refetch_refused", status: res.status };
  }
  const body = new Uint8Array(await res.arrayBuffer());
  const header = res.headers.get(RECEIPT_HEADER);

  let wellKnown = input.wellKnown;
  if (!wellKnown) {
    try {
      wellKnown = await fetchWellKnown(new URL(input.url).origin, { fetch: f });
    } catch (e) {
      return { ok: false, reason: "receipt_key_unknown", status: 200, detail: (e as Error).message };
    }
  }
  const v = verifyReceipt({
    header,
    body,
    wellKnown,
    expect: { payment_id: input.paymentId, resource: input.expectResource },
  });
  if (!v.ok) return { ...v, status: 200 };
  return { ok: true, body, receipt: v.receipt, status: 200 };
}
