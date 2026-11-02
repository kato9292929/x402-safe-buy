// Signing an x402 payment with the official x402 client libraries. Keys are supplied by
// the caller and only handed to the scheme signers; they are never stored or logged here.
// Ported from seller-probe src/pay.ts.
import { createHash } from "node:crypto";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { PAYMENT_IDENTIFIER, appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { ExactSvmSchemeV1 } from "@x402/svm/v1";
import { privateKeyToAccount } from "viem/accounts";
import { evmAuthorization } from "./chains/base.js";
import { payerSignature, solanaSignerFrom } from "./chains/solana.js";
import { type Chain, NETWORKS } from "./constants.js";
import { atomicToUsd } from "./price.js";
import { type Accept, type Parsed402, isOfficialUsdc } from "./x402.js";

export type Signer = { evmPrivateKey?: string; solanaSecretKey?: string };

export type Payer = { http: x402HTTPClient; chains: Chain[] | null };

/**
 * Payer-side identifier of a payment, known before it is sent. Solana: our own signature
 * inside the tx. Base: the EIP-3009 nonce and the SHA-256 of the signature (the raw
 * signature is never exposed: with it anyone could submit the transfer).
 */
export type PayerKey =
  | { chain: "solana"; payer: string; payer_signature: string; payment_identifier?: string }
  | { chain: "base"; payer: string; authorization_nonce: string; authorization_signature_sha256: string; payment_identifier?: string };

/** Build a paying client from caller-supplied keys; the library spend cap is set to maxAtomic. */
export async function makePayer(signer: Signer, maxAtomic: bigint, rpc: Record<Chain, string>): Promise<Payer> {
  const client = x402Client.fromConfig({
    schemes: [],
    // Library-side cap as a second fence; safe-buy's own price check runs first.
    spendControls: { maxAmountPerPayment: atomicToUsd(maxAtomic) },
  });
  const chains: Chain[] = [];
  if (signer.evmPrivateKey) {
    const key = signer.evmPrivateKey.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("evmPrivateKey must be a 0x-prefixed 32-byte hex key");
    const account = privateKeyToAccount(key as `0x${string}`);
    client.register(NETWORKS.base.caip2, new ExactEvmScheme(account, { rpcUrl: rpc.base }));
    for (const n of NETWORKS.base.v1) client.registerV1(n, new ExactEvmSchemeV1(account));
    chains.push("base");
  }
  if (signer.solanaSecretKey) {
    const s = await solanaSignerFrom(signer.solanaSecretKey);
    client.register(NETWORKS.solana.caip2, new ExactSvmScheme(s, { rpcUrl: rpc.solana }));
    for (const n of NETWORKS.solana.v1) client.registerV1(n, new ExactSvmSchemeV1(s, { rpcUrl: rpc.solana }));
    chains.push("solana");
  }
  if (!chains.length) throw new Error("no signer key given (signer.evmPrivateKey / signer.solanaSecretKey)");
  return { http: new x402HTTPClient(client), chains };
}

/** Wrap a caller-built x402Client (its own policies/caps apply in addition to ours). */
export function payerFromClient(client: x402Client): Payer {
  return { http: new x402HTTPClient(client), chains: null };
}

/** Why this accept cannot be paid by safe-buy, or null. Price is checked separately. */
export function refuseReason(a: Accept | undefined): string | null {
  if (!a) return "no exact official-USDC accept on the requested chain";
  if (a.scheme !== "exact") return `scheme ${a.scheme} (only exact)`;
  if (!a.chain) return `network ${a.network}`;
  if (!isOfficialUsdc(a)) return `asset ${a.asset} is not official USDC`;
  if (!a.amount || !/^\d+$/.test(a.amount)) return `bad amount ${a.amount}`;
  if (BigInt(a.amount) <= 0n) return `amount ${a.amount} (nothing to buy)`;
  if (!a.payTo) return "payTo missing";
  if (a.chain === "base" && a.extra?.assetTransferMethod && a.extra.assetTransferMethod !== "eip3009")
    return `asset transfer method ${String(a.extra.assetTransferMethod)} (only EIP-3009)`;
  return null;
}

/** EIP-712 domain of official USDC on Base (name() / version() of 0x8335…2913). */
export const BASE_USDC_EIP712 = { name: "USD Coin", version: "2" } as const;

/** Domain fill for official Base USDC when the 402's `extra` lacks name/version. Never for other assets. */
export function eip712Fill(a: Accept): Record<string, string> | null {
  if (a.chain !== "base" || !isOfficialUsdc(a)) return null;
  const extra = (a.raw as any)?.extra ?? {};
  if (extra.name && extra.version) return null;
  return { name: extra.name || BASE_USDC_EIP712.name, version: extra.version || BASE_USDC_EIP712.version };
}

export type Signed = {
  /** Headers to send with the paid request (PAYMENT-SIGNATURE or X-PAYMENT). Never logged. */
  headers: Record<string, string>;
  payer_key: PayerKey;
  /** The 402 named official Base USDC without EIP-712 name/version; the known values were filled in. */
  eip712_filled: boolean;
};

/** Sign a payment for exactly this accept (the seller's other options are dropped). */
export async function signFor(payer: Payer, parsed: Parsed402, a: Accept): Promise<Signed> {
  const doc = parsed.raw as any;
  const fill = eip712Fill(a);
  const raw = fill ? { ...(a.raw as any), extra: { ...((a.raw as any)?.extra ?? {}), ...fill } } : a.raw;
  const payload: any = await payer.http.createPaymentPayload({ ...doc, accepts: [raw] });
  // x402 `payment-identifier` extension: when the seller declares it, send a fresh id.
  let payment_identifier: string | undefined;
  const pid = doc?.extensions?.[PAYMENT_IDENTIFIER];
  if (pid) {
    const ext = { ...(payload.extensions ?? {}), [PAYMENT_IDENTIFIER]: payload.extensions?.[PAYMENT_IDENTIFIER] ?? pid };
    appendPaymentIdentifierToExtensions(ext);
    payload.extensions = ext;
    payment_identifier = (ext[PAYMENT_IDENTIFIER] as any)?.info?.id ?? undefined;
  }
  let payer_key: PayerKey;
  if (a.chain === "solana") {
    const ps = payerSignature(payload);
    payer_key = { chain: "solana", payer: ps.payer, payer_signature: ps.signature };
  } else {
    const auth = evmAuthorization(payload);
    payer_key = {
      chain: "base",
      payer: auth.from,
      authorization_nonce: auth.nonce,
      authorization_signature_sha256: createHash("sha256").update(auth.signature).digest("hex"),
    };
  }
  if (payment_identifier) payer_key.payment_identifier = payment_identifier;
  return { headers: payer.http.encodePaymentSignatureHeader(payload), payer_key, eip712_filled: !!fill };
}

export type Settlement = { success: boolean; transaction: string | null; network: string | null; error: string | null };

/** The seller's PAYMENT-RESPONSE / X-PAYMENT-RESPONSE header, decoded; null when absent or unreadable. */
export function settleFrom(http: x402HTTPClient, getHeader: (n: string) => string | null): Settlement | null {
  try {
    const s: any = http.getPaymentSettleResponse(getHeader);
    return { success: !!s.success, transaction: s.transaction || null, network: s.network ?? null, error: s.errorReason ?? null };
  } catch {
    return null;
  }
}
