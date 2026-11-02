// Stage 8 (opt-in): an anonymized purchase report to the Probe. It never contains the
// payer address, the tx, payer-side identifiers, the body or any query string.
import { SDK_ID, USER_AGENT } from "./constants.js";

export type Report = {
  v: 1;
  host: string;
  /** origin + path only (no query, no fragment). */
  url: string;
  network: string | null;
  amount: string | null;
  outcome: string;
  http_status: number | null;
  latency_ms: number | null;
  settled_header: boolean;
  onchain_found: boolean;
  receipt_ok: boolean | null;
  refetched: boolean;
  sdk: string;
  ts: string;
};

export function buildReport(r: Omit<Report, "v" | "sdk" | "url" | "ts"> & { url: string; ts?: Date }): Report {
  const u = new URL(r.url);
  return {
    v: 1,
    host: r.host,
    url: u.origin + u.pathname,
    network: r.network,
    amount: r.amount,
    outcome: r.outcome,
    http_status: r.http_status,
    latency_ms: r.latency_ms,
    settled_header: r.settled_header,
    onchain_found: r.onchain_found,
    receipt_ok: r.receipt_ok,
    refetched: r.refetched,
    sdk: SDK_ID,
    ts: (r.ts ?? new Date()).toISOString(),
  };
}

/** POST the report. Never throws: a failed report never fails the purchase. */
export async function sendReport(probeUrl: string, report: Report, timeoutMs = 5000): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${probeUrl.replace(/\/+$/, "")}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, detail: e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e) };
  }
}
