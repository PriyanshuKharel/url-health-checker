/**
 * Mock target server used for demos and for verifying the worker guarantees from
 * the receiving side. It records every request it serves and exposes the maximum
 * requests-per-second and maximum concurrency it has observed at /stats.
 *
 *   /ok?delay=300&title=Hello      200 HTML page with a <title>
 *   /status/503                    that status code
 *   /flaky?p=0.5                   503 with probability p, else 200
 *   /redirect/3                    three 302 hops then 200
 *   /slow?delay=20000              exceeds the checker timeout
 *   /stats  /reset                 observed limits
 */
import http from 'node:http';

interface Sample {
  start: number;
  end: number;
}

const samples: Sample[] = [];
let inFlight = 0;
let maxConcurrent = 0;

function maxPerSecond(): number {
  const starts = samples.map((s) => s.start).sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < starts.length; i++) {
    while (starts[i]! - starts[j]! >= 1000) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

function html(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${body}</h1></body></html>`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ totalRequests: samples.length, maxRequestsPerSecond: maxPerSecond(), maxConcurrent, inFlight }, null, 2));
    return;
  }
  if (url.pathname === '/samples') {
    // Raw arrival times (ms since the first recorded request) plus the busiest 1s window, for debugging.
    const starts = samples.map((s) => s.start).sort((a, b) => a - b);
    const base = starts[0] ?? 0;
    let best = { count: 0, from: 0 };
    for (let i = 0, j = 0; i < starts.length; i++) {
      while (starts[i]! - starts[j]! >= 1000) j++;
      if (i - j + 1 > best.count) best = { count: i - j + 1, from: starts[j]! - base };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ arrivalsMs: starts.map((s) => s - base), busiestWindow: best }, null, 2));
    return;
  }
  if (url.pathname === '/reset') {
    samples.length = 0;
    maxConcurrent = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const start = Date.now();
  inFlight++;
  maxConcurrent = Math.max(maxConcurrent, inFlight);
  const finish = () => {
    inFlight--;
    samples.push({ start, end: Date.now() });
  };
  res.on('finish', finish);
  res.on('close', () => {
    if (!res.writableFinished) finish();
  });

  const delay = Number(url.searchParams.get('delay') ?? 0);
  if (delay > 0) await sleep(delay);

  if (url.pathname === '/ok' || url.pathname === '/slow') {
    const title = url.searchParams.get('title') ?? `OK page ${url.searchParams.get('n') ?? ''}`.trim();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html(title, title));
    return;
  }

  const statusMatch = url.pathname.match(/^\/status\/(\d{3})$/);
  if (statusMatch) {
    const code = Number(statusMatch[1]);
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html(`Status ${code}`, `This page returns ${code}`));
    return;
  }

  if (url.pathname === '/flaky') {
    const p = Number(url.searchParams.get('p') ?? 0.5);
    if (Math.random() < p) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('flaky failure');
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html('Flaky but fine this time', 'Recovered'));
    }
    return;
  }

  const redirectMatch = url.pathname.match(/^\/redirect\/(\d+)$/);
  if (redirectMatch) {
    const remaining = Number(redirectMatch[1]);
    const next = remaining <= 1 ? '/ok?title=After%20redirects' : `/redirect/${remaining - 1}`;
    res.writeHead(302, { location: next });
    res.end();
    return;
  }

  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html('Not found', 'No such route'));
});

const port = Number(process.env.PORT ?? 4100);
server.listen(port, '0.0.0.0', () => console.log(`mock target listening on ${port}`));
