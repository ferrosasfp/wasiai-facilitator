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
