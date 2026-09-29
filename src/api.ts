// Browser client for /api/admin. Sends the session cookie (same-origin) and the CSRF header, and
// turns every failure into an ApiFailure with a message that's safe to show.
import type { Content, Issue, Schema } from '../lib/schema';

export interface SiteInfo {
  id: string;
  name: string;
  url: string;
}

export interface PublishedState {
  content: Content;
  sha: string;
  updatedAt: string | null;
}

export interface Version {
  commitSha: string;
  message: string;
  date: string;
  author: string;
}

export type Deployment = 'git' | 'hook' | 'hook_failed' | 'none';
export type SaveResponse = { published: PublishedState; changes: string[]; deployment: Deployment; unchanged?: boolean };

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

/** Called on any 401 so the app can show the sign-in dialog without losing what's on screen. */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'x-portfolio-admin': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiFailure(0, 'timeout', 'The request timed out. Check your connection and try again.');
    }
    throw new ApiFailure(
      0,
      'network',
      import.meta.env.DEV
        ? "Couldn't reach the admin server. Make sure `npm run dev` is running in the portfolio-admin folder, then try again."
        : "Couldn't reach the server. Check your internet connection and try again.",
    );
  }
  const data = await res.json().catch(() => null);
  if (res.ok) return data as T;
  const error = data?.error;
  if (res.status === 401 && path !== 'login') onUnauthorized();
  throw new ApiFailure(
    res.status,
    error?.code ?? 'server_error',
    typeof error?.message === 'string' ? error.message : 'Something went wrong on the server. Please try again.',
    error?.details?.issues ?? [],
  );
}

export const api = {
  session: () => call<{ authenticated: boolean; username: string | null; sites: SiteInfo[] }>('GET', 'session'),
  login: (username: string, password: string) => call<{ username: string }>('POST', 'login', { username, password }),
  logout: () => call('POST', 'logout', {}),
};

/** Calls for one portfolio. */
export function siteApi(siteId: string) {
  const p = (rest: string) => `sites/${encodeURIComponent(siteId)}/${rest}`;
  return {
    load: () => call<{ site: SiteInfo; schema: Schema; published: PublishedState }>('GET', p('portfolio')),
    /** Save = publish: validates on the server and commits to the portfolio's repo. */
    publish: (content: Content, baseSha: string) => call<SaveResponse>('POST', p('publish'), { content, baseSha }, 60_000),
    versions: () => call<{ versions: Version[] }>('GET', p('versions')),
    version: (commitSha: string) => call<{ content: Content }>('GET', p(`versions/${commitSha}`)),
    restore: (commitSha: string, baseSha: string) => call<SaveResponse>('POST', p('restore'), { commitSha, baseSha }, 60_000),
    upload: (fileName: string, data: string) => call<{ url: string }>('POST', p('upload'), { fileName, data }, 60_000),
  };
}

export type SiteApi = ReturnType<typeof siteApi>;
