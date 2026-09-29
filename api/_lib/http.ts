// Request/response helpers shared by the API functions. Web-standard Request/Response, so the same
// handlers run on Vercel and in the local Vite dev server.

/** An error whose message is safe to show in the admin UI. Anything else becomes a generic 500. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...init.headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
  }
  // Log the real cause for the Vercel function logs; never send it to the browser.
  console.error('[api] unexpected error', err);
  return json({ error: { code: 'server_error', message: 'Something went wrong on the server. Please try again.' } }, { status: 500 });
}

/** Reads a JSON body, rejecting anything over `maxBytes` before and after reading. */
export async function readJson<T = unknown>(request: Request, maxBytes: number): Promise<T> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new ApiError(413, 'too_large', 'The request is too large.');
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
    throw new ApiError(415, 'bad_content_type', 'Expected a JSON request.');
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) throw new ApiError(413, 'too_large', 'The request is too large.');
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    throw new ApiError(400, 'bad_json', 'The request body is not valid JSON.');
  }
}

/** The origin the browser used, honouring Vercel's forwarded headers. */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host;
  const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

export const isHttps = (request: Request) => requestOrigin(request).startsWith('https://');

/**
 * CSRF defence for state-changing requests. The session cookie is SameSite=Strict; on top of that,
 * writes must carry a custom header (which cross-site forms can't send without a CORS preflight we
 * never approve) and, when the browser reports it, a same-origin Origin / Sec-Fetch-Site.
 */
export function assertSameOrigin(request: Request) {
  if (request.headers.get('x-portfolio-admin') !== '1') {
    throw new ApiError(403, 'csrf', 'This request was blocked for security reasons. Reload the page and try again.');
  }
  const origin = request.headers.get('origin');
  if (origin && origin !== requestOrigin(request)) {
    throw new ApiError(403, 'csrf', 'This request was blocked for security reasons. Reload the page and try again.');
  }
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new ApiError(403, 'csrf', 'This request was blocked for security reasons. Reload the page and try again.');
  }
}

export function clientIp(request: Request): string {
  return (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
}
