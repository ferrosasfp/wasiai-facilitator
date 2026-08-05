/* eslint-disable security/detect-non-literal-fs-filename -- las rutas salen de
   `import.meta.dirname` + `readdirSync` sobre este mismo repo, nunca de input. Mismo
   criterio (y misma forma) que `no-console.test.ts`, que barre el código fuente. */
/**
 * La documentación decía un header que el servidor NO lee.
 *
 * `README.md` afirmaba, en dos lugares, que la API key del facilitator viaja "sent as
 * the `x-facilitator-key` header". Es falso: `src/middleware/auth.ts` sólo mira
 * `Authorization: Bearer`, y una request que ponga la key en cualquier otro lado se
 * come un 401. El smoke de chaski ya lo decía explícito, así que la doc contradecía a
 * la vez al código y al cliente.
 *
 * Este archivo tiene dos mitades, y hacen cosas distintas a propósito:
 *
 *   1. EL COMPORTAMIENTO. La frase de la doc es falsable con un input concreto, así
 *      que acá está ese input: la misma key válida, mandada en `x-facilitator-key`,
 *      da 401; mandada en `Authorization: Bearer`, pasa. Sin esta mitad, la mitad 2
 *      sólo compara texto contra texto.
 *   2. LA PROSA. Arreglar el README no impide que la frase vuelva. Enunciar la regla
 *      no alcanza — hace falta un paso mecánico, y éste lo es: si `x-facilitator-key`
 *      reaparece en la doc, el test se pone rojo y nombra el archivo.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { EnvConfig } from '../../infra/env.js';
import { requireFacilitatorKey } from '../../middleware/auth.js';

/** El header que la doc inventaba. Literal a propósito: si se importara de algún lado
 *  seguiría al mutante que este test quiere cazar. */
const PHANTOM_HEADER = 'x-facilitator-key';
const API_KEY = 'la-key-de-verdad';

function appWithKey(): FastifyInstance {
  const app = Fastify();
  app.decorate('env', {
    FACILITATOR_API_KEY: API_KEY,
    FACILITATOR_API_KEYS: undefined,
  } as EnvConfig);
  app.post('/settle', { preHandler: requireFacilitatorKey }, async () => ({ ok: true }));
  return app;
}

describe('la API key viaja en Authorization: Bearer, y en ningún otro header', () => {
  it('★ la key correcta en `x-facilitator-key` → 401 (el header de la doc no existe)', async () => {
    const app = appWithKey();
    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json', [PHANTOM_HEADER]: API_KEY },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('★ la MISMA key en `Authorization: Bearer` → pasa (el contraste que da sentido al de arriba)', async () => {
    const app = appWithKey();
    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('la key cruda sin el prefijo `Bearer ` tampoco alcanza', async () => {
    const app = appWithKey();
    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { 'content-type': 'application/json', authorization: API_KEY },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('la doc no puede volver a nombrar el header fantasma', () => {
  /** Raíz del repo desde `src/__tests__/unit/`. */
  const repoRoot = join(import.meta.dirname, '..', '..', '..');

  /** Los markdown de la raíz + los de `doc/`, que son la doc que lee un integrador. */
  function docFiles(): string[] {
    const roots = [repoRoot, join(repoRoot, 'doc')];
    const found: string[] = [];
    for (const dir of roots) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) found.push(join(dir, entry.name));
      }
    }
    return found;
  }

  it('★ ningún .md de la raíz ni de doc/ menciona `x-facilitator-key`', () => {
    const offenders = docFiles().filter((f) => readFileSync(f, 'utf8').includes(PHANTOM_HEADER));
    // El mensaje nombra el archivo: un rojo acá tiene que ser accionable sin investigar.
    expect(offenders).toEqual([]);
  });

  it('el barrido mira archivos de verdad (si no, el assert de arriba pasa por vacío)', () => {
    const files = docFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('README.md'))).toBe(true);
    // Y esos archivos tienen contenido: un README vacío también pasaría el filtro.
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8').length).toBeGreaterThan(0);
  });
});
