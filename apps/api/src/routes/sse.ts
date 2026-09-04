import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LiveEvent, SseMessage } from "@uhc/shared";
import { config, getBatch } from "@uhc/core";
import type { AppDeps } from "../app.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEARTBEAT_MS = 15_000;

function openStream(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AppDeps,
  select: (event: LiveEvent) => LiveEvent | null,
): void {
  reply.hijack();
  const res = reply.raw;

  const headers: Record<string, string | number | string[]> = {};
  for (const [k, v] of Object.entries(reply.getHeaders()))
    if (v !== undefined) headers[k] = v;
  res.writeHead(200, {
    ...headers,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Instance": config.instanceId,
  });

  const send = (message: SseMessage) => {
    res.write(`id: ${Date.now()}\ndata: ${JSON.stringify(message)}\n\n`);
  };

  res.write("retry: 2000\n\n");
  send({ type: "hello", instance: config.instanceId });

  const unsubscribe = deps.hub.subscribe((event) => {
    const out = select(event);
    if (out) send(out);
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.raw.on("close", cleanup);
  res.on("error", cleanup);
}

export function registerSseRoutes(app: FastifyInstance, deps: AppDeps): void {
  /** Per-batch stream: every check update and batch update for this batch. */
  app.get<{ Params: { id: string } }>(
    "/api/batches/:id/events",
    async (req, reply) => {
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.code(404).send({ error: "Batch not found" });
      const batch = await getBatch(deps.pool, id);
      if (!batch) return reply.code(404).send({ error: "Batch not found" });
      openStream(req, reply, deps, (event) =>
        event.batchId === id ? event : null,
      );
    },
  );

  /** Global stream for the list page: batch summaries only (check payloads are collapsed). */
  app.get("/api/events", async (req, reply) => {
    openStream(req, reply, deps, (event) => {
      if (event.type === "batch.updated") return event;
      return {
        type: "batch.updated",
        batchId: event.batchId,
        batch: event.batch,
        reason: "progress",
      };
    });
  });
}
