# DECISIONS

`GET /api/users/:id/orders` — Express 5, TypeScript, `node-postgres` with hand-written SQL,
keyset pagination, JWT bearer auth. 59 tests, most of them against a real Postgres.

Setup and the API contract are in [README.md](README.md). This file is the reasoning.

**One thing to know before anything else:** no schema or seed script reached me with the brief, so
[`db/schema.sql`](db/schema.sql) and [`db/seed.ts`](db/seed.ts) are my reconstruction of what was
described (~5,000 users, ~50,000 orders). Everything below is honest about which decisions that
forced. If you hand me the real schema, the blast radius is
[`src/orders/orders.repository.ts`](src/orders/orders.repository.ts) — it is the only file that
contains SQL, and the layers above it deal only in `OrderRow`. That is most of why the seam is
there. I should have asked about the missing files before starting; that was the good question I
didn't ask.

---

## 1. What the requirements did not tell me

Thirteen decisions the four requirements left open. The one I am least confident about is **#1**.

### ⚠️ 1. What "newest first" is sorted *by* — my least confident assumption

There is no such thing as "the order's time" until someone picks a column. I invented two —
`placed_at` (when the customer placed the order) and `created_at` (when the row was written) — and
sort on `placed_at`, on the reasoning that "newest first" is a statement about the order, not about
our insert.

**Why this is the risky one, and not merely uncertain:**

- It fails *silently*. A wrong sort key returns 200 with plausible-looking data in the wrong order.
  No test I can write without knowing the intent will catch it.
- The two columns only diverge in the case that matters: a backfill or a migrated legacy order gets
  a `placed_at` of two years ago and a `created_at` of today. Sorting on `placed_at` buries it deep
  in the customer's history; sorting on `created_at` puts it at the top. Both are defensible and
  they are visibly different to a real user.
- It is expensive to change. The sort key is in the index (`orders (user_id, placed_at DESC, id
  DESC)`), in the `WHERE` row-comparison, and inside every cursor already issued to a client.
  Changing it is a new index, a backfill, and a cursor version bump — not a patched line. The
  version tag in the cursor payload (`{"v":1,…}`) exists precisely so that day is survivable.

If forced to bet without asking: for a *customer-facing* order history, `placed_at` is right — a
customer looks for the order by when they placed it. For an *ops* view, `created_at` is right.
This endpoint serves both audiences through one shape, which is itself a smell worth raising.

### 2. Pagination, and therefore a response envelope

Requirement 1 says "returns the user's orders." Requirement 2 says it must stay responsive as they
grow. Those two cannot both hold unboundedly — a user with a million orders cannot be returned in
one response. So requirement 2 wins, and every response is a page:
`{ data: [...], pagination: { limit, hasMore, nextCursor } }`.

I am flagging this as a deliberate **contract change**, not a detail. If some existing client
expects a bare JSON array, I have broken it. I think a spec that demands responsiveness has already
implicitly asked for this, but it is the assumption most likely to start an argument.

Keyset, not `OFFSET`, and not because keyset is fashionable. Measured, one user, 200,000 orders,
page size 21 ([`npm run bench`](scripts/bench-pagination.ts)):

```
page depth        keyset      OFFSET   rows read by OFFSET
         0           -      0.39ms                    21
       100      0.34ms      0.28ms                   121
    10,000      0.35ms      1.35ms                10,021
   100,000      0.34ms     12.13ms               100,021
   199,979      0.30ms     23.68ms               200,000
```

`OFFSET` is *faster* on page one and 78× slower at depth 200,000, because it reads and throws away
every row it skips. Keyset is flat. The plan says why — the row comparison becomes an **index
condition**, not a filter ([`npm run explain`](scripts/explain.ts)):

```
Limit  (actual time=0.017..0.039 rows=21 loops=1)
  ->  Index Scan using orders_user_placed_at_id_idx on orders o
        Index Cond: ((user_id = '2'::bigint)
                 AND (ROW(placed_at, id) < ROW('2025-02-20 04:15:08.441397+00'::timestamptz, '27'::bigint)))
        Buffers: shared hit=15
```

Keyset also happens to be *correct* in a way `OFFSET` is not: a new order arriving mid-walk shifts
every offset by one and duplicates a row. A cursor names a position in the data, not a count.

### 3. The cursor carries `(placed_at, id)`, not just a timestamp

`placed_at` is not unique. With a timestamp-only cursor, two orders in the same microsecond either
come back twice (`<=`) or one vanishes (`<`). The `id` breaks the tie and the index carries it as a
third column, so the tiebreak is free. Seeded user 4 has eight orders sharing one `placed_at` to
the microsecond specifically so a test can walk them
([`test/orders.route.test.ts`](test/orders.route.test.ts), *"paginates correctly when every order
shares the same placed_at"*).

### 4. The cursor is opaque but **not signed**

It is not a capability. It only narrows a range inside `WHERE user_id = $1`, and that user id comes
from the path, which authorization has already checked. The worst a caller achieves by editing
their own cursor is skipping their own rows. Signing it would add key management and rotation to
buy nothing. It *is* strictly validated, because it becomes a SQL parameter — an unvalidated
`::timestamptz` is a 500 waiting to happen (see §2 of the AI section).

### 5. `404` for a missing user, `200` + `[]` for a user with no orders

Requirement 3 says "handle users who have no orders" and hides a decision. An empty collection is a
successful read, not an error, so a real user with no orders gets `200` and `data: []`. A user id
that does not exist gets `404`, because the parent resource in the path is not there.

The existence check costs a primary-key lookup, so it runs **only when the page came back empty and
there was no cursor** — if any row came back, the user obviously exists
([`orders.service.ts`](src/orders/orders.service.ts)). The common path stays at one query.

### 6. `403` beats `404`, always — authorization runs before any database read

A customer asking about a user id that does not exist gets `403`, identical to asking about one that
does. If it returned `404` there, the endpoint would be an oracle for "which user ids are real."
This is enforced by middleware ordering in
[`orders.routes.ts`](src/orders/orders.routes.ts) — `authenticate` → `requireSelfOrAdmin` →
controller — and there is a test named after the failure it prevents.

### 7. Bearer JWT (HS256), verified here, never issued here

Requirement 4 needs an identity and a role and says nothing about where they come from. This
service is a **resource server**: it verifies `Authorization: Bearer <jwt>` and reads `sub` and
`role`. `algorithms: ['HS256']` is pinned explicitly, because a token that nominates its own
algorithm is the classic RS256→HS256 confusion (and historically `alg: "none"`). Claims are
schema-validated after signature verification — a signature proves origin, not shape, and `role`
arriving as `undefined` would be a security bug rather than a type error.

Symmetric HS256 is the stand-in I am least happy about: it means this service holds a *signing* key,
so anything that can read the config can mint an admin token. In production this is asymmetric —
the IdP signs with a private key, this service holds only the public key via JWKS.

### 8. Two roles, `customer` and `admin`

Exactly what requirement 4 names, as a `CHECK` constraint rather than a Postgres `enum` — adding a
role later is a constraint swap instead of an `ALTER TYPE`. No scopes, no permission tables, no
delegated access. If the answer is really RBAC, this is the wrong shape and I would rather find that
out before building it.

### 9. Ids are `bigint`, and stay **strings** end to end

`users.id` and `orders.id` are `bigint`. `node-postgres` returns them as strings, and this service
keeps them that way — in SQL parameters, in the authorization comparison, in the cursor, and in the
JSON response. A type parser calling `Number()` would be invisible at 50,000 rows and silently
corrupting above 2^53. Leading zeros are *rejected* rather than stripped, because
`requireSelfOrAdmin` compares this string to the token's `sub` and `"013"` must not be a second
spelling of `13`. There is a test asserting `Number("9007199254740993")` ≠ `"9007199254740993"`,
so the reason the code is like this cannot be refactored away by accident.

### 10. Money is `bigint` minor units; `totalCents` is a JSON number

Never a float — `0.1 + 0.2` is not `0.3`, and rounding drift in a total is a support ticket. Ids
stay strings because they are identifiers; money becomes a number because callers do arithmetic on
it and a JS number is exact to 2^53 cents (~$90 trillion), well past the point where this service is
the problem. That asymmetry is deliberate, not an oversight.

### 11. Timestamps are rendered by Postgres at microsecond precision

`placedAt` is `2026-08-16T04:40:03.547468Z` — six fractional digits, produced by `to_char(… AT TIME
ZONE 'UTC', …)` in SQL. It never becomes a JS `Date`, because `Date` has millisecond resolution and
Postgres stores microseconds; truncating it would corrupt the cursor built from the same value. The
explicit `AT TIME ZONE 'UTC'` also makes output independent of the session's `TimeZone`, so a row
serialises identically on every host.

### 12. `limit` 1–100, default 20, out of range is a `400`

The page-size cap is the only real defence against `?limit=1000000`; it bounds response size, sort
work and serialisation in one number. Out of range is rejected rather than clamped: a caller asking
for 1,000 and silently receiving 100 with a `nextCursor` cannot tell that from a page that genuinely
ended.

### 13. Unknown query parameters are rejected

`?curser=eyJ2…` silently ignored means the caller paginates page one forever and the bug looks like
a server fault. The cost is that callers cannot append analytics parameters; for a first-party API
that is the better trade, and it is a one-line change if I am wrong.

**Also assumed, briefly:** the response returns no line items (§4); no `total` count (§3); one page
shape for both customer and admin callers; `Cache-Control: private, no-store` because this is
per-user data behind an `Authorization` header and a cache-key mistake here serves one customer's
history to another.

---

## 2. What I used AI for, and where I overrode it

Claude (Claude Code) wrote most of the lines in this repository. I drove it, reviewed everything,
and the design decisions in §1 are mine — I chose keyset over `OFFSET`, the `403`-before-`404`
ordering, the strings-for-bigint policy, and the two-statement repository, and I asked for the
benchmark because I did not want to assert a latency claim I had not measured.

Seven places it was wrong. The first three are real bugs that shipped into a working state and were
caught afterwards; I am listing them because "AI wrote it and I reviewed it" is worth nothing
without evidence of what review actually caught.

### 2.1 A `400` that was really a `500` — `BigInt()` inside a chained Zod refinement

Generated:

```ts
const userIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,18}$/, 'must be a positive integer without leading zeros')
  .refine((value) => BigInt(value) <= MAX_BIGINT, 'is out of range');
```

That reads correctly and is wrong. **Zod does not stop at the first failed check**, so for
`/api/users/abc/orders` the `.regex` records its issue and the `.refine` still runs —
`BigInt('abc')` throws a `SyntaxError`, which escapes `safeParse`, unwinds past the validation
layer, and lands in the error handler as `500 INTERNAL_ERROR`. A malformed path parameter was
paging someone.

It got through code review twice. What caught it was a boring table-driven test —
`it.each(['abc', '0', '-1', '007', '1.5', '9999999999999999999999'])` — where `0`, `-1` and `007`
passed and `abc` and `1.5` returned 500: exactly the inputs on which `BigInt()` throws.

Fixed by ordering the checks by hand so the second one cannot see input the first rejected:

```ts
const userIdSchema = z.string().superRefine((value, ctx) => {
  if (!USER_ID_PATTERN.test(value)) {
    ctx.addIssue({ code: 'custom', message: 'must be a positive integer without leading zeros' });
    return; // load-bearing: BigInt() must only ever see digits
  }
  if (BigInt(value) > MAX_BIGINT) {
    ctx.addIssue({ code: 'custom', message: 'is out of range for a user id' });
  }
});
```

The general lesson I took: any validator that can *throw* rather than *return false* has to be
guarded by control flow, not by declaration order.

### 2.2 The same bug again, in a sibling field the fix above didn't reach

`orders.id` inside a cursor is a bigint too, and `cursor.ts`'s `payloadSchema` validated it with
only a shape regex — `i: z.string().regex(/^[1-9]\d{0,18}$/)` — no magnitude check. A 19-digit
value like `9999999999999999999` matches that regex (fewer than 19 digits is the only thing it
checks) but exceeds Postgres's actual bigint ceiling of `9223372036854775807`. That value would
pass `decodeCursor`, reach `$3::bigint`, and Postgres would reject it with `numeric_value_out_of_range`
(SQLSTATE `22003`) — a code `error-handler.ts` doesn't translate, so it fell through to a generic
`500` instead of the `400` a bad cursor should produce.

This one wasn't caught by a test; I found it by re-reading `cursor.ts` next to `orders.schema.ts`
when asked directly whether the cursor was "perfect," and noticing the two schemas validate the same
kind of value (a Postgres bigint) with different rigor. The fix pulls `MAX_BIGINT` and the same
shape-then-magnitude `superRefine` pattern from §2.1 into `cursor.ts` and has `orders.schema.ts`
import it, so the two bigint-bounded fields in this codebase can't drift apart again. See
`test/cursor.test.ts`, *"an id past the bigint max,"* for the regression test.

The lesson this one adds: the fix for a bug does not fix the bug's *class* unless it's applied
everywhere the same shape of value appears. I fixed the pattern once and assumed it; I should have
grepped for every other place a bigint crosses a trust boundary.

### 2.3 A statement timeout that silently didn't apply, on the first query of every connection

Generated, and it is the idiom you will find in most blog posts:

```ts
pool.on('connect', (client) => {
  void client.query(`SET statement_timeout = ${env.PG_STATEMENT_TIMEOUT_MS}`);
});
```

Wrong twice. The fire-and-forget `SET` races the caller's first query on the same client, and if it
loses, **the first query on every new connection runs with no timeout at all** — which is precisely
the query you want bounded, since new connections are opened when the pool is growing under load.
The tell was a `pg` deprecation warning in the test output: *"Calling client.query() when the client
is already executing a query."* I could have silenced that warning; it was telling me something
true.

Replaced with a connection parameter, applied in the startup packet, atomically, with no extra
round trip:

```ts
statement_timeout: env.PG_STATEMENT_TIMEOUT_MS,   // Postgres cancels the query
query_timeout: env.PG_STATEMENT_TIMEOUT_MS,       // node-postgres' own clock, covers the network
```

Both, deliberately: a client-side give-up does not stop the server doing the work.

### 2.4 Microsecond truncation in the cursor

The first version returned `placed_at` as a JS `Date` and built the cursor from
`row.placed_at.toISOString()`. `Date` is millisecond-resolution; Postgres `timestamptz` is
microsecond. Every cursor would have been truncated to `.123000Z`, and a truncated boundary either
re-reads or skips every row inside the discarded microsecond — a data-loss bug that appears only
under load, only at page boundaries, and never in a test with second-granularity fixtures.

I moved the rendering into SQL (`to_char(…)`) so the value is never a `Date` at any point, and made
the seed generate real sub-millisecond digits so the tests can actually exercise it. The reasoning
is written down in [`src/orders/cursor.ts`](src/orders/cursor.ts) because it is not visible from
the code.

### 2.5 One clever query instead of two honest ones

Suggested a single statement handling both pages:

```sql
WHERE user_id = $1 AND ($2::timestamptz IS NULL OR (placed_at, id) < ($2, $3))
```

Rejected. A `NULL`-guarded predicate is not a usable index bound, so the planner is free to scan all
of the user's rows and sort them — losing the exact property the endpoint exists to have. Two
literal statements also give Postgres two stable plan-cache entries. The duplication is four lines
and it is the four lines the performance claim rests on.

### 2.6 The cast that would have hidden a real type error

`parseUserIdParam(raw: string | undefined)` failed to compile: Express 5 types `req.params[k]` as
`string | string[] | undefined`, because a route *can* declare the same parameter twice. The
reflex fix is `req.params.id as string`. I widened the signature instead and let an array fail
validation like any other bad input. A function that only accepts the shape it hopes for is a cast
waiting to be written at the call site — and in a function feeding an authorization comparison, that
cast is the one I least want.

### 2.7 Defaults I rejected outright

- **`OFFSET`/`page` pagination** as the first proposal. Replaced with keyset; §1.2 has the numbers.
- **`total` / `totalPages` in the envelope.** A `COUNT(*)` per page is work proportional to the whole
  result set on every request — the exact cost keyset exists to avoid. Omitted; §3 explains.
- **`console.log` and ad-hoc `res.status(500).json({error: e.message})`.** Replaced with a structured
  logger and one error handler that decides what leaves the process (§4).
- Two trivia, for completeness: a `const ms = …` arrow used above its declaration in the benchmark
  script (TDZ crash on first run), and `mint-token` printing its usage hint to stdout, which made
  `npm run token | head -1` die with `EPIPE`. The token now goes to stdout and nothing else does, so
  `TOKEN=$(npm run -s token -- --user 2)` composes.

---

## 3. What breaks first at 100× this data

100× is ~5,000,000 orders and ~500,000 users.

**Not the query.** That is measured, not assumed: 0.30–0.35 ms flat from page 1 to page 9,523 on a
user with 200,000 orders, same plan throughout, ~15 buffer accesses per page. Page cost is a
function of `limit`, not of how much history exists.

### The specific failure: p99 latency goes up 20–50× when the working set stops fitting in RAM

The plan today ends in `Buffers: shared hit=15, read=0` — every page is served from
`shared_buffers`, zero physical reads. Measured per-row storage on the seeded data (after
`VACUUM FULL`, so this is steady state and not bloat), extrapolated to 5M orders:

| relation                        | bytes/row | now (50k orders) | at 100× |
| ------------------------------- | --------: | ---------------: | ------: |
| `orders` heap                   |        96 |         4,736 kB |  458 MB |
| `orders_user_placed_at_id_idx`  |        41 |         2,008 kB |  196 MB |
| `orders` total (heap + indexes) |         — |         7,864 kB |  768 MB |
| `order_items` total             |         — |            15 MB | 1,464 MB |
| **all three tables**            |         — |            23 MB | **~2.3 GB** |

Against that: `shared_buffers` is **128 MB** in this container (the Postgres default), and ~1 GB on
the small managed instances this would realistically run on. So at 100× the working set is roughly
2–18× the cache — and access is spread across 500,000 users, not concentrated in recent rows, so
there is no locality to save it.

Those 15 cache hits then become up to 15 **random 8 KB reads**. At ~0.5–1 ms per random read on
network-attached storage, 0.3 ms becomes 8–15 ms: a 20–50× p99 regression.

What makes it the *first* failure rather than the worst one is how it arrives:

- **No error.** Nothing 500s, nothing times out, nothing appears in an error budget.
- **No plan change.** `EXPLAIN` looks identical; only `shared_blks_read` moves.
- **Invisible to every test in this repository.** The test database holds kilobytes.
- **Gradual, then sudden.** It tracks a cache hit ratio falling past a cliff, so it looks like
  "the app got slow this quarter" — the class of problem that gets misattributed to Node, to the
  ORM, to the cloud, for weeks.

### How I would detect it before a customer reports it

In the order I would actually add them:

1. **`shared_blks_read / calls` on this query's fingerprint in `pg_stat_statements`.** This is the
   *leading* indicator: physical reads per call rises before mean latency does, because the first
   misses are absorbed by the OS page cache. Alert on the ratio, not on latency, and you get weeks
   of warning instead of a pager. `pg_stat_statements` is already loaded in
   [`docker-compose.yml`](docker-compose.yml) so the fingerprint exists from day one.
2. **Route-level p99 as an SLO alert.** Every request already logs `{route, status, durationMs}`
   with the route *pattern* (`/users/:id/orders`), not the path — deliberately, so 500,000 user ids
   aggregate into one time series instead of 500,000 labels
   ([`request-context.ts`](src/http/request-context.ts)). Alert on p99, not mean: this failure
   hides in the tail for a long time.
3. **`log_min_duration_statement=200`**, already set in compose. The database is willing to say
   when it was slow; that is cheaper than inferring it.
4. **Postgres cache hit ratio** (`pg_statio_user_tables`: `heap_blks_hit / (hit + read)`) as the
   dashboard number that explains *why* 1 and 2 moved.

### The fix, so the detection has somewhere to go

Range-partition `orders` by `placed_at` (monthly). Order history is overwhelmingly read at the
recent end, so the recent partitions stay resident while cold history moves off the hot path, and
each partition's index is small enough to stay cached. The endpoint's SQL does not change —
partition pruning applies to exactly this predicate. Doing it *before* it is urgent matters,
because partitioning 5M live rows is a migration and doing it under an incident is not fun.

### Ranked runners-up, and their detection

| # | failure | why it is later | detection |
|---|---|---|---|
| 2 | **Autovacuum falls behind on `orders`.** Default `autovacuum_vacuum_scale_factor = 0.2` waits for ~1M dead tuples on a 5M-row table. Bloat inflates both heap and index, which feeds failure #1. | Needs a sustained write/update rate, not just volume | `pg_stat_user_tables`: `n_dead_tup`, and age of `last_autovacuum`. Lower the scale factor on this table specifically. |
| 3 | **One hot user with millions of orders is walkable but abusive.** 1M orders at `limit=100` is 10,000 requests. Correct, cheap per request, and a trivial way to saturate the pool — there is no rate limiting (§4). | Needs someone to actually do it | Requests per token per route. The fix is a gateway rate limit, not app code. |
| 4 | **The first feature request that needs a different sort or a filter.** `?status=refunded` or `?sort=total_desc` has no supporting index and becomes a sequential scan over the user's whole history. | Needs a product change, not growth | It shows up as a *new* fingerprint in `pg_stat_statements` with a high `shared_blks_read`. Which is the argument for having 1 in place before the feature ships. |
| 5 | **Connection pool saturation** (`PG_POOL_MAX=10`/instance). | Genuinely far away: at 0.3 ms of database time per request, 10 connections serve thousands of requests/second. It only becomes real *because of* failure #1 — when per-query time rises 30×, the same traffic needs 30× the concurrency. | Pool wait time and `pool.waitingCount`; `503 DATABASE_UNAVAILABLE` responses, which are already distinguished from `500` so a client can back off. |

Worth being explicit: pool exhaustion is what a lot of submissions name first, and it is the
*symptom*. The cause is #1.

---

## 4. What I deliberately did not build

Grouped by why, because "no time" and "wrong layer" are different answers.

### Wrong layer — belongs somewhere other than this service

- **A login / token-issuing endpoint.** This is a resource server. Password handling, refresh
  rotation and session revocation are an identity provider's job, and building a half version here
  would invite someone to trust it. `npm run token` is a dev script and says so.
- **Rate limiting.** An in-process limiter is per-instance, so with four instances the real limit is
  4× what it claims — a number that misleads is worse than no number. This belongs at the gateway,
  where the counter is shared. Named as runner-up #3 in §3 rather than quietly skipped.
- **CORS.** No browser origin was specified. A guessed allow-list is either useless or too
  permissive, and `Access-Control-Allow-Origin: *` on an authenticated endpoint is a real mistake.
- **Metrics/tracing exporters.** The instrumentation *decisions* are made — one structured log line
  per request, correlation id in and out, route pattern rather than path so labels stay bounded.
  Wiring OpenTelemetry to a collector that does not exist is configuration, not design.

### Deliberately out of scope for the contract

- **Line items in the response.** `order_items` exists in the schema and is seeded, and the list
  route does not return it. Expanding it here is either an N+1 or an unbounded payload; item detail
  belongs on `GET /api/orders/:id`. The table is present so the schema models the domain honestly
  and the omission is visibly a choice.
- **A `total` / `totalPages` count.** §3 explains: a `COUNT(*)` per page reintroduces the cost
  keyset removes. `hasMore` answers the question a UI actually asks ("is there a next page?") and
  costs exactly one extra row. If a product genuinely needs "1,247 orders", that is a periodically
  refreshed counter, not a synchronous count on a read path.
- **Filtering and sorting** (`?status=`, `?from=`, `?sort=`). Each needs its own index to be
  responsive, so each is a real decision rather than a parameter. Where they would go is settled,
  though: the query schema in [`orders.schema.ts`](src/orders/orders.schema.ts), a second
  statement in the repository, and a matching index — the same three files pagination touches, which
  is the point of the seam.
- **Backward pagination** (`prevCursor`). Symmetric to build (flip the comparison and the sort, then
  reverse in memory) and untested, so it is not there. Real order-history UIs are one-directional.
- **`ETag` / `304`.** Responses are `no-store`; there is nothing to revalidate against.

### Judged not worth it at this size

- **A migration tool.** `db/schema.sql` is idempotent and applied by a 20-line script. One table
  pair and one index does not need Prisma Migrate or Flyway; the second developer or the first
  production deploy does, and that is when I would add it rather than pre-committing to a tool.
- **An ORM.** The whole substance of this endpoint is a row-comparison predicate against a specific
  three-column index. Writing that through query builder and then explaining the SQL it emitted is
  more work than writing the SQL. 25 lines of it, in one file.
- **A DI container.** Constructor injection by hand — `createOrdersService(createOrdersRepository())`
  — is three call sites and no framework.
- **Load and contract tests.** [`npm run bench`](scripts/bench-pagination.ts) measures the thing the
  design claims; k6 against HTTP would mostly measure my laptop. No consumers exist to have a
  contract with yet.
- **Caching.** Per-user order history has poor cache locality and hard invalidation (a new order
  invalidates page 1 for one user), and the query is 0.3 ms. Caching a 0.3 ms query is how you
  acquire a stale-data bug for free.
- **A Dockerfile for the app.** Compose runs Postgres only, so the edit-run loop stays fast and
  there is no build config to defend that has nothing to do with the endpoint.

### The one omission that is a genuine gap

**No audit log of admin access.** An admin can read any customer's order history and nothing
records that it happened. For real customer data that is a compliance problem, not a nice-to-have,
and it is the first thing I would add — a row per admin-initiated read, written outside the request
path. I left it out because "which fields, retained how long, readable by whom" is a policy question
I cannot answer alone, and inventing an answer would be worse than naming the gap. It is a gap.

---

## Appendix: if I had to cut this in half

In order, and stopping when it starts costing something real:

1. **`scripts/bench-pagination.ts` and `scripts/explain.ts`** (~150 lines). They exist to justify a
   claim. Once the claim is accepted they are documentation, and the numbers are in this file.
2. **`db/seed.ts`'s realism** — the long-tail distribution and `order_items`. A flat 10 orders per
   user would have done for tests; the shape exists so §3's failure modes are observable.
3. **`/healthz` + `/readyz`, graceful shutdown, `request-context`** (~120 lines). Cut these and the
   service still answers the question correctly — it just gets worse to operate. This is the first
   cut I would actually argue about.
4. **`test/orders.service.test.ts`.** The integration tests cover the same behaviour end to end. It
   earns its place by pinning the two decisions the service makes *alone* (the `limit + 1` trick,
   and skipping the existence check) so they cannot be refactored away silently — but it is
   duplicative coverage.

What I would not cut, at any size: the cursor's `id` tiebreaker, the `403`-before-any-database-read
ordering, `algorithms: ['HS256']`, ids as strings, and the integration tests. Each of those is one
line or one ordering away from a silent correctness or security bug, and none of them is the kind of
thing a later code review catches.
