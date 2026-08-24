# orders-api

`GET /api/users/:id/orders` — a user's order history, newest first, keyset-paginated.

**Read [DECISIONS.md](DECISIONS.md) first.** It explains why this looks the way it does.

---

## Setup

Needs Node ≥ 20.12 and Docker. Four commands, about ninety seconds:

```bash
npm ci
docker compose up -d          # Postgres 16 on localhost:5433
cp .env.example .env
npm run db:setup              # schema + 5,000 users + 50,000 orders (~7s)
```

Then:

```bash
npm run dev                   # http://localhost:3000
npm test                      # 59 tests
```

### Swagger UI

`http://localhost:3000/docs` — interactive docs with a "try it out" button. Click **Authorize**,
paste a token from `npm run token -- --user 2` (no `Bearer` prefix needed, the UI adds it), and
requests execute against your running dev server. The raw spec is at `/openapi.json`.

Disabled when `NODE_ENV=production` — an API explorer isn't something to expose next to real data.

### Using your own Postgres instead

Nothing is hard-coded to the container. Set `DATABASE_URL` in `.env` and skip `docker compose`:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/orders_api npm run db:setup
```

`db:setup` creates the database if it does not exist, applies `db/schema.sql`, and seeds. It is
idempotent — re-run it whenever you want a clean dataset.

---

## Trying it

There is no login endpoint (see DECISIONS.md, §4). `npm run token` mints a JWT so you can exercise
the route:

```bash
TOKEN=$(npm run -s token -- --user 2)          # customer, 250 orders
ADMIN=$(npm run -s token -- --user 1 --role admin)

# first page
curl -s -H "Authorization: Bearer $TOKEN" \
  'localhost:3000/api/users/2/orders?limit=3' | jq

# next page: feed pagination.nextCursor back in
curl -s -H "Authorization: Bearer $TOKEN" \
  'localhost:3000/api/users/2/orders?limit=3&cursor=<nextCursor>' | jq
```

Interesting seeded users — all deterministic, the seed uses a fixed-seed PRNG:

| id | who                    | why it exists                                              |
| -- | ---------------------- | ---------------------------------------------------------- |
| 1  | admin, 3 orders        | reads anyone's history                                     |
| 2  | customer, 250 orders   | enough to page through (36 pages at `limit=7`)             |
| 3  | customer, **0 orders** | the `200` + empty array case                               |
| 4  | customer, 8 orders     | all 8 share one `placed_at` **to the microsecond** — the cursor tiebreaker |

Things worth poking at:

```bash
# 403, not 404 — a customer must not learn which user ids exist
curl -si -H "Authorization: Bearer $TOKEN" localhost:3000/api/users/3/orders | head -1

# 404 — but only for someone entitled to know
curl -s  -H "Authorization: Bearer $ADMIN" localhost:3000/api/users/999999/orders

# 200 + [] — a real user who has never ordered
curl -s  -H "Authorization: Bearer $ADMIN" localhost:3000/api/users/3/orders

# 400 with a per-field reason
curl -s  -H "Authorization: Bearer $TOKEN" 'localhost:3000/api/users/2/orders?limit=9999'
```

---

## The contract

### `GET /api/users/:id/orders`

`Authorization: Bearer <jwt>` required. The caller must be user `:id`, or have `role: "admin"`.

| query    | type   | default | notes                                            |
| -------- | ------ | ------- | ------------------------------------------------ |
| `limit`  | int    | `20`    | 1–100. Out of range is a `400`, not a silent clamp. |
| `cursor` | opaque | —       | `pagination.nextCursor` from the previous page.   |

Unknown query parameters are rejected with `400`. `?curser=…` silently ignored is a bug that looks
like a server fault.

```json
{
  "data": [
    {
      "id": "191",
      "status": "shipped",
      "totalCents": 270894,
      "currency": "GBP",
      "placedAt": "2026-08-16T04:40:03.547468Z"
    }
  ],
  "pagination": { "limit": 3, "hasMore": true, "nextCursor": "eyJ2IjoxLCJ0Ijoi…" }
}
```

- `id` is a **string** — it is a Postgres `bigint`, and `Number` silently corrupts values above 2^53.
- `totalCents` is integer minor units. No floats anywhere near money.
- `placedAt` has **microsecond** precision, because Postgres stores microseconds and the cursor
  depends on not truncating them.
- `nextCursor` is `null` on the last page. There is no `total` — see DECISIONS.md §3.

| status | when                                                                 |
| ------ | -------------------------------------------------------------------- |
| `200`  | including a user who exists with no orders (`data: []`)              |
| `400`  | malformed `:id`, `limit` out of range, unknown param, bad cursor     |
| `401`  | missing / malformed / expired / unverifiable token                   |
| `403`  | authenticated, but not this user and not an admin                    |
| `404`  | the user does not exist — *only* for callers entitled to know that   |
| `503`  | database unreachable or the statement timeout fired (`Retry-After`)  |

Errors share one envelope:

```json
{
  "error": { "code": "VALIDATION_FAILED", "message": "…", "issues": [{ "field": "limit", "message": "must not exceed 100" }] },
  "requestId": "b6ed3217-…"
}
```

`code` is the stable part — branch on that, not on the message. `requestId` is echoed in the
`X-Request-Id` response header and tagged on every log line for that request.

### `GET /healthz` · `GET /readyz`

Liveness does **not** touch the database — otherwise one database blip fails every instance's
liveness probe and the orchestrator restarts the whole fleet. Readiness does.

### `GET /docs` · `GET /openapi.json`

Swagger UI and the raw OpenAPI 3.1 document — see [Swagger UI](#swagger-ui) above. Dev/test only.

---

## Verifying the performance claim

```bash
npm run explain     # EXPLAIN ANALYZE for the real queries, plus the OFFSET plan for contrast
npm run bench       # keyset vs OFFSET on one user with 200,000 orders
```

`npm run bench` inserts inside a transaction and rolls back, so it is safe against the seeded
database. On this machine (Postgres 16 in Docker, page size 21):

```
page depth        keyset      OFFSET   rows read by OFFSET
--------------------------------------------------------------
         0           -      0.39ms                    21
       100      0.34ms      0.28ms                   121
    10,000      0.35ms      1.35ms                10,021
   100,000      0.34ms     12.13ms               100,021
   199,979      0.30ms     23.68ms               200,000
```

Keyset is flat. OFFSET is linear in page depth, because it reads and discards every row it skips.

---

## Layout

```
src/
  app.ts                    express wiring, middleware order, health routes
  index.ts                  boot, signals, graceful shutdown
  config/env.ts             zod-validated config; refuses to boot if wrong
  db/pool.ts                pg pool, timeouts, bigint policy
  docs/openapi.ts           hand-written OpenAPI 3.1 doc, served at /docs and /openapi.json
  auth/
    jwt.ts                  verify + validate claims (algorithms pinned)
    authenticate.ts         Bearer -> req.auth                       401
    authorize.ts            self-or-admin, before any DB read        403
  http/
    errors.ts               AppError + stable error codes
    error-handler.ts        the one place that decides what clients see
    request-context.ts      request id, scoped logger, one log line per request
  orders/
    orders.routes.ts        middleware order == the security model
    orders.controller.ts    parse, status, headers. nothing else
    orders.service.ts       limit+1, hasMore, 404-vs-empty
    orders.repository.ts    the only file containing SQL
    orders.schema.ts        zod for :id and query
    cursor.ts               keyset cursor encode/decode/validate
db/
  schema.sql                tables + the index this endpoint lives on
  seed.ts                   deterministic ~5k users / ~50k orders
test/
  orders.route.test.ts      37 integration tests against real Postgres
  orders.service.test.ts    the two decisions the service makes alone
  cursor.test.ts            round-trip + every way a cursor can be wrong
scripts/
  explain.ts                query plans
  bench-pagination.ts       keyset vs OFFSET, measured
  mint-token.ts             dev tokens
```

## Scripts

| command             | does                                                       |
| ------------------- | ---------------------------------------------------------- |
| `npm run dev`       | watch mode                                                 |
| `npm run build`     | `tsc` → `dist/`, `npm start` runs it                       |
| `npm test`          | full suite (needs Postgres; uses a separate `_test` database) |
| `npm run typecheck` | `tsc --noEmit`                                             |
| `npm run lint`      | eslint, type-aware                                         |
| `npm run db:setup`  | create + migrate + seed                                    |
| `npm run explain`   | query plans against the seeded data                        |
| `npm run bench`     | keyset vs OFFSET measurement                               |
| `npm run token`     | mint a dev JWT (token → stdout, hint → stderr)             |

Tests run against `<database>_test`, created automatically — they truncate tables, and they must
never be able to do that to a database holding real data.
