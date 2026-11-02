// Stage 1: the seller's public record at the x402 Seller Probe (GET {probeUrl}/scores/{host}).
import { PROBE_TIMEOUT_MS, USER_AGENT } from "./constants.js";

/** Fields of the Probe's host document that safe-buy uses (others are ignored). */
export type ProbeDoc = {
  host?: string;
  score?: number | null;
  coverage?: string | null;
  buyable_without_input?: boolean | null;
  requires_input_reason?: { source?: string; reason?: string } | null;
  last_paid?: { date?: string; ts?: string; outcome?: string | null; price_usd?: number | null; network?: string | null } | null;
  catalog?: { url?: string; price_usd?: number | null } | null;
};

export type ProbeLookup =
  | { status: "found"; doc: ProbeDoc }
  | { status: "no_data" }
  | { status: "unavailable"; error: string };

/** Lowercase hostname without a leading "www.". */
export const hostOf = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, "");

export async function lookupProbe(probeUrl: string, host: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeLookup> {
  let res: Response;
  try {
    res = await fetch(`${probeUrl.replace(/\/+$/, "")}/scores/${encodeURIComponent(host)}`, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    return { status: "unavailable", error: e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e) };
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return { status: "no_data" };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { status: "unavailable", error: `HTTP ${res.status}` };
  }
  try {
    const doc = await res.json();
    if (!doc || typeof doc !== "object") return { status: "unavailable", error: "not a JSON object" };
    return { status: "found", doc: pickDoc(doc) };
  } catch {
    return { status: "unavailable", error: "invalid JSON" };
  }
}

function pickDoc(d: any): ProbeDoc {
  return {
    host: d.host,
    score: d.score ?? null,
    coverage: d.coverage ?? null,
    buyable_without_input: typeof d.buyable_without_input === "boolean" ? d.buyable_without_input : null,
    requires_input_reason: d.requires_input_reason ?? null,
    last_paid: d.last_paid ?? null,
    catalog: d.catalog && typeof d.catalog === "object" ? { url: d.catalog.url, price_usd: d.catalog.price_usd ?? null } : null,
  };
}

/** Last-purchase outcomes that make safe-buy refuse to pay. */
export const BAD_LAST_PAID = ["not_delivered", "overcharged"];
