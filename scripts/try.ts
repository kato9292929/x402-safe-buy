// Manual real purchase: npx tsx scripts/try.ts <url> --max 0.01 [--chain base|solana|any] [--report]
// Keys come from env only (SAFE_BUY_EVM_PRIVATE_KEY / SAFE_BUY_SOLANA_SECRET_KEY, or
// PROBE_EVM_PRIVATE_KEY / PROBE_SOLANA_SECRET_KEY). SPENDS REAL USDC. The body and any key
// material are never printed.
import { type ChainChoice, safeBuy } from "../src/index.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = process.argv[2];
const max = arg("--max");
const chain = (arg("--chain") ?? "any") as ChainChoice;
if (!url || url.startsWith("--") || !max) {
  console.error("usage: npx tsx scripts/try.ts <url> --max 0.01 [--chain base|solana|any] [--report]");
  process.exit(2);
}
if (!["base", "solana", "any"].includes(chain)) {
  console.error(`--chain must be base, solana or any (got ${chain})`);
  process.exit(2);
}

const evmPrivateKey = process.env.SAFE_BUY_EVM_PRIVATE_KEY || process.env.PROBE_EVM_PRIVATE_KEY || undefined;
const solanaSecretKey = process.env.SAFE_BUY_SOLANA_SECRET_KEY || process.env.PROBE_SOLANA_SECRET_KEY || undefined;
if (!evmPrivateKey && !solanaSecretKey) {
  console.error("no key in env (SAFE_BUY_EVM_PRIVATE_KEY / SAFE_BUY_SOLANA_SECRET_KEY or PROBE_*)");
  process.exit(2);
}

const r = await safeBuy(url, {
  maxPrice: max,
  chain,
  signer: { evmPrivateKey, solanaSecretKey },
  probeUrl: process.env.SAFE_BUY_PROBE_URL || undefined,
  report: process.argv.includes("--report"),
  onAttempt: (rec) => console.error(`attempt: ${JSON.stringify(rec)}`),
});
const { body, ...rest } = r;
console.log(JSON.stringify({ ...rest, body_bytes: body?.length ?? 0 }, null, 2));
process.exit(r.ok ? 0 : 1);
