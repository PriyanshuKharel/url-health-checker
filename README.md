# Bulk URL Health Checker

Built with Node.js + TypeScript, Fastify, PostgreSQL, Redis, BullMQ and Next.js.

## Run it

```bash
docker compose up --build
```

Then open:

| What                                                  | Where                        |
| ----------------------------------------------------- | ---------------------------- |
| UI                                                    | http://localhost:3000        |
| API (through the nginx gateway, 2 replicas behind it) | http://localhost:4000/health |
| Mock target stats (observed req/s and concurrency)    | http://localhost:4100/stats  |

The default stack runs **2 API replicas** and **2 worker processes** so the multi-instance guarantees are exercised out of the box. Scale either freely:

```bash
docker compose up --build --scale worker=4 --scale api=3
```

To try the CSV upload, there is a sample at [`examples/urls.csv`](examples/urls.csv): 24 real URLs with a header row and extra columns, chosen so one batch covers healthy pages, redirects that change the final URL, 404s, expired and self-signed certificates, a host that no longer resolves, and a service returning 5xx. The importer takes the URL column and ignores the rest.

You can also use the mock data button for mock data

Verify the limits actually held for a batch:

```bash
# receiving side: what the mock server observed, counting every request incl. redirect hops
curl http://localhost:4100/stats          # { totalRequests, maxRequestsPerSecond, maxConcurrent, inFlight }
curl http://localhost:4100/samples        # raw arrival timestamps and the busiest 1s window

# sending side: from the timestamps the workers wrote to Postgres
docker compose exec api npm run verify -- <batchId>

# the limiter in isolation: 8 concurrent clients pulling 320 tokens, max per sliding second must be 10
docker compose exec worker npx tsx apps/worker/scripts/limiter-stress.ts
```

Postgres and Redis are not published to the host by default (so the stack starts even if you already run them locally). For host-side development use the override, which publishes both, then run `npm install` and `npm run dev:api`, `dev:worker`, `dev:web`, `dev:mock` in separate terminals with `.env.example` as the reference:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up postgres redis
```

## Architecture

```
                 ┌──────────────┐  SSR fetch (internal)   ┌─────────────┐
   Browser ────▶ │  Next.js web │ ──────────────────────▶ │   nginx     │──▶ api #1 (Fastify)
      │          └──────────────┘                         │  gateway    │──▶ api #2 (Fastify)
      │   REST + SSE (public :4000)                       └─────────────┘        │        │
      └────────────────────────────────────────────────────────▲                  │ SQL    │ pub/sub + BullMQ + cache
                                                               │                  ▼        ▼
                                                        ┌────────────┐      ┌──────────┐ ┌────────┐
                                                        │ worker #1  │◀────▶│ Postgres │ │ Redis  │
                                                        │ worker #2  │◀────▶│ (truth)  │ │        │
                                                        └────────────┘      └──────────┘ └────────┘
                                                               │ HTTP GET (10 req/s, 5 in flight, global)
                                                               ▼
                                                          target URLs / mock
```

Monorepo (npm workspaces):

| Package             | Role                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`   | Wire types, zod request schemas, status enums, limits. Imported by API, worker **and** the Next.js client, so the client/server boundary is typed end to end.                                       |
| `packages/core`     | Server-only code shared by API and worker: Postgres pool, migrations, repository (every SQL statement and state transition), BullMQ queue definition, Redis pub/sub channels, versioned list cache. |
| `apps/api`          | Fastify. REST endpoints, SSE streams, cache. Stateless; run as many as you like.                                                                                                                    |
| `apps/worker`       | BullMQ worker. Separate process. Does the HTTP checks under the global limits, writes results, publishes events.                                                                                    |
| `apps/web`          | Next.js 15 (App Router).                                                                                                                                                                            |
| `tools/mock-target` | Deterministic HTTP target for demos that also measures the request rate and concurrency it receives.                                                                                                |

### Why each piece of infrastructure is there

- **PostgreSQL is the single source of truth.** `batches` and `url_checks` hold every state. Progress counts are _derived_ from `url_checks` with a `count(*) FILTER (...)` aggregate, never stored separately, so they cannot drift. Batch completion is decided inside the same transaction that writes the last check result, under a row lock on the batch. Without Postgres there is no durable record of what was asked and what was answered; everything else can be wiped and rebuilt from it.
- **BullMQ (on Redis) is the work distributor.** One job per URL, deterministic job ids, retries with exponential backoff, delayed jobs, and stalled-job recovery when a worker dies. Without it the API would have to hand work to workers itself and re-implement retry, backoff and crash recovery.
- **Redis is used for four independent things**, all of which need shared state across processes:
  1. BullMQ's queue storage.
  2. The **global** rate limiter and concurrency semaphore (Lua scripts, see below). Without it each worker process would enforce its own limits and two workers would do 20 req/s and 10 in flight.
  3. Pub/sub fan-out of state changes to every API instance for SSE. Without it a browser connected to API #1 would never hear about a result a worker published to API #2.
  4. The 30-second cache of the batch list, shared by all API replicas so invalidation is global.
- **Fastify** serves REST and hand-rolled SSE (hijacked raw response). **Next.js** renders the pages server-side for a correct first paint and hands off to client components for live updates.
- **nginx** is only there so `docker compose up` gives you two API replicas behind one port. It is configured for SSE (no buffering, long read timeout, HTTP/1.1 keep-alive upstream).

## The guarantees, and how they hold with N workers

All limits live in `packages/shared` (`LIMITS`) and are enforced by Redis, not by process-local settings.

**Global concurrency = 5.** BullMQ's `concurrency` option is per worker process, so it is used only as a local cap. The real limit is a Redis semaphore: a sorted set of at most 5 slot tokens scored by lease expiry (`apps/worker/src/limiter.ts`). A job acquires a slot before doing any HTTP work and releases it in `finally`. A slot held by a crashed worker expires with its lease (60s), so a crash cannot leak capacity forever. If no slot is available within 3s the job is moved back to the delayed set via `job.moveToDelayed()` + `DelayedError`, which does **not** count as an attempt.

**Global rate limit = 10 requests/second.** A sliding-window log in Redis: a sorted set of the last 10 request timestamps; a request may go out only if fewer than 10 requests happened inside the window (`ACQUIRE_TOKEN` Lua script, atomic, uses Redis server time in microseconds so worker clocks need not agree and rounding cannot leak a request). Redirects are followed manually, and **every hop takes its own token**, so "10 requests per second" means HTTP requests, not URL checks. BullMQ's own `limiter` was deliberately not used: it counts job starts, not HTTP requests, and it cannot express the concurrency cap, so combining the two would have double-counted.

The window is 1000 ms plus a 50 ms margin (`LIMITS.RATE_WINDOW_MS`). The margin exists because I measured from the receiving side: with an exact 1000 ms window the workers granted precisely 10 tokens per second, but 1 to 2 ms of network jitter occasionally let the first request of the next second arrive inside the receiver's current second, showing up as 11. The margin costs about 5% throughput and makes the limit hold as observed by the _target_, which is the observation that matters.

**Retries: up to 3, exponential backoff.** BullMQ `attempts: 4` (1 + 3 retries) with `backoff: exponential, 1000ms` (1s, 2s, 4s). What is retried is a _transient_ failure: network errors, timeouts, HTTP 429 and 5xx. Permanent failures (DNS name does not exist, TLS certificate errors, redirect loops, invalid redirect targets) throw `UnrecoverableError` and fail immediately. A 4xx response is **not** a failure of the check: the check completed and recorded that the URL returns 404. The check states are therefore:

| `url_checks.status` | Meaning                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `queued`            | Waiting for a worker (including waiting for a retry: `attempts > 0` shows as "Retrying" in the UI) |
| `running`           | A worker holds it                                                                                  |
| `completed`         | A final HTTP response was received and recorded (any status code)                                  |
| `failed`            | No final response could be obtained: transient errors exhausted 4 attempts, or a permanent error   |
| `cancelled`         | Cancelled by the user while queued or running                                                      |

"Retry failed only" re-runs `failed` rows only.

**Proof.** `docker compose exec api npm run verify -- <batchId>` computes max checks started per sliding second and max overlap from `started_at` (stamped when the first request actually goes out, after the token) and `finished_at`. `http://localhost:4100/stats` shows the same from the receiving side, counting every request including redirect hops. Measured while writing this, with two workers, a 65-URL batch with redirects (75 requests):

| Observer                                   | max requests / sliding second | max concurrent |
| ------------------------------------------ | ----------------------------- | -------------- |
| mock target `/stats`                       | 10                            | 5              |
| Postgres timestamps (`verify`)             | 10                            | 5              |
| limiter stress test, 8 clients, 320 tokens | 10                            | n/a            |

## Source of truth and idempotency

Postgres holds the truth; BullMQ holds _intent to work_; Redis pub/sub carries _hints_. Every layer that could disagree is reconciled toward Postgres:

- **Create:** batch + all URLs are inserted in one transaction and committed _before_ any job is enqueued. Enqueue happens after commit with job id `check:<checkId>:<run>`. Adding a job whose id already exists is a no-op in BullMQ, so an enqueue can be safely repeated. A worker-side **reconciler** re-enqueues any `queued` row that has not moved for 2 minutes, which repairs a crash between COMMIT and enqueue. Clients send an `Idempotency-Key` header (the UI generates one per submission attempt); a replay returns the existing batch with `created: false`, and a concurrent duplicate is caught by the unique index.
- **Worker claim:** before doing anything the worker runs `UPDATE ... SET status='running' WHERE id=$1 AND run=$2 AND status IN ('queued','running')`. A stale job (old `run`), or a cancelled/finished row, fails the claim and is skipped without touching the network.
- **Result write:** `UPDATE ... WHERE id=$1 AND run=$2 AND status='running'`. If the user cancelled while the request was in flight the guard rejects the write, so a late result can never overwrite a cancellation. In the same transaction, with the batch row locked, the batch is marked `completed` if and only if no `queued`/`running` rows remain. Two workers finishing the last two checks serialise on that lock and exactly one completes the batch.
- **Cancel:** one transaction flips every `queued`/`running` row to `cancelled` and the batch to `cancelled`. Then, best effort: queued/delayed jobs are removed from BullMQ; a `cancel` message on Redis pub/sub makes every worker abort in-flight fetches for that batch via `AbortController`. Even if both of those failed, the DB guards above make the leftover jobs harmless. Cancelling twice is a no-op.
- **Retry failed only:** one transaction resets `failed` rows to `queued` with `run = run + 1` and clears their result fields; completed rows are untouched. The new `run` yields a new job id and makes any straggler job for the previous run stale. The batch goes back to `running` and completes again through the normal path.
- **Crash during a job:** BullMQ's stalled-job detection re-delivers it; the claim accepts `running` rows so the redelivered job continues. If it stalls past the limit, the worker's `failed` handler marks the row `failed` (guarded, so it is a no-op for anything the processor already finalised).

## Live updates: Server-Sent Events

Transport: **SSE** over plain HTTP, one stream per open batch page (`GET /api/batches/:id/events`) and one for the list page (`GET /api/events`).

Why SSE and not WebSockets or polling:

- The data flow is strictly server → client. WebSockets buy bidirectionality we do not need at the cost of a second protocol, upgrade handling in every proxy, and hand-written reconnection.
- `EventSource` reconnects automatically with backoff, and works through nginx and most corporate proxies because it is just a long HTTP response.
- Polling would either hammer the API or lag by the poll interval; SSE gives sub-second updates at the cost of one idle connection per tab.

How it stays correct:

- **Multi-instance:** workers publish every state change to the Redis channel `uhc:events`. Each API instance holds one subscription and fans events out to its own SSE clients. A browser can be connected to any replica.
- **Refresh safe and cold-load correct:** the page is server-rendered from `GET /api/batches/:id`, which reads Postgres. No client state is needed.
- **Dropped connections:** the stream is _deltas only_; it never replays. Instead the client re-fetches the full snapshot on **every** `open` event, including the first. That closes the race between the SSR snapshot and the stream connect, and recovers from any drop, however long, with one request. The UI shows Live / Reconnecting.
- **Ordering:** events carry the row's `run` and `updatedAt`, and the client only applies an event that is not older than what it holds (`apps/web/lib/merge.ts`). Cancel and retry send a single `batch.updated` event and the client re-fetches the snapshot rather than receiving one event per row.
- **Heartbeats** every 15s keep idle streams alive through proxies.

## Caching (30s batch list)

`GET /api/batches` is served from Redis with a 30s TTL, shared by all API replicas (`X-Cache: HIT|MISS` header). Invalidation is **versioned**: a counter is bumped on create, cancel, retry and batch completion, and the cache key includes the version. Bumping instead of deleting avoids the classic race where a slow request that read the DB before the invalidation writes stale data back under the live key.

What counts as "user-visible staleness" and how it is avoided:

- A batch is created, cancelled, retried or completes → version bump → the next list request misses the cache and reads Postgres.
- Per-URL progress while a batch is running does **not** bump the version (that would make the cache pointless for exactly the time it is useful). Instead the list page subscribes to the global SSE stream and applies progress events on top of the cached payload, so the bars move live even though the endpoint is cached. A cold load mid-batch may show counts up to 30s old for a fraction of a second until the next event arrives.

## UI and Next.js decisions

- `app/page.tsx` and `app/batches/[id]/page.tsx` are **server components** with `dynamic = 'force-dynamic'`. They fetch from the API over the internal Docker network (`API_INTERNAL_URL`) with `cache: 'no-store'`, so Next.js never adds a second cache layer on top of the API's. The result is a complete first paint with no spinner and correct state whether the batch is running or finished.
- `BatchView`, `BatchList`, `NewBatchForm` are **client components** because they own the `EventSource`, local state and form interaction. The server/client boundary is exactly where interactivity starts.
- The browser talks to the API directly at `NEXT_PUBLIC_API_URL` (CORS enabled), not through Next.js rewrites, so SSE is not proxied through the Next server.
- Each batch is addressable at `/batches/<uuid>`; unknown ids render `not-found.tsx`.
- Shared types come from `@uhc/shared`; the API constructs its responses with `satisfies`-style typed bodies and the client fetch helpers return those same types.

## Horizontal scaling of the API

The API is stateless. Running N instances behind any load balancer works with no configuration change because:

- All state is in Postgres; all cross-instance coordination is in Redis.
- Each instance subscribes to the same Redis channel, so an SSE client attached to any instance receives every event. The event hub only fans out in memory to that instance's own connections.
- The list cache is in Redis, so a batch created via instance A invalidates what instance B serves.
- Idempotent creation is enforced by a unique index, not by process memory.
- SSE needs the load balancer to not buffer and to allow long-lived responses; sticky sessions are **not** required because reconnects re-sync from a snapshot. `docker/nginx.conf` shows the settings.

Scaling workers is the same story: limits, retries and completion are all coordinated through Redis and Postgres, so `--scale worker=4` changes throughput headroom but not behaviour.

## Trade-offs and what I would do with more time

- **tsx instead of a compiled build for the Node services.** It keeps the workspace-internal TypeScript packages friction-free and the images simple. For production I would compile with `tsc`/`tsup` and use `output: 'standalone'` for Next.js to cut image size and start-up time.
- **Hand-written SQL with `pg`** rather than an ORM. It made the transactional guards and lock ordering explicit, which is the heart of this task. With more time I would add Drizzle or Kysely for typed rows instead of the hand-maintained row interfaces.
- **No automated test suite.** I traded tests for the verification tooling (`verify` script, mock `/stats`) and for spending time on the correctness of the state machine. Next step would be integration tests against the compose stack: limits, cancel-in-flight, retry-failed, duplicate idempotency key, dropped SSE.
- **Title extraction** reads up to 256 KB and assumes UTF-8. Charset sniffing and a real HTML parser would be better.
- **Reconciler re-enqueues by age (2 minutes).** It relies on deterministic job ids making duplicates harmless. A transactional outbox would be the stricter design.
- **Global stream for the list page** sends every batch update to every list viewer. Fine at this scale; a large deployment would want per-batch subscriptions or a coalescing tick.
- **Cache granularity.** The 30s cache is keyed per page (`limit:offset`) and invalidated globally. Finer invalidation was not worth the complexity here.
- **No auth, no rate limiting on the API itself**, per the brief.

## Assumptions (recorded as requested)

- "Retries: up to 3" means 3 retries after the first attempt, i.e. 4 attempts in total.
- "10 requests/second" is interpreted strictly as outbound HTTP requests, so redirect hops are counted individually. "5 checks in flight" is per URL check (a check with redirects holds one slot for its whole duration).
- A 4xx/5xx final response is a _completed_ check with an unhealthy status, not a _failed_ check. Only checks that never obtained a final response are `failed`, and only those are re-run by "Retry failed only".
- URLs without a scheme get `https://` prepended; duplicates within one submission are collapsed; a submission containing an unparseable URL is rejected as a whole with the offending lines listed, rather than partially accepted.
- Cancelled URLs stay cancelled. "Retry failed only" does not resurrect them.
- Response time is measured from the first request until the final response's headers arrive, including redirect hops.
- Per-check hard deadline is 15s for all hops and the body read.
- Max 1000 URLs per batch.

## API

| Method | Path                            | Notes                                                                                                                                          |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `POST` | `/api/batches`                  | `{ name?, urls[] }`, optional `Idempotency-Key` header. `201` with `{ batch, created: true }`, or `200` `{ batch, created: false }` on replay. |
| `GET`  | `/api/batches?limit&offset`     | Cached 30s. `X-Cache: HIT                                                                                                                      | MISS`. |
| `GET`  | `/api/batches/:id`              | `{ batch, checks[] }` snapshot.                                                                                                                |
| `POST` | `/api/batches/:id/cancel`       | Idempotent. `{ batch, affected }`.                                                                                                             |
| `POST` | `/api/batches/:id/retry-failed` | `{ batch, affected }`.                                                                                                                         |
| `GET`  | `/api/batches/:id/events`       | SSE: `check.updated`, `batch.updated`.                                                                                                         |
| `GET`  | `/api/events`                   | SSE: `batch.updated` only, for the list page.                                                                                                  |
| `GET`  | `/health`                       | DB + Redis ping, instance id, open SSE connections.                                                                                            |
