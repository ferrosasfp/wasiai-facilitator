# Auto-Blindaje — WFAC-10 EIP-3009 Settle

## [2026-04-23 13:20] Wave W1 — viem writeContract account type inference

- **Error**: `npm run typecheck` failed after W1 implementation with
  ```
  src/methods/eip3009/settle.ts: error TS2345: ...
  Types of property 'account' are incompatible.
    Type 'undefined' is not assignable to type '`0x${string}` | Account | null'.
  ```
  at `walletClient.writeContract(sim.request)`.

- **Causa raíz**: viem's `simulateContract` infers `sim.request.account` from
  the client's generic `account` parameter. The base `PublicClient` type has
  `account: undefined`, so `sim.request.account` becomes `undefined`. But
  `writeContract` typing requires `account: Account | Address | null`
  (non-undefined) when the WalletClient is the unparametrised base type.
  Result: type mismatch at the boundary between simulate→write even though
  the runtime pattern is canonical viem.

  The Story File §5.2 and CD-9 both specify:
  > "Pasar `sim.request` opaque al writeContract (NO reconstruir args)"

  and the Story File W1 reference code in §6 does NOT pass `account` to
  simulateContract — so following the reference literally produces a TS error.

- **Fix**: Pass `account: walletClient.account` to `simulateContract`. This:
  1. Propagates the account into `sim.request.account` (non-undefined type).
  2. Keeps `sim.request` fully opaque when passed to `writeContract` (CD-9
     respected — NO reconstruction).
  3. Is semantically correct: simulation should run under the same account
     that will sign the eventual transaction.

  This is NOT a deviation from spec intent; it's a type-level fix required
  by viem 2.48.x. Story File §6 W1 template is a reference — CD-9 (opaque
  pass-through) is the invariant that must hold, and it still does.

- **Aplicar en**: any future settle/exec function that uses
  `simulateContract` + `writeContract` across a `PublicClient` + `WalletClient`
  pair (e.g. WFAC-15 Permit2, WFAC-16 ERC-7710). The pattern:
  ```ts
  const sim = await publicClient.simulateContract({
    account: walletClient.account, // <- type-level bridge to writeContract
    address, abi, functionName, args,
  });
  const hash = await walletClient.writeContract(sim.request); // opaque
  ```
  Document the `account` line with a comment citing this Auto-Blindaje.

## [2026-04-23 16:45] Fix-pack F3.1 — EIP-2098 yParity parity must match original v

- **Error**: First draft of the MNR-1 test (AC-15 CD-NEW-15 branch) tampered the
  last byte of the signature unconditionally to `0x01`. When the canonical
  fixture happened to sign with `v=0x1b` (parity=0), tampering to `0x01`
  (yParity=1) produced a signature that was still parseable BUT recovered a
  DIFFERENT address, so verify.ts step 8 rejected with
  `'Recovered address does not match sender'` instead of reaching settle's
  `parseSignature` guard. Test failed intermittently depending on the fixture's
  original v byte.

- **Causa raíz**: viem's `recoverTypedDataAddress` accepts both v-form (27/28)
  and yParity-form (0/1) signatures and treats them as equivalent only when the
  parity matches. Tampering only the value (27→1 or 28→0) inverts the parity,
  which produces a cryptographically-valid-but-different signer. To keep the
  signature valid under yParity form we must preserve the parity:
  `0x1b (v=27, odd) → 0x01 (yParity=1)` is WRONG; the correct mapping is
  `0x1b → 0x00 (yParity=0)` and `0x1c → 0x01 (yParity=1)`.

- **Fix**: Read the original last byte and tamper conditionally:
  ```ts
  const originalV = sigBytes[64];               // 0x1b or 0x1c
  sigBytes[64] = originalV === 0x1c ? 0x01 : 0x00;
  ```
  This preserves ECDSA parity → `recoverTypedDataAddress` yields the same signer
  → verify passes (AC-9) → settle's parseSignature returns `{ v: undefined }`
  (EIP-2098 compact form) → CD-NEW-15 guard fires → `INVALID_SIGNATURE`.

- **Aplicar en**: any test that crafts EIP-2098-form signatures for negative
  testing. The rule: yParity MUST match the canonical v's parity
  (v=27 ↔ yParity=0, v=28 ↔ yParity=1). Do NOT assume a fixed canonical v;
  ECDSA signatures are deterministic per RFC 6979 but the v byte depends on the
  (privateKey, message, domain) tuple — a message tweak can flip parity.
