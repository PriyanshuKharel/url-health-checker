import { LIMITS } from "@uhc/shared";

// check cannot succeed no matter how often it is retried
export class PermanentCheckError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "PermanentCheckError";
  }
}

//check might succeed on a later attempt
export class TransientCheckError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "TransientCheckError";
  }
}

export interface CheckResult {
  httpStatus: number;
  finalUrl: string;
  responseTimeMs: number;
  pageTitle: string | null;
  requests: number;
}

export interface CheckOptions {
  signal: AbortSignal;
  beforeRequest: () => Promise<void>;
}

const MAX_HTML_BYTES = 256 * 1024;
const PERMANENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN_PERMANENT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_INVALID_URL",
]);

function errorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === "string") return e.code;
  if (e.cause) return errorCode(e.cause);
  return null;
}

function errorMessage(err: unknown): string {
  if (typeof err !== "object" || err === null) return String(err);
  const e = err as { message?: unknown; cause?: unknown };
  const cause = e.cause ? errorMessage(e.cause) : null;
  const own = typeof e.message === "string" ? e.message : String(err);
  return cause && cause !== own ? `${own}: ${cause}` : own;
}

/** Abort/timeout errors are rethrown as-is so the caller can tell cancel from timeout. */
function classifyNetworkError(err: unknown): Error {
  if (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  )
    return err;
  const code = errorCode(err);
  const message = code ? `${code}: ${errorMessage(err)}` : errorMessage(err);
  if (code && PERMANENT_CODES.has(code))
    return new PermanentCheckError(message);
  return new TransientCheckError(message);
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#x"))
        return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#"))
        return String.fromCodePoint(parseInt(lower.slice(1), 10));
      return ENTITIES[lower] ?? match;
    },
  );
}

async function extractTitle(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let html = "";
  try {
    while (html.length < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/title\s*>/i.test(html)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!match) return null;
  const title = decodeEntities(match[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return title ? title.slice(0, 500) : null;
}

/**
 * Performs one health check: follows redirects manually (so every hop is rate
 * limited and the final URL is known), records the final status and timing, and
 * extracts the <title> from HTML responses.
 */
export async function checkUrl(
  url: string,
  opts: CheckOptions,
): Promise<CheckResult> {
  let current = url;
  let requests = 0;
  const started = performance.now();

  for (let hop = 0; hop <= LIMITS.MAX_REDIRECTS; hop++) {
    await opts.beforeRequest();
    requests++;

    let res: Response;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: opts.signal,
        headers: {
          "user-agent": "uhc-health-checker/1.0 (+bulk-url-health-checker)",
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        },
      });
    } catch (err) {
      throw classifyNetworkError(err);
    }

    const location = res.headers.get("location");
    if (isRedirect(res.status) && location) {
      await res.body?.cancel().catch(() => undefined);
      try {
        current = new URL(location, current).toString();
      } catch {
        throw new PermanentCheckError(
          `Invalid redirect location: ${location}`,
          res.status,
        );
      }
      continue;
    }

    const responseTimeMs = Math.round(performance.now() - started);

    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      throw new TransientCheckError(`HTTP ${res.status}`, res.status);
    }

    const contentType = res.headers.get("content-type") ?? "";
    let pageTitle: string | null = null;
    if (/text\/html|application\/xhtml/i.test(contentType)) {
      pageTitle = await extractTitle(res);
    } else {
      await res.body?.cancel().catch(() => undefined);
    }

    return {
      httpStatus: res.status,
      finalUrl: current,
      responseTimeMs,
      pageTitle,
      requests,
    };
  }

  throw new PermanentCheckError(
    `Too many redirects (more than ${LIMITS.MAX_REDIRECTS})`,
  );
}
