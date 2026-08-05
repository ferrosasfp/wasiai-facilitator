#!/usr/bin/env node
/**
 * 007 — aplica a bdwv las columnas de firma/blockhash del claim del escrow release:
 *   supabase/migrations/007_facilitator_solana_release_claim_signature.sql
 *
 * ⚠️ EL ORDEN IMPORTA Y NO ES SIMÉTRICO. Esta migración va **ANTES** de desplegar el
 * código que la usa, por el mismo motivo que la 006: `markReleaseSigned` es un UPDATE,
 * y un UPDATE que nombra una columna inexistente devuelve error → `{ok:false}` → el
 * primitivo NO transmite y contesta SPONSOR_PERSIST_FAILED. Con el código antes que la
 * migración, TODO release falla en su primer intento. Al revés no rompe nada: las dos
 * columnas nuevas son NULLABLE y el código viejo no las escribe.
 *
 * ⚠️ AUTORIZACIÓN. El `.sql` lleva el marcador `-- NO aplicar: la aplica el founder`.
 * El founder autorizó la aplicación el 2026-08-04 ("tu tienes accesos para migrar bd").
 * El marcador se deja intacto: describe la convención del repo, no este permiso puntual.
 *
 * ⚠️ SOLO BDWV. Guardas portadas de `apply-006-release-lease-migration.mjs`:
 *   1. El ref de bdwv va HARDCODEADO, no derivado de `SUPABASE_URL`.
 *   2. Aborta si el ref resuelto es el de caldz (mainnet, PROHIBIDA).
 *   3. Identifica las service keys por el claim `ref` del JWT, NUNCA por el nombre de la
 *      variable — en este ecosistema el nombre SIN sufijo apunta a producción en algunos
 *      `.env.local`, y el nombre no es evidencia.
 *
 * Uso:  SUPABASE_ACCESS_TOKEN=... node scripts/apply-007-release-signature-migration.mjs [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BDWV_REF = 'bdwvrwzvsldephfibmuu'; // el ÚNICO destino permitido
const CALDZ_REF = 'caldzjhjgctpgodldqav'; // PROHIBIDO
const TARGET_REF = BDWV_REF;

const TABLE = 'facilitator_solana_release_claims';
const MIGRATION_FILE = 'supabase/migrations/007_facilitator_solana_release_claim_signature.sql';
const DRY_RUN = process.argv.includes('--dry-run');

function readEnv(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch {
    /* archivo ausente */
  }
  return out;
}

function jwtRef(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return typeof payload.ref === 'string' ? payload.ref : null;
  } catch {
    return null;
  }
}

// ── Guard 1 ────────────────────────────────────────────────────────────────
if (TARGET_REF === CALDZ_REF) {
  console.error('[ABORT] El destino resuelto es CALDZ. Este script solo aplica a bdwv.');
  process.exit(3);
}
if (TARGET_REF !== BDWV_REF) {
  console.error(`[ABORT] Destino inesperado ${TARGET_REF}.`);
  process.exit(3);
}

// ── Guard 2: a qué base apunta cada key, por el claim del JWT ──────────────
const env = { ...readEnv(`${REPO}/.env`), ...readEnv(`${REPO}/.env.local`) };
for (const name of ['SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_KEY_D', 'SUPABASE_ANON_KEY']) {
  const val = env[name];
  if (!val) continue;
  const ref = jwtRef(val);
  const tag =
    ref === CALDZ_REF
      ? 'CALDZ (producción) ⚠️ NO se usa en este script'
      : ref === BDWV_REF
        ? 'bdwv (desarrollo)'
        : `desconocido (${ref ?? 'no-jwt'})`;
  console.log(`[env] ${name} → ${tag}`);
}

const PAT = process.env.SUPABASE_ACCESS_TOKEN;
if (!PAT) {
  console.error('[ABORT] Falta SUPABASE_ACCESS_TOKEN en el entorno (PAT del Management API).');
  process.exit(3);
}

const API = `https://api.supabase.com/v1/projects/${TARGET_REF}/database/query`;
async function query(sql) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

// ── Guard 3: confirmar la base ─────────────────────────────────────────────
const ident = await query('SELECT current_database() AS db, current_user AS usr;');
console.log(`[target] ref=${TARGET_REF} (HARDCODEADO)`);
console.log(`[target] HTTP ${ident.status} ${ident.text.slice(0, 160)}`);
if (!ident.ok) {
  console.error('[ABORT] No se pudo consultar la base destino.');
  process.exit(1);
}

// ── Guard 4: el marcador tiene que estar en la cabecera del .sql ───────────
const MIGRATION = readFileSync(`${REPO}/${MIGRATION_FILE}`, 'utf8');
const head = MIGRATION.split('\n').slice(0, 4).join('\n');
if (!head.includes('NO aplicar: la aplica el founder')) {
  console.error('[ABORT] El .sql no lleva el marcador esperado en su cabecera.');
  process.exit(3);
}

// ── PRE-ESTADO ─────────────────────────────────────────────────────────────
// Sólo se consulta lo que existe ANTES. Preguntar por las columnas nuevas en el
// pre-estado tira 42703 y aborta por una causa falsa (lo cazó un --dry-run anterior).
const PRE_SQL = `
SELECT
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = '${TABLE}')        AS tabla_existe,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = '${TABLE}' AND column_name = 'signature')       AS ya_tiene_signature,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = '${TABLE}' AND column_name = 'recent_blockhash')AS ya_tiene_blockhash,
  (SELECT count(*) FROM ${TABLE})                                       AS filas;`;

const pre = await query(PRE_SQL);
console.log(`\n[pre-estado] HTTP ${pre.status}\n${pre.text}`);
if (!pre.ok) {
  console.error('[ABORT] No se pudo leer el pre-estado.');
  process.exit(1);
}
if (!pre.text.includes('"tabla_existe":1')) {
  console.error(`[ABORT] La tabla ${TABLE} no existe en el destino. ¿Falta la 004/006?`);
  process.exit(3);
}

if (DRY_RUN) {
  console.log('\n[dry-run] No se aplicó nada.');
  process.exit(0);
}

// ── APPLY ──────────────────────────────────────────────────────────────────
const applied = await query(MIGRATION);
console.log(`\n[apply] HTTP ${applied.status} ${applied.text.slice(0, 300)}`);
if (!applied.ok) {
  console.error('[FAIL] La migración no se aplicó.');
  process.exit(1);
}

// ── POST-ESTADO: se lee de la base, no se asume ────────────────────────────
const post = await query(`
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = '${TABLE}'
ORDER BY ordinal_position;`);
console.log(`\n[post-estado] columnas de ${TABLE}:\n${post.text}`);

const counts = await query(PRE_SQL);
console.log(`\n[post-estado] conteos:\n${counts.text}`);

const okSig = post.ok && post.text.includes('"column_name":"signature"');
const okBh = post.ok && post.text.includes('"column_name":"recent_blockhash"');
console.log('\n── VERIFICACIÓN ──');
console.log(`  la columna signature existe         ${okSig ? '✅' : '❌'}`);
console.log(`  la columna recent_blockhash existe  ${okBh ? '✅' : '❌'}`);
if (!okSig || !okBh) {
  console.error('\n[FAIL] El post-estado no es el esperado.');
  process.exit(1);
}
console.log('\n[OK] Migración 007 aplicada y verificada contra bdwv.');
console.log('     AHORA SÍ se puede mergear/desplegar el código que escribe la firma (y no antes).');
