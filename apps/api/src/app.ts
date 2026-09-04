import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type pg from "pg";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { config, type BatchListCache, type CheckJobData } from "@uhc/core";
import type { EventHub } from "./eventHub.js";
import { registerBatchRoutes } from "./routes/batches.js";
import { registerSseRoutes } from "./routes/sse.js";

export interface AppDeps {
  pool: pg.Pool;
  redis: Redis;
  queue: Queue<CheckJobData>;
  cache: BatchListCache;
  hub: EventHub;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  await app.register(cors, {
    origin: true,
    exposedHeaders: ["X-Cache", "X-Instance"],
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Instance", config.instanceId);
  });

  app.get("/health", async () => {
    await deps.pool.query("SELECT 1");
    await deps.redis.ping();
    return {
      ok: true,
      instance: config.instanceId,
      sseConnections: deps.hub.connections,
    };
  });

  registerBatchRoutes(app, deps);
  registerSseRoutes(app, deps);

  return app;
}
