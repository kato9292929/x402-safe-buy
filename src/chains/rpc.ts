// Minimal JSON-RPC over fetch, with a few retries.
export async function rpc<T = any>(url: string, method: string, params: unknown[], attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const j: any = await r.json();
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result as T;
    } catch (e) {
      last = e;
      if (i < attempts - 1) await sleep(300 * 2 ** i);
    }
  }
  throw last;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where and how long to look on chain. */
export type ChainSearch = { rpcUrl: string; timeoutMs: number; pollMs: number };

/** Outcome of checking one transaction against the offer. Amounts are atomic USDC strings. */
export type TransferCheck = {
  ok: boolean;
  reason: string;
  /** USDC that left the payer in this tx (null when it could not be read). */
  transferred: string | null;
  /** USDC that reached payTo in this tx. */
  received_by_pay_to: string | null;
};
