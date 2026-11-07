// safeBuy / checkSeller: buy one call from an x402 seller, stage by stage, stopping
// before any money moves when something looks wrong.
import { createHash } from "node:crypto";
import type { x402Client } from "@x402/core/client";
import { checkBaseTransfer, findBasePayment, getBaseReceipt } from "./chains/base.js";
import type { ChainSearch, TransferCheck } from "./chains/rpc.js";
import { checkSolanaTransfer, findSolanaPayment, getSolanaTx } from "./chains/solana.js";
import {
  type Chain,
  type ChainChoice,
  DEFAULT_FIND_TIMEOUT_MS,
  DEFAULT_PROBE_URL,
  DEFAULT_RPC,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
} from "./constants.js";
import { type Payer, type PayerKey, type Signer, makePayer, payerFromClient, refuseReason, settleFrom, signFor } from "./pay.js";
import { type Price, atomicToUsd, usdToAtomic } from "./price.js";
import { BAD_LAST_PAID, type ProbeDoc, hostOf, lookupProbe } from "./probe.js";
import { RECEIPT_HEADER, type ReceiptCheck, checkReceipt, fetchReceiptKeys } from "./receipt.js";
import { buildReport, sendReport } from "./report.js";
import { encodeReceipt, refetch as refetchCore } from "@x402jp/delivery-receipt-verify";
import { type Accept, type InputRequirement, type Parsed402, inputRequirement, parse402, selectAccept, x402Error } from "./x402.js";

export type StageName = "probe" | "402" | "price" | "pay" | "reconcile" | "refetch" | "receipt" | "report";
export type Stage = { name: StageName; ok: boolean; detail: string };

/** Request input for endpoints that need more than a bare GET. */
export type BuyInput = {
  /** Defaults to GET, or POST when `body` is given. */
  method?: string;
  query?: Record<string, string | number | boolean>;
  /** Object/array → JSON; string/Uint8Array → sent as is. */
  body?: unknown;
  headers?: Record<string, string>;
};

/** The accept that would be (or was) paid. */
export type Offer = {
  spec_version: "v1" | "v2" | null;
  scheme: string;
  network: string;
  chain: Chain;
  /** Atomic USDC (6 decimals). */
  amount: string;
  amount_usd: string;
  asset: string;
  pay_to: string;
  resource: string | null;
  max_timeout_seconds: number | null;
};

export type ProbeInfo = { status: "found" | "no_data" | "unavailable"; doc: ProbeDoc | null };

export type CheckOptions = {
  /** Default https://probe.x402jp.com. */
  probeUrl?: string;
  /** Default "any" (Base preferred, then Solana). */
  chain?: ChainChoice;
  /** USD cap, e.g. 0.01 or "$0.01". Optional for checkSeller, required for safeBuy. */
  maxPrice?: Price;
  input?: BuyInput;
  /** Pay even when the 402 price differs from the Probe catalog price. */
  allowCatalogMismatch?: boolean;
  /** Timeout of the unpaid and paid requests to the seller (default 60 s). */
  requestTimeoutMs?: number;
};

/** What onAttempt receives: everything needed to find the payment later. No key material. */
export type AttemptRecord = {
  ts: string;
  url: string;
  host: string;
  network: string;
  chain: Chain;
  amount: string;
  pay_to: string;
  payer_key: PayerKey;
};

export type SafeBuyOptions = CheckOptions & {
  maxPrice: Price;
  /** Keys used only to sign this payment; never stored or logged. */
  signer?: Signer;
  /** Alternatively a prebuilt x402Client with schemes registered. */
  client?: x402Client;
  /** Called after signing and BEFORE the payment is sent (e.g. to persist a ledger row). If it throws, nothing is sent. */
  onAttempt?: (record: AttemptRecord) => void | Promise<void>;
  /** RPC URLs for the chain search (default: env BASE_RPC_URL / SOLANA_RPC_URL, then public endpoints). */
  rpc?: { base?: string; solana?: string };
  /** How long to look on chain for our payment (default 90 s). */
  findTimeoutMs?: number;
  /** Poll interval of the chain search (default 5 s). */
  pollIntervalMs?: number;
  /** Send an anonymized report to the Probe (default false). */
  report?: boolean;
};

export type Outcome =
  | "delivered"
  | "delivered_unsettled"
  | "not_delivered"
  | "overcharged"
  | "amount_mismatch"
  | "rejected"
  | "failed"
  | "refused";

export type CheckResult = {
  ok: boolean;
  stopped_at: StageName | null;
  reason: string | null;
  stages: Stage[];
  host: string;
  probe: ProbeInfo;
  offer: Offer | null;
  input_requirement: InputRequirement | null;
};

export type SafeBuyResult = {
  ok: boolean;
  outcome: Outcome;
  stopped_at: StageName | null;
  reason: string | null;
  status: number | null;
  body: Uint8Array | null;
  body_sha256: string | null;
  content_type: string | null;
  tx: string | null;
  tx_source: "settle_header" | "onchain_search" | null;
  network: string | null;
  amount: string | null;
  /** USDC that actually left the payer in the tx (atomic), when it could be read on chain. */
  transferred: string | null;
  payer_key: PayerKey | null;
  receipt: ReceiptCheck | null;
  refetched: boolean;
  latency_ms: number | null;
  offer: Offer | null;
  probe: ProbeInfo;
  stages: Stage[];
};

type Prepared = CheckResult & { parsed: Parsed402 | null; accept: Accept | null; request: Built };
type Built = { url: string; init: { method: string; headers: Record<string, string>; body?: string | Uint8Array<ArrayBuffer> } };

function buildRequest(url: string, input: BuyInput | undefined): Built {
  const u = new URL(url);
  for (const [k, v] of Object.entries(input?.query ?? {})) u.searchParams.set(k, String(v));
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json, */*", ...(input?.headers ?? {}) };
  let body: string | Uint8Array<ArrayBuffer> | undefined;
  if (input?.body !== undefined) {
    if (typeof input.body === "string") body = input.body;
    else if (input.body instanceof Uint8Array) body = new Uint8Array(input.body);
    else {
      body = JSON.stringify(input.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    }
  }
  const method = (input?.method ?? (body !== undefined ? "POST" : "GET")).toUpperCase();
  return { url: u.toString(), init: { method, headers, ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}) } };
}

const errMsg = (e: any) => (e?.name === "TimeoutError" ? "timeout" : `${e?.message ?? e}`);

/** Stages 1–3. `usable` limits chain "any" to chains the payer can sign for. */
async function prepare(url: string, opts: CheckOptions, usable?: Chain[]): Promise<Prepared> {
  const stages: Stage[] = [];
  let host: string;
  try {
    host = hostOf(url);
  } catch {
    throw new TypeError(`invalid url ${JSON.stringify(url)}`);
  }
  const out: Prepared = {
    ok: false, stopped_at: null, reason: null, stages, host, probe: { status: "unavailable", doc: null },
    offer: null, input_requirement: null, parsed: null, accept: null, request: buildRequest(url, opts.input),
  };
  const stop = (name: StageName, reason: string): Prepared => {
    stages.push({ name, ok: false, detail: reason });
    return Object.assign(out, { ok: false, stopped_at: name, reason });
  };

  // 1. probe
  const lk = await lookupProbe(opts.probeUrl ?? DEFAULT_PROBE_URL, host);
  out.probe = { status: lk.status, doc: lk.status === "found" ? lk.doc : null };
  const doc = lk.status === "found" ? lk.doc : null;
  if (doc) {
    const lp = doc.last_paid;
    if (lp?.outcome && BAD_LAST_PAID.includes(lp.outcome)) {
      return stop("probe", `probe: last paid purchase (${lp.date ?? lp.ts?.slice(0, 10) ?? "date unknown"}) was ${lp.outcome}`);
    }
    if (doc.buyable_without_input === false && !opts.input) {
      return stop("probe", `probe: not buyable without input${doc.requires_input_reason?.reason ? ` (${doc.requires_input_reason.reason})` : ""}; pass input`);
    }
    stages.push({
      name: "probe",
      ok: true,
      detail: `score ${doc.score ?? "n/a"}, last paid ${lp?.outcome ?? "none"}${lp?.date ? ` (${lp.date})` : ""}, buyable_without_input ${doc.buyable_without_input ?? "n/a"}`,
    });
  } else {
    stages.push({ name: "probe", ok: true, detail: lk.status === "no_data" ? "no data" : `unavailable (${(lk as any).error})` });
  }

  // 2. 402
  let res: Response;
  let text: string;
  try {
    res = await fetch(out.request.url, { ...out.request.init, signal: AbortSignal.timeout(opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS), redirect: "follow" });
    text = await res.text();
  } catch (e) {
    return stop("402", `unreachable: ${errMsg(e)}`);
  }
  if (res.status !== 402) return stop("402", `expected 402, got HTTP ${res.status}`);
  const parsed = parse402((n) => res.headers.get(n), text);
  out.parsed = parsed;
  if (parsed.error && !parsed.accepts.length) return stop("402", `unreadable 402: ${parsed.error}`);
  const need = inputRequirement(parsed);
  out.input_requirement = need;
  if (need.requires && !opts.input) return stop("402", `requires_input: ${need.reason} (from ${need.source}); pass input`);
  const chain = opts.chain ?? "any";
  const a = selectAccept(parsed, chain, usable);
  const refuse = refuseReason(a);
  if (refuse || !a) {
    const offered = parsed.accepts.map((x) => `${x.scheme}/${x.network}/${x.asset}`).join(", ") || "none";
    return stop("402", `${refuse} (chain ${chain}${usable ? `, signable: ${usable.join("/")}` : ""}; offered: ${offered})`);
  }
  out.accept = a;
  out.offer = {
    spec_version: parsed.spec_version, scheme: a.scheme!, network: a.network!, chain: a.chain!, amount: a.amount!,
    amount_usd: atomicToUsd(a.amount!), asset: a.asset!, pay_to: a.payTo!, resource: a.resource ?? null, max_timeout_seconds: a.maxTimeoutSeconds ?? null,
  };
  stages.push({ name: "402", ok: true, detail: `${parsed.spec_version} ${a.scheme} ${a.network} ${out.offer.amount_usd} USDC to ${a.payTo}${need.requires ? ` (input given for: ${need.reason})` : ""}` });

  // 3. price
  const amount = BigInt(a.amount!);
  const notes: string[] = [];
  if (opts.maxPrice !== undefined) {
    const max = usdToAtomic(opts.maxPrice);
    if (amount > max) return stop("price", `price ${atomicToUsd(amount)} > maxPrice ${atomicToUsd(max)}`);
    notes.push(`${atomicToUsd(amount)} <= maxPrice ${atomicToUsd(max)}`);
  } else notes.push(`${atomicToUsd(amount)} (no maxPrice given)`);
  const cat = doc?.catalog;
  if (cat?.url && sameUrl(cat.url, url) && typeof cat.price_usd === "number") {
    const catAtomic = usdToAtomic(cat.price_usd);
    if (catAtomic !== amount) {
      const reason = `price_mismatch (catalog ${atomicToUsd(catAtomic)}, 402 ${atomicToUsd(amount)})`;
      if (!opts.allowCatalogMismatch) return stop("price", reason);
      notes.push(`${reason}, allowed by allowCatalogMismatch`);
    } else notes.push("matches catalog");
  }
  stages.push({ name: "price", ok: true, detail: notes.join("; ") });
  out.ok = true;
  return out;
}

const sameUrl = (a: string, b: string) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "") && x.search === y.search;
  } catch {
    return a === b;
  }
};

const publicCheck = ({ parsed: _p, accept: _a, request: _r, ...c }: Prepared): CheckResult => c;

/** Stages 1–3 only: Probe record, the 402 offer and the price checks. Nothing is signed or paid. */
export async function checkSeller(url: string, opts: CheckOptions = {}): Promise<CheckResult> {
  return publicCheck(await prepare(url, opts));
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Buy one call from an x402 seller. See README for the stages. */
export async function safeBuy(url: string, opts: SafeBuyOptions): Promise<SafeBuyResult> {
  if (opts?.maxPrice === undefined || opts.maxPrice === null) throw new TypeError("safeBuy: opts.maxPrice is required (USD, e.g. 0.01 or \"$0.01\")");
  const maxAtomic = usdToAtomic(opts.maxPrice);
  const rpcUrls: Record<Chain, string> = {
    base: opts.rpc?.base || process.env.BASE_RPC_URL || DEFAULT_RPC.base,
    solana: opts.rpc?.solana || process.env.SOLANA_RPC_URL || DEFAULT_RPC.solana,
  };

  const base = (p: Partial<SafeBuyResult> & Pick<SafeBuyResult, "stages" | "probe">): SafeBuyResult => ({
    ok: false, outcome: "refused", stopped_at: null, reason: null, status: null, body: null, body_sha256: null, content_type: null,
    tx: null, tx_source: null, network: null, amount: null, transferred: null, payer_key: null, receipt: null, refetched: false,
    latency_ms: null, offer: null, ...p,
  });

  // The payer is built first so chain "any" only picks a chain we can sign for.
  let payer: Payer;
  try {
    payer = opts.client ? payerFromClient(opts.client) : await makePayer(opts.signer ?? {}, maxAtomic, rpcUrls);
  } catch (e) {
    const reason = `signer: ${errMsg(e)}`;
    return base({ stopped_at: "pay", reason, stages: [{ name: "pay", ok: false, detail: reason }], probe: { status: "unavailable", doc: null } });
  }

  const prep = await prepare(url, opts, payer.chains ?? undefined);
  const { stages } = prep;
  if (!prep.ok || !prep.accept || !prep.offer || !prep.parsed) {
    return base({ stopped_at: prep.stopped_at, reason: prep.reason, stages, probe: prep.probe, offer: prep.offer });
  }
  const a = prep.accept;
  const offer = prep.offer;
  const amount = BigInt(offer.amount);
  const stopAtPay = (reason: string) => {
    stages.push({ name: "pay", ok: false, detail: reason });
    return base({ stopped_at: "pay", reason, stages, probe: prep.probe, offer, network: offer.network, amount: offer.amount });
  };

  // 4. pay: sign, hand the payer-side identifier to the caller, then send.
  let signed;
  try {
    signed = await signFor(payer, prep.parsed, a);
  } catch (e) {
    return stopAtPay(`could not sign: ${errMsg(e)}`);
  }
  const payer_key = signed.payer_key;
  const record: AttemptRecord = {
    ts: new Date().toISOString(), url: prep.request.url, host: prep.host, network: offer.network, chain: offer.chain,
    amount: offer.amount, pay_to: offer.pay_to, payer_key,
  };
  try {
    await opts.onAttempt?.(record);
  } catch (e) {
    return { ...stopAtPay(`onAttempt failed, payment not sent: ${errMsg(e)}`), payer_key };
  }
  stages.push({
    name: "pay",
    ok: true,
    detail: `signed ${offer.amount_usd} on ${offer.network} as ${payer_key.payer}${signed.eip712_filled ? " (EIP-712 domain filled: USD Coin / 2)" : ""}`,
  });

  // 5. reconcile: paid request, settlement header, then the chain.
  const headers = { ...prep.request.init.headers, ...signed.headers };
  let status = 0;
  let body: Uint8Array = new Uint8Array(0);
  let contentType: string | null = null;
  let getHeader: (n: string) => string | null = () => null;
  let requestError: string | null = null;
  const tReq = Date.now();
  try {
    const r = await fetch(prep.request.url, { ...prep.request.init, headers, signal: AbortSignal.timeout(opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS), redirect: "follow" });
    status = r.status;
    body = new Uint8Array(await r.arrayBuffer());
    contentType = r.headers.get("content-type");
    getHeader = (n) => r.headers.get(n);
  } catch (e) {
    requestError = errMsg(e);
  }
  const latency_ms = Date.now() - tReq;
  const settle = settleFrom(payer.http, getHeader);
  const search: ChainSearch = { rpcUrl: rpcUrls[offer.chain], timeoutMs: opts.findTimeoutMs ?? DEFAULT_FIND_TIMEOUT_MS, pollMs: opts.pollIntervalMs ?? 5000 };
  const want = { payer: payer_key.payer, payTo: offer.pay_to, amount };

  let tx: string | null = null;
  let tx_source: SafeBuyResult["tx_source"] = null;
  let check: TransferCheck | null = null;
  if (settle?.transaction) {
    tx = settle.transaction;
    tx_source = "settle_header";
    check = offer.chain === "solana"
      ? checkSolanaTransfer(await getSolanaTx(tx, search), want)
      : checkBaseTransfer(await getBaseReceipt(tx, search), want);
  } else {
    // No settlement tx in a header (even on a 200): look for our own payment on chain.
    const found = payer_key.chain === "solana"
      ? await findSolanaPayment(payer_key.payer, payer_key.payer_signature, search).then((f) => f && { tx: f.signature, check: checkSolanaTransfer(f.tx, want) })
      : await findBasePayment(payer_key.payer, payer_key.authorization_nonce, search).then((f) => f && { tx: f.hash, check: checkBaseTransfer(f.receipt, want) });
    if (found) {
      tx = found.tx;
      tx_source = "onchain_search";
      check = found.check;
    }
  }
  const onchain_found = !!check && check.transferred !== null;
  const transferred = check?.transferred ?? null;
  stages.push({
    name: "reconcile",
    ok: !!check?.ok,
    detail: [
      `HTTP ${status || `error (${requestError})`}`,
      settle ? `settlement header ${settle.success ? "success" : `failure${settle.error ? ` (${settle.error})` : ""}`}${settle.transaction ? ` tx ${settle.transaction}` : ""}` : "no settlement header",
      tx ? `tx ${tx} (${tx_source}): ${check?.reason}` : `no payment found on chain within ${search.timeoutMs} ms`,
      transferred !== null ? `transferred ${atomicToUsd(transferred)}` : null,
    ].filter(Boolean).join("; "),
  });

  // Id the seller's receipt carries: Solana = tx signature, Base = authorization nonce.
  const paymentId = payer_key.chain === "base" ? payer_key.authorization_nonce : tx;
  let delivered = status === 200 && body.length > 0;
  let refetched = false;
  let receipt: ReceiptCheck | null = null;

  // 6. refetch: paid but nothing came back, and the seller keeps receipts.
  if (tx && !delivered && paymentId) {
    const wk = await fetchReceiptKeys(prep.request.url);
    if (!wk.advertised || !wk.wellKnown) {
      stages.push({ name: "refetch", ok: false, detail: `seller publishes no receipt keys (${wk.error ?? "no keys"}); not refetched` });
    } else {
      const init = prep.request.init;
      const r = await refetchCore({
        url: prep.request.url,
        paymentHeaders: signed.headers,
        paymentId,
        wellKnown: wk.wellKnown,
        headers: init.headers,
        // Re-send with the original method and body (the vendored helper always uses GET).
        fetch: (u, i) => fetch(u, { ...i, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}), signal: AbortSignal.timeout(opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS) }),
      });
      if (r.ok) {
        refetched = true;
        delivered = r.body.length > 0;
        status = r.status;
        body = r.body;
        // The helper returns the verified receipt; it is re-encoded (canonical JSON) as the header value.
        receipt = { header: encodeReceipt(r.receipt), ok: true, reason: null };
        stages.push({ name: "refetch", ok: true, detail: `refetched with ${paymentId}: HTTP 200, ${r.body.length} bytes, receipt verified (key ${r.receipt.key_id})` });
      } else {
        stages.push({ name: "refetch", ok: false, detail: `refetch failed: ${r.reason}${r.status ? ` (HTTP ${r.status})` : ""}${r.detail ? `: ${r.detail}` : ""}` });
      }
    }
  }

  // 7. receipt on a first-delivery 200
  if (!refetched && status === 200) {
    const h = getHeader(RECEIPT_HEADER);
    if (h) {
      const wk = await fetchReceiptKeys(prep.request.url);
      receipt = checkReceipt(h, body, wk.wellKnown, paymentId);
      stages.push({ name: "receipt", ok: receipt.ok, detail: receipt.ok ? "X-Delivery-Receipt verified" : `X-Delivery-Receipt invalid: ${receipt.reason}` });
    }
  }

  let outcome: Outcome;
  if (tx && transferred !== null && BigInt(transferred) > amount) outcome = "overcharged";
  else if (tx && transferred !== null && check && !check.ok && BigInt(transferred) !== amount) outcome = "amount_mismatch";
  else if (tx) outcome = delivered ? "delivered" : "not_delivered";
  else if (delivered) outcome = "delivered_unsettled";
  else outcome = status === 0 ? "failed" : "rejected";

  const result: SafeBuyResult = base({
    ok: outcome === "delivered" || outcome === "delivered_unsettled",
    outcome,
    reason: outcome === "rejected" ? `HTTP ${status}${x402Reason(status, getHeader, body)}` : outcome === "failed" ? requestError : outcome === "overcharged" || outcome === "amount_mismatch" ? check?.reason ?? null : null,
    status: status || null,
    body,
    body_sha256: sha256(body),
    content_type: contentType,
    tx,
    tx_source,
    network: offer.network,
    amount: offer.amount,
    transferred,
    payer_key,
    receipt,
    refetched,
    latency_ms,
    offer,
    probe: prep.probe,
    stages,
  });

  // 8. report (opt-in, anonymized; never fails the purchase)
  if (opts.report === true) {
    const rep = buildReport({
      host: prep.host, url: prep.request.url, network: offer.network, amount: offer.amount, outcome,
      http_status: status || null, latency_ms, settled_header: !!settle, onchain_found, receipt_ok: receipt ? receipt.ok : null, refetched,
    });
    const s = await sendReport(opts.probeUrl ?? DEFAULT_PROBE_URL, rep);
    stages.push({ name: "report", ok: s.ok, detail: s.ok ? `reported (${s.detail})` : `report failed (${s.detail}); purchase unaffected` });
  }
  return result;
}

function x402Reason(status: number, getHeader: (n: string) => string | null, body: Uint8Array): string {
  if (status !== 402) return "";
  const e = x402Error(parse402(getHeader, Buffer.from(body).toString("utf8")));
  return e ? `: ${e}` : "";
}
