# @x402jp/safe-buy

x402（HTTP 402・USDC）の売り手から、買い手エージェントが **1 回の関数呼び出しで安全に買う** ための SDK と MCP サーバー。

- 払う前に止める: Probe の過去記録、402 の入力要件、上限価格、カタログ価格との不一致
- 払った後に確かめる: 決済ヘッダが無くてもチェーン上で自分の支払いを探し、金額を照合
- 届かなかったら取り直す: Delivery Receipt 対応の売り手には、同じ支払いで再取得（refetch）して受領証を検証

対応: Base（eip155:8453）と Solana mainnet の公式 USDC、`exact` スキームのみ。Node.js 20 以上。

## インストール

```sh
npm install @x402jp/safe-buy
```

## 使い方

```ts
import { safeBuy } from "@x402jp/safe-buy";

const r = await safeBuy("https://seller.example/api/data", {
  maxPrice: "$0.01",                       // 必須。既定値なし
  chain: "base",                           // "base" | "solana" | "any"（既定 any = Base 優先）
  signer: { evmPrivateKey: process.env.SAFE_BUY_EVM_PRIVATE_KEY },
  onAttempt: (rec) => ledger.write(rec),   // 送信「前」に呼ばれる。投げると送信しない
});

if (r.ok) console.log(new TextDecoder().decode(r.body!));
else console.log(r.outcome, r.stopped_at, r.reason);
```

鍵は呼び出し側が渡します（`signer` か、組み立て済みの `client: x402Client`）。SDK は鍵を保存もログ出力もしません。`onAttempt` と結果に入るのは支払いを後から探すための買い手側 ID だけです（Solana: 自分の署名、Base: EIP-3009 の nonce と署名の SHA-256。生の署名は出しません）。

### 段階（`stages` にすべて記録）

| # | stage | 内容 | 止まる条件 |
|---|---|---|---|
| 1 | probe | `GET {probeUrl}/scores/{host}`（5 秒） | 直近の購入が `not_delivered` / `overcharged`、`buyable_without_input === false` で `input` なし。404・タイムアウト・5xx は続行 |
| 2 | 402 | 402 を取得し v2（`PAYMENT-REQUIRED`）/ v1（JSON 本文）を解析、`exact` + 公式 USDC を選ぶ | 402 でない、払える accept がない、必須入力があるのに `input` なし |
| 3 | price | 金額 ≤ `maxPrice`、Probe のカタログ価格と一致 | 上限超え（署名前）、`price_mismatch`（`allowCatalogMismatch` で許可可） |
| 4 | pay | `@x402/core` / `@x402/evm` / `@x402/svm` で署名、`onAttempt` | 署名失敗、`onAttempt` の例外 |
| 5 | reconcile | 有償リクエスト送信、決済ヘッダ読み取り、無ければチェーン検索（既定 90 秒）、送金額照合 | — |
| 6 | refetch | 支払い済みで未着かつ `/.well-known/x402-receipt.json` があれば、元の支払いヘッダ + `X-Payment-Refetch` で再取得 | — |
| 7 | receipt | 200 に `X-Delivery-Receipt` があれば検証 | — |
| 8 | report | `report: true` のときだけ、匿名の結果を `{probeUrl}/reports` に POST | 失敗しても購入には影響しない |

`outcome`: `delivered` / `delivered_unsettled`（届いたが支払いが見つからない）/ `not_delivered` / `overcharged`（提示額より多く引かれた）/ `amount_mismatch` / `rejected`（未払いで拒否）/ `failed` / `refused`（払う前に止めた）。`ok` は `delivered` と `delivered_unsettled` のとき true。

報告（stage 8）に入るのは host、URL（クエリなし）、network、金額、結果、HTTP ステータス、レイテンシ、各種フラグだけ。支払者アドレス・tx・買い手側 ID・本文は送りません。

### その他の関数

```ts
import { checkSeller, verifyReceipt } from "@x402jp/safe-buy";

await checkSeller(url, { maxPrice: 0.01 });           // stage 1〜3 だけ。払わない
await verifyReceipt({ url, header, body, paymentId }); // well-known を取得して受領証を検証
```

主なオプション: `probeUrl`（既定 https://probe.x402jp.com）、`input: { method, query, body, headers }`、`rpc: { base, solana }`（既定は環境変数 `BASE_RPC_URL` / `SOLANA_RPC_URL`、無ければ公開 RPC）、`findTimeoutMs`、`report`。

## MCP サーバー

```json
{
  "mcpServers": {
    "x402-safe-buy": {
      "command": "npx",
      "args": ["-y", "-p", "@x402jp/safe-buy", "x402-safe-buy-mcp"],
      "env": { "SAFE_BUY_EVM_PRIVATE_KEY": "0x...", "SAFE_BUY_MAX_PRICE_CAP": "0.05" }
    }
  }
}
```

ツール:

- `check_seller { url, chain?, maxPrice?, input? }` — 払わずに確認
- `safe_buy { url, maxPrice, chain?, input?, report? }` — 購入。本文は UTF-8 なら `body_text`（50 KB で切り詰め）、小さなバイナリは `body_base64`
- `verify_receipt { url, receipt, body_base64, payment_id }`

鍵はサーバーの環境変数（`SAFE_BUY_EVM_PRIVATE_KEY` / `SAFE_BUY_SOLANA_SECRET_KEY`）からのみ読み、ツール引数では受け取りません。`safe_buy` の `maxPrice` は `SAFE_BUY_MAX_PRICE_CAP`（既定 $0.10）を超えると拒否します。

## 試す（実際に支払います）

```sh
SAFE_BUY_EVM_PRIVATE_KEY=0x... npx tsx scripts/try.ts https://seller.example/api/data --max 0.01 --chain base
```

本文と鍵は表示しません。`PROBE_EVM_PRIVATE_KEY` / `PROBE_SOLANA_SECRET_KEY` も読みます。

## 開発

```sh
npm install
npm run typecheck
npm test     # すべてオフライン（ローカル HTTP サーバーと RPC モック、使い捨て鍵）
npm run build
```

レシートの検証は npm の `@x402jp/delivery-receipt-verify`（kato9292929/delivery-receipt）を使います。

## ライセンス

MIT
