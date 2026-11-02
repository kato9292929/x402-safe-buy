// Chains, official USDC and defaults. Mainnet only: Base and Solana.
import { readFileSync } from "node:fs";

export type Chain = "base" | "solana";
export type ChainChoice = Chain | "any";

/** CAIP-2 ids (x402 v2) and v1 network names that count as each chain's mainnet. */
export const NETWORKS: Record<Chain, { caip2: `${string}:${string}`; v1: string[] }> = {
  base: { caip2: "eip155:8453", v1: ["base", "base-mainnet"] },
  solana: { caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", v1: ["solana", "solana-mainnet"] },
};

/** Official USDC (Circle). Compared case-insensitively on Base. */
export const USDC: Record<Chain, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

/** Order used when the caller asks for chain "any". */
export const CHAIN_PREFERENCE: Chain[] = ["base", "solana"];

export const DEFAULT_PROBE_URL = "https://probe.x402jp.com";
export const DEFAULT_RPC: Record<Chain, string> = {
  base: "https://mainnet.base.org",
  solana: "https://api.mainnet-beta.solana.com",
};
export const PROBE_TIMEOUT_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_FIND_TIMEOUT_MS = 90_000;

export function chainOf(network: string | undefined): Chain | null {
  if (!network) return null;
  const n = network.toLowerCase();
  for (const c of Object.keys(NETWORKS) as Chain[]) {
    if (n === NETWORKS[c].caip2.toLowerCase() || NETWORKS[c].v1.includes(n)) return c;
  }
  return null;
}

/** Package version, read once from package.json (works from both src/ and dist/). */
export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export const SDK_ID = `@x402jp/safe-buy@${VERSION}`;
export const USER_AGENT = `x402jp-safe-buy/${VERSION}`;
