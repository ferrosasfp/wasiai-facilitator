# Auto-Blindaje — WFAC-13 Signature normalization

Registro de errores cometidos durante F3 y su fix. Sirve como pauta para
futuras HUs que toquen `src/methods/eip3009/` o que escriban módulos de
normalización de firmas.

## [2026-04-23 00:44] Wave 0/1 — length check off-by-2 (body vs. full-hex)

- **Error**: `normalizeSignature` rechazaba todas las firmas canónicas con
  "invalid signature length". 10 de 26 tests fallaron.
- **Causa raíz**: el work-item describe el input como "hex de 130 chars
  (64 bytes) o 132 chars (65 bytes)" donde esos números son la longitud
  total del string (incluyendo `0x`). La implementación inicial comparaba
  `body.length` (ya sin `0x`) contra 130/132 en vez de contra 128/130.
  Todas las firmas válidas tienen `body.length === 130` pero fallaban
  porque se requería 132.
- **Fix**: cambiar `body.length !== 128 && body.length !== 130` y ajustar
  los comentarios del contrato para que quede explícito que los valores
  aplican al body sin prefijo.
- **Aplicar en**: cualquier nuevo módulo que parsee hex — documentar
  siempre si la longitud esperada incluye `0x` o no. Preferir medir el
  body después del `slice(2)` para evitar ambigüedad.

## [2026-04-23 00:47] Wave 2 — viem's recoverTypedDataAddress no acepta EIP-2098 compact

- **Error**: el test "expands 64-byte EIP-2098 compact signature"
  fallaba con `INVALID_SIGNATURE: Failed to recover typed data address`.
  Asumíamos (por comentario en W2 del work-item) que `recoverTypedDataAddress`
  aceptaba tanto 64-byte como 65-byte. No es así — viem v2.47.6 exige 65-byte.
- **Causa raíz**: DT-3 del work-item dice "recoverTypedDataAddress usa
  payload.signature tal cual (no necesita r/s/v separados)". Eso es
  cierto SOLO para el formato estándar de 65 bytes. Para 2098 compact
  hace falta pre-expandir.
- **Fix**: en `verify.ts` post pre-validación, reconstruir el hex canónico
  de 65 bytes a partir del `{ r, s, v }` normalizado y pasarlo a
  `recoverTypedDataAddress`. Eso cierra el gap tanto para compact como
  para legacy v=0/1. Es un cambio aditivo — no rompe tests existentes
  porque para firmas canónicas la reconstrucción es idempotente.
- **Aplicar en**: cualquier flow que pase firmas directo a una lib externa
  sin normalizar — asumir que la lib solo acepta el formato canónico y
  canonicalizar siempre antes. Evita sorpresas con wallets edge-case
  (Core, Backpack, Ethers v5 interop).

## [2026-04-23 00:47] Wave 2 — test AC-15 (CD-NEW-15) supersedido por WFAC-13

- **Error**: el test "AC-15 CD-NEW-15 — rejects EIP-2098 yParity form"
  fallaba después del refactor porque `settle.ts` ya no rechaza v=0/1;
  los normaliza a v=27/28.
- **Causa raíz**: el test existente pinababa la conducta previa (rechazo
  de EIP-2098 yParity). WFAC-13 explícitamente reemplaza ese rechazo
  por normalización (AC-3 del work-item).
- **Fix**: reescribir el `describe('AC-15 (WFAC-13) …')` con 3 tests
  que pinchan la nueva conducta: (a) v=0/1 → simulateContract con v=27/28,
  (b) 64-byte compact → simulateContract (ruta completa verify → settle),
  (c) s-malleable high-half → `INVALID_SIGNATURE` + short-circuit
  pre-simulate (mantiene la semántica defensiva pero ahora del lado de
  `normalizeSignature`). No es una regresión — es la evolución documentada.
- **Aplicar en**: cuando una HU reemplaza un guard defensivo por una
  transformación, siempre revisar los tests que pinababan la ruta del
  rechazo anterior y actualizarlos, no borrarlos. El comentario de
  supersedencia debe citar el nuevo AC por número.
