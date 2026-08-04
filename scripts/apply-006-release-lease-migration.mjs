#!/usr/bin/env node
/**
 * 006 — aplica a bdwv el lease del claim del escrow release:
 *   supabase/migrations/006_facilitator_solana_release_claim_lease.sql
 *
 * ⚠️ EL ORDEN IMPORTA Y NO ES SIMÉTRICO. Esta migración va **ANTES** de desplegar el
 * código del lease. Al revés, `markReleaseSigned` erra por columna inexistente en TODOS
 * los releases y el `steal` tampoco puede correr, así que cada escrow queda trabado en su
 * primer intento: exactamente el bug que el arreglo viene a cerrar, disparado antes de
 * tiempo. Lo encontró el AR y por eso este script existe separado del merge.
 *
 * ⚠️ AUTORIZACIÓN. El `.sql` lleva el marcador `-- NO aplicar: la aplica el founder`.
 * El founder autorizó la aplicación el 2026-08-04 ("tu tienes accesos para migrar bd").
 * El marcador se deja intacto: describe la convención del repo, no este permiso puntual.
 *
 * ⚠️ SOLO BDWV. Guardas portadas de `wasiai-a2a/scripts/apply-wkh307-migration.mjs`:
 *   1. El ref de bdwv va HARDCODEADO, no derivado de `SUPABASE_URL`.
 *   2. Aborta si el ref resuelto es el de caldz.
 *   3. Identifica las service keys por el claim `ref` del JWT, NUNCA por el nombre de la
 *      variable — en este ecosistema el nombre SIN sufijo apunta a la base de producción
 *      en algunos `.env.local`, y el nombre no es evidencia.
 *
 * El PAT del Management API se toma de `SUPABASE_ACCESS_TOKEN` del ENTORNO (este repo no
 * lo tiene en su `.env`). Nunca se imprime.
 *
 * Uso:  SUPABASE_ACCESS_TOKEN=... node scripts/apply-006-release-lease-migration.mjs [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BDWV_REF = 'bdwvrwzvsldephfibmuu'; // el ÚNICO destino permitido
const CALDZ_REF = 'caldzjhjgctpgodldqav'; // PROHIBIDO
const TARGET_REF = BDWV_REF;

const TABLE = 'facilitator_solana_release_claims';
const MIGRATION_FILE = 'supabase/migrations/006_facilitator_solana_release_claim_lease.sql';
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
// Sólo se consulta lo que existe ANTES de la migración: preguntar por `status` o
// `claimed_at` en el pre-estado tira 42703 y aborta el script por una causa falsa.
// (Lo cazó el propio --dry-run.)
const PRE_SQL = `
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = '${TABLE}' AND column_name = 'claimed_at') AS has_claimed_at,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = '${TABLE}' AND column_name = 'status')     AS has_status,
  (SELECT count(*) FROM ${TABLE})                                   AS total_claims;`;

const pre = await query(PRE_SQL);
console.log(`\n[pre-estado] HTTP ${pre.status}\n${pre.text}`);

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

const okCol = post.ok && post.text.includes('claimed_at');
console.log('\n── VERIFICACIÓN ──');
console.log(`  la columna claimed_at existe   ${okCol ? '✅' : '❌'}`);
if (!okCol) {
  console.error('\n[FAIL] El post-estado no es el esperado.');
  process.exit(1);
}
console.log('\n[OK] Migración 006 aplicada y verificada contra bdwv.');
console.log('     AHORA SÍ se puede desplegar el código del lease (y no antes).');
