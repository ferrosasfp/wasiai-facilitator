# WasiAI Facilitator — Hackathon Guide

Public x402 facilitator for the WasiAI ecosystem. **Free to use** for hackathon teams building on Kite Testnet + PYUSD.

## TL;DR

```
URL:      https://wasiai-facilitator-production.up.railway.app
Chain:    Kite Testnet (chainId 2368)
Token:    PYUSD — 0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9 (18 decimals)
Protocol: x402 v2 + EIP-3009 TransferWithAuthorization
Status:   ✅ Live, tested end-to-end against Kite Testnet
```

**Who signs what:**
- **Your client wallet** signs the EIP-712 authorization (holds PYUSD, decides how much to pay, to whom).
- **Our operator wallet** signs the on-chain tx (pays gas). You don't need gas — just PYUSD.

## Endpoints

| Method | Path              | Purpose                                              | On-chain |
|--------|-------------------|------------------------------------------------------|:--------:|
| GET    | `/health`         | Liveness + version                                   | No       |
| GET    | `/supported`      | Supported chains + methods                           | No       |
| GET    | `/openapi.json`   | Full OpenAPI 3.1 spec                                | No       |
| POST   | `/verify`         | Validate EIP-3009 signed authorization (read-only)   | No       |
| POST   | `/settle`         | Execute `transferWithAuthorization` on-chain         | **Yes**  |

## Quick start — minimal TypeScript/viem example

Install: `npm i viem`

```ts
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex, parseUnits } from 'viem';

const FACILITATOR = 'https://wasiai-facilitator-production.up.railway.app';
const PYUSD       = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
const CHAIN_ID    = 2368;

// Your wallet (MUST hold PYUSD on Kite Testnet)
const client = privateKeyToAccount(process.env.CLIENT_PK as `0x${string}`);

// What you're paying for
const payTo  = '0xYourMerchantAddress';
const amount = parseUnits('0.001', 18);  // 0.001 PYUSD
const nonce  = keccak256(toHex(Math.random() + '_' + Date.now()));

const validAfter  = 0n;
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);  // valid 5 min

// 1. Sign EIP-3009 authorization
const signature = await client.signTypedData({
  domain: {
    name: 'PYUSD',            // MUST match PYUSD contract
    version: '1',             // MUST match PYUSD contract
    chainId: CHAIN_ID,
    verifyingContract: PYUSD, // the PYUSD token, NOT the facilitator
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from',        type: 'address' },
      { name: 'to',          type: 'address' },
      { name: 'value',       type: 'uint256' },
      { name: 'validAfter',  type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce',       type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: client.address, to: payTo, value: amount,
    validAfter, validBefore, nonce,
  },
});

// 2. Build x402 body
const body = {
  x402Version: 2,
  resource: { url: 'https://your-service.example/pay' },
  accepted: {
    scheme: 'exact',
    network: `eip155:${CHAIN_ID}`,
    amount: amount.toString(),
    asset: PYUSD,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'eip3009' },
  },
  payload: {
    signature,
    authorization: {
      from: client.address, to: payTo,
      value: amount.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  },
};

// 3. Settle (sends tx on-chain; ~4s including receipt)
const res = await fetch(`${FACILITATOR}/settle`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const result = await res.json();

if (result.settled) {
  console.log('TX:', result.transactionHash, 'block:', result.blockNumber);
} else {
  console.error('Error:', result.error);
}
```

## Response shapes

### `POST /verify` — 200 OK

```json
{
  "verified": true,
  "client": "0xRecoveredSignerAddress",
  "amount": "1000000000000000",
  "asset": "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9",
  "network": "eip155:2368",
  "payTo": "0xMerchantAddress",
  "expiresAt": 1777052000
}
```

### `POST /settle` — 200 OK

```json
{
  "settled": true,
  "transactionHash": "0x23d5f7e66a2caf8d78b5e003e97865943e9f1a0c915201aa2b0a6f6cb25a1dbe",
  "blockNumber": 21035291,
  "amount": "1000000000000000",
  "from": "0xPayerAddress",
  "to": "0xMerchantAddress",
  "asset": "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9"
}
```

### Error response (any endpoint)

```json
{
  "error": {
    "code": "INVALID_SIGNATURE",
    "message": "Recovered address does not match sender",
    "http": 401
  }
}
```

## Error codes

| Code                         | HTTP | When                                                |
|------------------------------|:----:|-----------------------------------------------------|
| `INVALID_PAYLOAD`            | 400  | Body shape rejected by Zod validator                |
| `NETWORK_MISMATCH`           | 400  | Unknown chain or malformed `eip155:<id>` string     |
| `INVALID_AMOUNT`             | 400  | Amount = 0 or exceeds 100 PYUSD cap                 |
| `INVALID_RECEIVER`           | 400  | `payTo` malformed                                   |
| `EXPIRED_AUTHORIZATION`      | 400  | `validBefore` in the past or `validAfter` future    |
| `INVALID_SIGNATURE`          | 401  | Recovered signer ≠ `authorization.from`, or high-s  |
| `DELEGATION_INVALID`         | 401  | (Permit2 / ERC-7710 — not in V1)                    |
| `INSUFFICIENT_BALANCE`       | 402  | Signer doesn't hold enough PYUSD                    |
| `PERMIT2_ALLOWANCE_REQUIRED` | 412  | (Permit2 — not in V1)                               |
| `SIMULATION_FAILED`          | 500  | `simulateContract` reverted (wrong domain, etc.)    |
| `TRANSACTION_FAILED`         | 500  | Tx reverted on-chain or receipt timeout             |
| `CHAIN_UNAVAILABLE`          | 503  | Circuit breaker OPEN — retry after `Retry-After`    |
| `RATE_LIMITED`               | 429  | Rate limit or global daily cap reached              |

## Limits

| Limit                       | Default   | Per          |
|-----------------------------|-----------|--------------|
| `/verify` rate              | 60 rpm    | IP           |
| `/settle` rate              | 30 rpm    | IP           |
| `/supported` rate           | 120 rpm   | IP           |
| Amount per `/settle`        | 100 PYUSD | Request      |
| Global daily `/settle`      | 1000      | All IPs/all wallets, UTC day |

Over-limit responses include a `Retry-After` header (seconds).

## Common mistakes ⚠️

1. **Wrong `verifyingContract`** — must be the PYUSD token address (`0x8E04D099...`), NOT the facilitator. The contract itself verifies the signature against its own `DOMAIN_SEPARATOR`.
2. **Wrong `version`** — PYUSD uses `version: "1"`, not `"2"` (some USDC implementations use 2).
3. **Wrong decimals** — PYUSD on Kite Testnet has **18 decimals**, not 6. Check with `formatUnits(balance, 18)`.
4. **`name: "USD Coin"`** — the real contract returns `"PYUSD"`. Using any other name breaks signature recovery.
5. **`nonce` reuse** — EIP-3009 nonces are single-use per signer. Generate a fresh 32-byte nonce per authorization.
6. **`validBefore` too short** — if your signature takes 5 min to reach our facilitator, the auth expires. 300s is safe.
7. **Low balance** — our operator wallet pays gas, but you still need PYUSD to transfer. Request testnet PYUSD from the Kite team.

## CORS + Security headers

- CORS: `origin: true` (reflects caller origin). Usable from any browser frontend.
- HSTS, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

## OpenAPI 3.1 spec

Download the full spec for codegen / Postman import:

```bash
curl https://wasiai-facilitator-production.up.railway.app/openapi.json > wasiai-x402.json
```

## What's NOT supported (yet)

- Kite Mainnet (testnet only in V1)
- Avalanche Fuji (stub — WFAC-52 pending)
- Permit2 / ERC-7710 (future HUs)
- Non-EVM chains (Solana, Aptos, Stellar — roadmapped)
- Tokens other than PYUSD on Kite

If your integration needs one of the above: let me know and I can prioritize.

## Getting PYUSD on Kite Testnet

Ask the Kite hackathon team for a PYUSD faucet drop. You'll also need a bit of native `KITE` for gas (though the facilitator's operator pays on-chain gas for settles, any other chain tx you do needs gas).

## Support / issues

- **Questions / bugs**: [@ferrosasfp](https://github.com/ferrosasfp)
- **Source code**: https://github.com/ferrosasfp/wasiai-facilitator
- **PRs welcome** — this is MIT-licensed infra for the whole hackathon community.

## About WasiAI

We're building an autonomous-agent ecosystem with native stablecoin payments. This facilitator is one piece; the other repos:
- [`wasiai-a2a`](https://github.com/ferrosasfp/wasiai-a2a) — Google A2A protocol implementation
- [`wasiai-v2`](https://github.com/ferrosasfp/wasiai-v2) — Marketplace

Happy building! 🚀
