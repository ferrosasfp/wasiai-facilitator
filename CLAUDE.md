# WasiAI Facilitator — CLAUDE.md

Self-hosted x402-compliant facilitator para EVM chains. Producto standalone del ecosistema WasiAI.

## ⚠️ ESTE ES UN PROYECTO NUEVO — NO CONFUNDIR CON wasiai-v2 NI wasiai-a2a

| Proyecto | Qué es | Repo | Jira |
|----------|--------|------|------|
| **wasiai-facilitator** (este) | x402 facilitator (verify + settle) | github.com/ferrosasfp/wasiai-facilitator | **WFAC** |
| wasiai-a2a | Protocolo/servicio A2A | github.com/ferrosasfp/wasiai-a2a | WKH |
| wasiai-v2 | Marketplace de agentes | github.com/ferrosasfp/wasiai-v2 | — |

### Relación del ecosistema
- **wasiai-facilitator** es la capa de settlement — verify firmas EIP-3009 + ejecutar transferWithAuthorization on-chain
- **wasiai-a2a** y **wasiai-v2** (y cualquier tercero) consumen facilitator vía HTTP (x402-compliant)
- Facilitator es **público** (cualquier x402 client puede apuntar a nuestra URL)

### Por qué este proyecto existe
Pieverse (el facilitator recomendado por Kite) tuvo un outage crítico de `/v2/verify` (HTTP 500 desde 2026-04-13). Esto nos enseñó que **depender de un facilitator externo no controlado es single point of failure**. Decisión de negocio: operar nuestro propio facilitator spec-compliant, extensible a múltiples chains, production-grade.

---

## Antes de cualquier tarea

Lee siempre:
1. `.nexus/project-context.md` — contexto técnico completo, stack, reglas, patterns
2. `.nexus/product-context.md` — contexto de negocio, personas, flows, revenue
3. `BACKLOG.md` — épicas y prioridades
4. `doc/architecture/X402-CONFORMANCE.md` — qué parte del spec implementamos
5. `doc/architecture/SECURITY.md` — threat model y mitigaciones

---

## Metodología

**wasiai-facilitator es siempre modo QUALITY** (mueve dinero — sin excepciones).

Flujo obligatorio:

```
[Analyst+Architect] F0 Codebase Grounding
[Analyst+Architect] F1 Work Item + ACs EARS
⛔ HU_APPROVED
[Architect+Adversary] F2 SDD + Constraint Directives
⛔ SPEC_APPROVED
[Architect] F2.5 story-HU-X.X.md  ← SIN ESTO NO SE CODEA
[Dev] F3 Anti-Hallucination + Waves
[Adversary] AR → BLOQUEANTE/MENOR/OK
[Adversary+QA] Code Review
[QA] F4 Drift Detection + evidencia archivo:línea
[Docs] DONE → _INDEX.md
git push origin main
```

Gates — texto exacto:
- `HU_APPROVED` — "ok"/"dale"/"go" NO cuentan
- `SPEC_APPROVED` — "implementa"/"empieza" NO cuentan

---

## Golden Path (inmutable)

**Reglas absolutas:**
- **Sin hardcodes** — URLs, addresses, chain IDs, keys, todo desde env vars o chain registry
- **Sin secrets en código** — `OPERATOR_PRIVATE_KEY` y otros vienen SIEMPRE de env
- **TypeScript strict** — sin `any` explícito, sin `as unknown`, sin casts inseguros
- **viem v2 exclusivo** — PROHIBIDO ethers.js
- **x402 spec-compliant** — `/verify` y `/settle` shapes deben coincidir con docs.x402.org exactamente
- **Simulate antes de settle** — todas las txs hacen `simulateContract` antes de `writeContract` (security crítica)
- **Duplicate settlement cache 120s** — spec-literal, Redis-backed
- **Chain-adaptive** — agregar nueva chain NUNCA toca `src/core/`, solo `src/chains/`
- **Method-adaptive** — EIP-3009, Permit2, ERC-7710 son plug-ins en `src/methods/`
- **Logs estructurados JSON** (Pino) — prohibido `console.log` salvo en scripts
- **Tests obligatorios** — cada endpoint ≥1 test; cada method adapter ≥1 test de conformance
- **Security scanning en CI** — Snyk + Dependabot + eslint-plugin-security
- **Push siempre:** `git push origin main` (después de PR merge)

**Puerto por defecto:** 3002 (evitar conflicto con 3000=Next.js, 3001=wasiai-a2a).

---

## ⚠️ REGLAS DE ORQUESTACIÓN — CRÍTICO

**Vos sos el ORQUESTADOR. NO hacés trabajo real.**

- ❌ NO escribís SDDs vos mismo → lanzá `nexus-architect`
- ❌ NO implementás código vos mismo → lanzá `nexus-dev`
- ❌ NO revisás vos mismo → lanzá `nexus-adversary`
- ❌ NO validás ACs vos mismo → lanzá `nexus-qa`
- ❌ NO escribís el report final → lanzá `nexus-docs`

Si te encontrás haciendo `Edit`/`Write` sobre `src/`, escribiendo análisis profundos en sesión principal, o decidiendo veredictos AR/CR/QA → **STOP**. Es error de proceso. Lanzá el sub-agente correcto vía Task tool.

**Tu único trabajo**: lanzar sub-agentes, recibir artefactos en `doc/sdd/NNN-titulo/`, presentar resúmenes al humano en los gates, pasar el artefacto al siguiente sub-agente.

---

## Sub-Agentes Custom (en `.claude/agents/` + `~/.claude/agents/`)

| Agente | Fase | Cuándo usarlo |
|--------|------|---------------|
| `nexus-analyst` | F0, F1 | Bootstrap context + work-item.md desde una HU nueva |
| `nexus-architect` | F2, F2.5, CR | SDD + Story File + revisión arquitectónica |
| `nexus-dev` | F3 | Implementación wave por wave desde Story File |
| `nexus-adversary` | AR, CR | Adversarial Review (ataque) + Code Review (calidad) |
| `nexus-qa` | F4 | Validación de ACs con evidencia + Quality Gates |
| `nexus-docs` | DONE | Reporte final + _INDEX.md + cierre del pipeline |

Cada agente tiene su bloque `⛔ PROHIBIDO EN ESTA FASE` integrado en su system prompt.

## Slash Commands NexusAgil (en `.claude/commands/` + `~/.claude/commands/`)

| Paso | Comando | Lanza | Cuándo |
|------|---------|-------|--------|
| p1 | `/nexus-p1-f0-f1 WFAC-XX` | `nexus-analyst` | Empezar HU nueva |
| p2 | `/nexus-p2-f2 WFAC-XX` | `nexus-architect` | Después de `HU_APPROVED` |
| p3 | `/nexus-p3-f2-5 WFAC-XX` | `nexus-architect` | Después de `SPEC_APPROVED` |
| p4 | `/nexus-p4-f3 WFAC-XX` | `nexus-dev` | Implementar |
| p5 | `/nexus-p5-ar WFAC-XX` | `nexus-adversary` | Después de F3 |
| p6 | `/nexus-p6-cr WFAC-XX` | `nexus-adversary` | Después de AR APROBADO |
| p7 | `/nexus-p7-f4 WFAC-XX` | `nexus-qa` | Después de CR APROBADO |
| p8 | `/nexus-p8-done WFAC-XX` | `nexus-docs` | Después de F4 APROBADO |

Alternativa: `/nexus-auto WFAC-XX` — pipeline completo con clinical review auto-aprobado.

**Regla**: usá los slash commands en lugar de armar el Task tool a mano.

---

## Reglas de proceso — NexusAgil QUALITY

> Estas reglas son INVIOLABLES. Cualquier violación se documenta en la Retro.

1. **Dev no empieza sin SPEC_APPROVED** — sin excepciones
2. **Story File se genera DESPUÉS de SPEC_APPROVED** — nunca antes
3. **CR siempre cita archivo:línea** — "APPROVED" sin evidencia no es CR
4. **F4 QA cita archivo:línea por cada AC** — sin evidencia el AC no cuenta como PASS
5. **Sub-agentes son OBLIGATORIOS** — el orquestador NUNCA ejecuta ni evalúa roles directamente
6. **Un gate por lanzamiento** — NO incluyas `HU_APPROVED → F2 → SPEC_APPROVED` en el mismo prompt
7. **Entre gates el pipeline corre solo** — F2.5 → F3 → AR → CR → F4 → DONE NO tiene gates humanos
8. **Money-moving changes = AR obligatorio** — cualquier PR que toque `src/core/settle.ts`, `src/methods/*`, `src/chains/*` requiere adversarial review con foco en: no double-charge, no drain de operator wallet, signature validation correcta

---

## Jira

**Proyecto**: `WFAC` (WasiAI Facilitator) en `ferrosasfp.atlassian.net`
- **Issue types**: Tarea, Historia, Error, Epic, Subtarea
- **Ticket naming**: `WFAC-XX` para todas las HUs de este proyecto
- **Cross-project links**: usar `Relates to WKH-XX` cuando haya dependencia con wasiai-a2a

Labels transversales (heredados del ecosistema):
- `blocked-upstream`, `security`, `production`, `hackathon-must-have`
- `chain:kite`, `chain:avalanche` — por chain afectada
- `method:eip3009`, `method:permit2`, `method:erc7710` — por método
