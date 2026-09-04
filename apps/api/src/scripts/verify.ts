import { createPool } from "@uhc/core";

const batchId = process.argv[2];
if (!batchId) {
  console.error("usage: npm run verify -- <batchId>");
  process.exit(1);
}

const pool = createPool();
const res = await pool.query<{
  started_at: Date | null;
  finished_at: Date | null;
  status: string;
  attempts: number;
}>(
  `SELECT started_at, finished_at, status, attempts FROM url_checks WHERE batch_id = $1`,
  [batchId],
);
await pool.end();

const rows = res.rows.filter((r) => r.started_at && r.finished_at);
const starts = rows.map((r) => r.started_at!.getTime()).sort((a, b) => a - b);

// Max number of checks started inside
let maxPerSecond = 0;
for (let i = 0, j = 0; i < starts.length; i++) {
  while (starts[i]! - starts[j]! >= 1000) j++;
  maxPerSecond = Math.max(maxPerSecond, i - j + 1);
}

// Max number of checks in flight at the same instant
const points = rows
  .flatMap((r) => [
    { t: r.started_at!.getTime(), d: 1 },
    { t: r.finished_at!.getTime(), d: -1 },
  ])
  .sort((a, b) => a.t - b.t || a.d - b.d);
let inFlight = 0;
let maxConcurrent = 0;
for (const p of points) {
  inFlight += p.d;
  maxConcurrent = Math.max(maxConcurrent, inFlight);
}

const byStatus: Record<string, number> = {};
for (const r of res.rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
const retried = res.rows.filter((r) => r.attempts > 1).length;

console.log(
  JSON.stringify(
    {
      batchId,
      checks: res.rows.length,
      byStatus,
      checksWithRetries: retried,
      maxChecksStartedPerSecond: maxPerSecond,
      maxConcurrentChecks: maxConcurrent,
      note: "started_at is the first outbound request of the final attempt. Redirect hops and earlier attempts are extra requests not visible here; the mock target /stats endpoint counts every request it received.",
    },
    null,
    2,
  ),
);
