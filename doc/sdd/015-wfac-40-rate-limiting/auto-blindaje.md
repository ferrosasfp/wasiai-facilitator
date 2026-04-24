# Auto-Blindaje — WFAC-40 (Rate Limiting)

## [2026-04-23 Wave 3] errorResponseBuilder returned plain object → Fastify responded 500 instead of 429

- **Error**: Rate-limiting integration tests failed — all over-limit requests
  returned `statusCode: 500` with body `{statusCode:500,error:'Internal Server
  Error',message:...}` instead of the expected `429` with our spec-literal
  `{error:{code:'RATE_LIMITED',...}}` shape.
- **Causa raíz**: `@fastify/rate-limit` `throw`s the object returned by the
  custom `errorResponseBuilder` (see `node_modules/@fastify/rate-limit/index.js:333`).
  Fastify's default error handler sets the HTTP status from `error.statusCode`
  (`node_modules/fastify/lib/error-handler.js:163`). The Story File's skeleton
  returned a plain object `{error:{code,message,http}}` WITHOUT `statusCode`,
  so Fastify defaulted to 500 and treated the thrown value as an unknown error.
- **Fix**: Attach `statusCode: 429` to the returned object as a
  **non-enumerable** property via `Object.defineProperty(body, 'statusCode',
  {value: 429, enumerable: false, ...})`. This way:
  - Fastify reads it when computing the response code (non-enumerability is
    irrelevant to property access).
  - `JSON.stringify` skips it, so the body keeps exactly `{error:{code,
    message,http}}` — CD-3 (3 keys) and CD-10 (explicit body) preserved.
- **Aplicar en**: any future custom `errorResponseBuilder` for a Fastify plugin
  that `throw`s the builder's return value (common pattern in
  @fastify/rate-limit, @fastify/auth, @fastify/jwt). Whenever the body shape
  does NOT naturally include `statusCode`, use the non-enumerable escape
  hatch to separate HTTP-status plumbing from the JSON payload.
