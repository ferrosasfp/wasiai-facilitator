# Auto-Blindaje — WFAC-AUDIT (SDD #020)

### [2026-05-29] Wave 1 — superRefine FACILITATOR_API_KEY rompió env.test.ts prod fixtures
- **Error**: tras agregar `FACILITATOR_API_KEY` al `.superRefine` (required en non-test), 3 tests de `env.test.ts` que construían env de producción fallaron (esperaban éxito sin la nueva key).
- **Causa raíz**: cualquier nueva key required-in-prod via superRefine invalida fixtures de producción "happy path" preexistentes.
- **Fix**: agregar `FACILITATOR_API_KEY: 'test-secret-key'` a los 3 fixtures de prod-success (líneas ~49, ~86, ~161), preservando la assertion de seguridad — patrón idéntico al precedente WFAC-50 (OPERATOR_PRIVATE_KEY/KITE_USDC_ADDRESS).
- **Aplicar en**: cualquier futura key required-in-prod → buscar fixtures de prod-success en `env.test.ts` y completarlos; nunca relajar la assertion.

### [2026-05-29] Wave 2 — supuesto del Story File sobre trustProxy='true' + inject era falso
- **Error**: el Story File (T6) asumía que bajo `trustProxy='true'` y `app.inject`, Fastify resuelve `request.ip` desde el peer loopback (estable) ignorando el XFF rotante → mismo bucket. Probé empíricamente con un harness (`Fastify({trustProxy:true})` + inject) y `request.ip` SÍ refleja el XFF crudo bajo `trustProxy=true` (light-my-request lo honra). Implementar T6 tal cual lo decía el Story habría sido un test que NO demuestra el fix (daría buckets separados, no 429).
- **Causa raíz**: light-my-request marca el peer como confiable; con `trustProxy=true` Fastify confía en CUALQUIER XFF.
- **Fix**: la propiedad de seguridad real de AC-2 es: un atacante que NO es proxy confiable no evade el bucket rotando XFF. Eso corresponde a `TRUST_PROXY='false'` (peer no confiable) → `request.ip` = peer estable → mismo bucket → 429 en la 3ª. T6 usa `TRUST_PROXY:'false'` + XFF rotante + mismo peer. T7 verifica `request.ip` = peer, no el XFF crudo. Desviación documentada del literal del Story File; preserva la intención de AC-2.
- **Aplicar en**: NO confiar en supuestos del Story File sobre comportamiento de infra (Fastify/light-my-request) sin probarlo. El fix de `network.ts` (request.ip único) es independiente del valor de trustProxy.

### [2026-05-29] Wave 2 — tests fuera de Scope IN encodeaban el bypass de XFF
- **Error**: tras invertir `extractClientIp`, fallaron `core/network.test.ts` (T-NET-1/2/3) y `routes.settle.test.ts` (T-AR-1, T-AR-6) que asertaban que el 1er elemento crudo del XFF era el IP usado.
- **Causa raíz**: estos archivos no estaban en el Scope IN explícito, pero codificaban el comportamiento exacto (parseo de XFF crudo) que AC-2 elimina por seguridad. El cambio en `network.ts` (en scope) los invalida.
- **Fix**: re-expresar las assertions (familia R-1) para el nuevo contrato single-source: `extractClientIp` y el audit log registran el `request.ip` resuelto, no el XFF forjado. Tests con `remoteAddress` para fijar el peer y asertar que el XFF crudo ya NO lo sobreescribe. Cambio intencional documentado, no regresión.
- **Aplicar en**: cualquier test que asuma "primer XFF = client IP" debe re-expresarse al nuevo modelo; nunca relajar la propiedad de seguridad.

### [2026-05-29] Wave 3 — target T18 "<100 LOC por adapter" no alcanzable sin perder lógica
- **Error/observación**: tras extraer `BaseEip3009Adapter`, los wrappers quedan kite=~178, avalanche=151, base=178 líneas (con comentarios); incluso sin comentarios kite=117, avalanche=102, base=106. El target T18 del Story File es <100 c/u.
- **Causa raíz**: cada wrapper RETIENE lógica irreducible: 2-3 env-readers (readEnv/readRpcUrl/readUsdcAddress/readEnabledFlag, con switch sobre union por seguridad), constantes de token (USDC_*), el constructor que arma viemChain/token y llama super(), y los exports. Eso por sí solo supera 100 líneas no-comentario.
- **Fix/decisión**: AC-5 DoD real = "lógica compartida UNA sola vez + ~591 tests verdes sin tocar assertions + T16 intacto", todo cumplido (base-adapter.ts = 519 líneas que antes estaban triplicadas ~1590). El <100 es target blando (T18), no CD bloqueante. Se redujeron comentarios donde no costaba claridad; no se sacrificó lógica de env/seguridad por llegar al número.
- **Aplicar en**: cuando un target de LOC choca con lógica necesaria, priorizar la dedup real (DRY de la lógica compleja) y documentar la desviación; no inflar/comprimir artificialmente.

### [2026-05-29] Wave 5 — release del lock en todos los paths via try/finally + audit type CONFLICT
- **Error/decisión**: el Story File lista 3+ paths terminales para liberar el lock (catch del adapter, error de negocio, éxito) pero también el daily-cap (503/429) queda DESPUÉS del lock. Liberar en cada `return` a mano era frágil.
- **Causa raíz**: múltiples returns terminales tras la adquisición del lock.
- **Fix**: envolver TODO el pipeline post-lock (Step 2.5 → Step 5) en una función interna `runSettle()` y `try { return await runSettle() } finally { if (lockAcquired) await releaseInflightSettleLock(...) }`. Cubre TODOS los paths (incluido daily-cap) sin duplicar la liberación. `releaseInflightSettleLock` es swallow-on-error → seguro en finally.
- **Fix 2**: `request.auditMeta.errorCode` (en `src/core/audit.ts`, fuera de Scope IN explícito) tiene un union cerrado; agregar `'CONFLICT'` fue obligatorio (mismo precedente que SERVICE_UNAVAILABLE de WFAC-53). El 409 escribe errorCode='CONFLICT' al audit row.
- **Aplicar en**: cualquier recurso adquirido con N paths de salida → try/finally en vez de liberar por-return. Códigos route-local nuevos → recordar el union de AuditMeta.
