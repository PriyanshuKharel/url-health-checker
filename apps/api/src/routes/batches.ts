import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createBatchSchema,
  listBatchesQuerySchema,
  normalizeUrl,
  type ApiErrorBody,
  type BatchActionResponse,
  type BatchDetail,
  type BatchListResponse,
  type CreateBatchResponse,
} from "@uhc/shared";
import {
  cancelBatch,
  enqueueChecks,
  getBatch,
  getBatchByIdempotencyKey,
  getChecks,
  insertBatch,
  jobIdFor,
  listBatches,
  publishCancel,
  publishEvent,
  retryFailed,
  withTransaction,
  type CreatedBatch,
} from "@uhc/core";
import type { AppDeps } from "../app.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(
  reply: FastifyReply,
  status: number,
  error: string,
  details?: unknown,
) {
  const body: ApiErrorBody =
    details === undefined ? { error } : { error, details };
  return reply.code(status).send(body);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

export function registerBatchRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { pool, redis, queue, cache } = deps;

  app.post("/api/batches", async (req, reply) => {
    const parsed = createBatchSchema.safeParse(req.body);
    if (!parsed.success)
      return sendError(
        reply,
        400,
        "Invalid request body",
        parsed.error.flatten(),
      );

    const headerKey = req.headers["idempotency-key"];
    const idempotencyKey =
      typeof headerKey === "string" && headerKey.length > 0
        ? headerKey.slice(0, 200)
        : null;

    if (idempotencyKey) {
      const existing = await getBatchByIdempotencyKey(pool, idempotencyKey);
      if (existing) {
        const body: CreateBatchResponse = { batch: existing, created: false };
        return reply.code(200).send(body);
      }
    }

    const invalid: string[] = [];
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const raw of parsed.data.urls) {
      const normalized = normalizeUrl(raw);
      if (!normalized) invalid.push(raw);
      else if (!seen.has(normalized)) {
        seen.add(normalized);
        urls.push(normalized);
      }
    }
    if (invalid.length > 0) {
      return sendError(
        reply,
        400,
        `${invalid.length} URL(s) are not valid http(s) URLs`,
        { invalid },
      );
    }

    const name =
      parsed.data.name?.trim() ||
      `Batch of ${urls.length} URL${urls.length === 1 ? "" : "s"}`;

    // 1. Persist batch + URLs (single transaction). Nothing is enqueued until this commits.
    let created: CreatedBatch;
    try {
      created = await withTransaction(pool, (tx) =>
        insertBatch(tx, { name, urls, idempotencyKey }),
      );
    } catch (err) {
      if (idempotencyKey && isUniqueViolation(err)) {
        // Two concurrent requests with the same key: the loser returns the winner's batch.
        const existing = await getBatchByIdempotencyKey(pool, idempotencyKey);
        if (existing) {
          const body: CreateBatchResponse = { batch: existing, created: false };
          return reply.code(200).send(body);
        }
      }
      throw err;
    }

    // 2. Enqueue one job per URL. Job ids are deterministic so a repeat is harmless,
    //    and the worker-side reconciler re-enqueues anything lost between these two steps.
    await enqueueChecks(queue, created.checks);

    await cache.invalidate();
    await publishEvent(redis, {
      type: "batch.updated",
      batchId: created.batch.id,
      batch: created.batch,
      reason: "created",
    });

    const body: CreateBatchResponse = { batch: created.batch, created: true };
    return reply.code(201).send(body);
  });

  app.get("/api/batches", async (req, reply) => {
    const parsed = listBatchesQuerySchema.safeParse(req.query);
    if (!parsed.success)
      return sendError(reply, 400, "Invalid query", parsed.error.flatten());
    const { limit, offset } = parsed.data;
    const suffix = `${limit}:${offset}`;

    const cached = await cache.get<BatchListResponse>(suffix);
    if (cached.value) {
      reply.header("X-Cache", "HIT");
      return cached.value;
    }

    const { batches, total } = await listBatches(pool, limit, offset);
    const body: BatchListResponse = {
      batches,
      total,
      cachedAt: new Date().toISOString(),
    };
    await cache.set(suffix, cached.version, body);
    reply.header("X-Cache", "MISS");
    return body;
  });

  app.get<{ Params: { id: string } }>(
    "/api/batches/:id",
    async (req, reply) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return sendError(reply, 404, "Batch not found");
      const batch = await getBatch(pool, id);
      if (!batch) return sendError(reply, 404, "Batch not found");
      const checks = await getChecks(pool, id);
      const body: BatchDetail = { batch, checks };
      return body;
    },
  );

  //  cancel
  app.post<{ Params: { id: string } }>(
    "/api/batches/:id/cancel",
    async (req, reply) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return sendError(reply, 404, "Batch not found");

      const result = await withTransaction(pool, (tx) => cancelBatch(tx, id));
      if (!result) return sendError(reply, 404, "Batch not found");

      if (result.cancelled.length > 0) {
        // Queued/delayed jobs: remove from the queue (best effort; a job that is active cannot be
        // removed, so the worker is told to abort it and its final write is rejected by the DB guard).
        await Promise.all(
          result.cancelled.map(async (c) => {
            try {
              const job = await queue.getJob(jobIdFor(c.id, c.run));
              await job?.remove();
            } catch {
              /* active job: handled by the abort signal + status guard */
            }
          }),
        );
        await publishCancel(redis, id);
        await cache.invalidate();
        await publishEvent(redis, {
          type: "batch.updated",
          batchId: id,
          batch: result.batch,
          reason: "cancelled",
        });
      }

      const body: BatchActionResponse = {
        batch: result.batch,
        affected: result.cancelled.length,
      };
      return body;
    },
  );

  // retry failed only
  app.post<{ Params: { id: string } }>(
    "/api/batches/:id/retry-failed",
    async (req, reply) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return sendError(reply, 404, "Batch not found");

      const result = await withTransaction(pool, (tx) => retryFailed(tx, id));
      if (!result) return sendError(reply, 404, "Batch not found");

      if (result.requeued.length > 0) {
        await enqueueChecks(queue, result.requeued);
        await cache.invalidate();
        await publishEvent(redis, {
          type: "batch.updated",
          batchId: id,
          batch: result.batch,
          reason: "retry",
        });
      }

      const body: BatchActionResponse = {
        batch: result.batch,
        affected: result.requeued.length,
      };
      return body;
    },
  );
}
