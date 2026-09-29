// Browser client for /api/admin. Sends the session cookie (same-origin) and the CSRF header, and
// turns every failure into an ApiFailure with a message that's safe to show.
import type { Content, Issue, Schema } from '../lib/schema';

export interface SiteInfo {
  id: string;
  name: string;
  /** The portfolio deployment: preview.html, image thumbnails. */
  url: string;
  /** Profiles: the public page (default `url`) and the file reporting its live version (default `url`/version.json). */
  liveUrl?: string;
  versionUrl?: string;
  /** This portfolio hosts self-service profiles (admin moderation). */
  hostsProfiles?: boolean;
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

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 30_000, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'x-portfolio-admin': '1', ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
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
  if (res.ok && data !== null) return data as T;
  if (data === null) {
    // Not our JSON: the API function isn't deployed/routed, or something in front of it (e.g. Vercel
    // Deployment Protection) answered instead.
    throw new ApiFailure(
      res.status,
      'bad_response',
      res.status === 404
        ? 'The admin API was not found on this deployment (HTTP 404). Check that the Vercel project uses the "Other" framework preset and the build ran `npm run build`.'
        : res.status === 401 || res.status === 403
          ? `The admin API was blocked before reaching the server (HTTP ${res.status}). If Vercel Deployment Protection is on, turn it off for this project or open the production URL.`
          : `The admin server sent an unexpected response (HTTP ${res.status}). Please try again.`,
    );
  }
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

/** The calls the editor screens use, against one content file: `prefix` is its route, `headers` its credentials. */
function contentApi(prefix: string, headers: Record<string, string> = {}) {
  const p = (rest: string) => `${prefix}/${rest}`;
  return {
    load: () => call<{ site: SiteInfo; schema: Schema; published: PublishedState }>('GET', p('portfolio'), undefined, 30_000, headers),
    /** Save = publish: validates on the server and commits to the portfolio's repo. */
    publish: (content: Content, baseSha: string) => call<SaveResponse>('POST', p('publish'), { content, baseSha }, 60_000, headers),
    versions: () => call<{ versions: Version[] }>('GET', p('versions'), undefined, 30_000, headers),
    version: (commitSha: string) => call<{ content: Content }>('GET', p(`versions/${commitSha}`), undefined, 30_000, headers),
    restore: (commitSha: string, baseSha: string) => call<SaveResponse>('POST', p('restore'), { commitSha, baseSha }, 60_000, headers),
    upload: (fileName: string, data: string) => call<{ url: string }>('POST', p('upload'), { fileName, data }, 60_000, headers),
  };
}

export type SiteApi = ReturnType<typeof contentApi>;

/** Calls for one portfolio. */
export function siteApi(siteId: string) {
  const prefix = `sites/${encodeURIComponent(siteId)}`;
  return {
    ...contentApi(prefix),
    profiles: () => call<{ profiles: { slug: string; url: string }[] }>('GET', `${prefix}/profiles`),
    deleteProfile: (slug: string) => call<{ deleted: true }>('POST', `${prefix}/delete-profile`, { slug }, 60_000),
  };
}

/* ---------- Self-service profiles (no sign-in) ---------- */

export type Draft = { site: SiteInfo; schema: Schema; content: Content; suggestedSlug: string };
export type Created = { slug: string; token: string; site: SiteInfo; published: PublishedState };

export const publicApi = {
  config: () => call<{ enabled: boolean; hostUrl: string | null; turnstileSiteKey: string | null }>('GET', 'public/config'),
  slugAvailable: (slug: string) => call<{ available: boolean }>('GET', `public/slug/${encodeURIComponent(slug)}`),
  /** Reads a resume into draft content; nothing is saved. */
  parse: (fileName: string, data: string, turnstileToken?: string) => call<Draft>('POST', 'public/parse', { fileName, data, turnstileToken }, 60_000),
  create: (slug: string, content: Content, resume: { fileName: string; data: string } | null, turnstileToken?: string) =>
    call<Created>('POST', 'public/profiles', { slug, content, resume, turnstileToken }, 120_000),
};

/** The owner's calls for one profile, authorized by its secret edit token. */
export function profileApi(slug: string, token: string) {
  const prefix = `public/profiles/${encodeURIComponent(slug)}`;
  const headers = { 'x-profile-token': token };
  return {
    ...contentApi(prefix, headers),
    remove: () => call<{ deleted: true }>('POST', `${prefix}/delete`, {}, 60_000, headers),
  };
}
