// USD <-> USDC atomic units (6 decimals). Decimal string math only, no floats.

export type Price = number | string;

/**
 * Parse a USD price (`0.01`, `"0.01"`, `"$0.01"`) into USDC atomic units. Digits past the
 * 6th decimal are truncated (a cap never rounds up). Throws on anything else.
 */
export function usdToAtomic(price: Price): bigint {
  let s: string;
  if (typeof price === "number") {
    if (!Number.isFinite(price) || price < 0) throw new Error(`invalid price ${price}`);
    s = price.toFixed(10);
  } else if (typeof price === "string") {
    s = price.trim().replace(/^\$/, "").trim();
  } else {
    throw new Error("price must be a number or a string like \"$0.01\"");
  }
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`invalid price ${JSON.stringify(price)}`);
  const frac = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
  return BigInt(m[1]) * 1_000_000n + BigInt(frac);
}

/** Atomic USDC units -> "$0.01" (trailing zeros trimmed, at least 2 decimals). */
export function atomicToUsd(atomic: bigint | string): string {
  const v = BigInt(atomic);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1_000_000n;
  let frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}$${whole}.${frac}`;
}
