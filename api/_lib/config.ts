// Server-only configuration from environment variables: which portfolios this admin manages, who may
// sign in, and the secrets for both. Nothing here is sent to the browser (no VITE_ prefixes).
import path from 'node:path';
import { ApiError } from './http.js';

const env = (name: string) => process.env[name]?.trim() ?? '';

/* ---------- Sites ---------- */

export interface SiteConfig {
  /** URL-safe key, e.g. "pavan". */
  id: string;
  /** Display name, e.g. "Pavan Kalyan Kama". */
  name: string;
  /**
   * The portfolio this admin talks to: the live one on Vercel (e.g. https://portfolio-of-pavan.vercel.app),
   * or its local dev server (`localUrl`, e.g. http://localhost:5173) when running `npm run dev`.
   */
  url: string;
  /** GitHub "owner/repo" holding the portfolio. */
  repo: string;
  branch: string;
  contentPath: string;
  schemaPath: string;
  uploadDir: string;
  /** Env var holding the GitHub token for this repo (default GITHUB_TOKEN). */
  tokenEnv: string;
  /** Env var holding an optional Vercel deploy hook for this site. */
  deployHookEnv: string;
  /** Local development only: the portfolio's folder, used when CONTENT_STORE=local. */
  localPath: string;
}

const SITE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

let cachedSites: { raw: string; sites: SiteConfig[] } | null = null;

/** Parses SITES (a JSON array). Misconfiguration is logged in detail and reported generically. */
export function sites(): SiteConfig[] {
  const raw = env('SITES');
  if (cachedSites?.raw === raw) return cachedSites.sites;
  const bad = (why: string): never => {
    console.error(`[api] SITES is invalid: ${why}`);
    throw new ApiError(503, 'not_configured', 'The list of portfolios is not configured correctly on the server.');
  };
  let list: unknown;
  try {
    list = JSON.parse(raw || '[]');
  } catch {
    bad('not valid JSON');
  }
  if (!Array.isArray(list) || !list.length) bad('expected a non-empty JSON array');
  const parsed = (list as Record<string, unknown>[]).map((s, i) => {
    const get = (k: string) => (typeof s[k] === 'string' ? (s[k] as string).trim() : '');
    const site: SiteConfig = {
      id: get('id'),
      name: get('name') || get('id'),
      url: (onVercel() ? get('url') : get('localUrl') || get('url')).replace(/\/+$/, ''),
      repo: get('repo'),
      branch: get('branch') || 'main',
      contentPath: get('contentPath') || 'content/portfolio.json',
      schemaPath: get('schemaPath') || 'content/schema.json',
      uploadDir: (get('uploadDir') || 'public/uploads').replace(/\/+$/, ''),
      tokenEnv: get('tokenEnv') || 'GITHUB_TOKEN',
      deployHookEnv: get('deployHookEnv'),
      localPath: get('localPath'),
    };
    if (!SITE_ID.test(site.id)) bad(`site ${i}: id must be lowercase letters, numbers and hyphens`);
    if (!/^https?:\/\//.test(site.url)) bad(`site ${site.id}: url must start with https://`);
    if (onVercel() && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(site.url)) {
      bad(`site ${site.id}: url points at localhost; use the live URL in "url" and put the local one in "localUrl"`);
    }
    if (!useLocalStore() && !REPO.test(site.repo)) bad(`site ${site.id}: repo must look like "owner/name"`);
    return site;
  });
  if (new Set(parsed.map((s) => s.id)).size !== parsed.length) bad('duplicate site ids');
  cachedSites = { raw, sites: parsed };
  return parsed;
}

export function githubToken(site: SiteConfig): string {
  const token = env(site.tokenEnv);
  if (!token) {
    console.error(`[api] ${site.tokenEnv} is not set (needed for site ${site.id})`);
    throw new ApiError(503, 'not_configured', `Content storage for ${site.name} is not configured on the server yet.`);
  }
  return token;
}

export const deployHookUrl = (site: SiteConfig) => (site.deployHookEnv ? env(site.deployHookEnv) : '');

/** True in Vercel deployments (production and preview); false under `npm run dev`. */
export const onVercel = () => Boolean(process.env.VERCEL);

/** Local file storage is for `npm run dev` only and is refused on Vercel. */
export const useLocalStore = () => env('CONTENT_STORE') === 'local' && !onVercel();

export const localRoot = (site: SiteConfig) => {
  if (!site.localPath) throw new ApiError(503, 'not_configured', `Set "localPath" for ${site.name} in SITES to use local storage.`);
  return path.resolve(site.localPath);
};

/* ---------- Users ---------- */

export interface UserConfig {
  username: string;
  passwordHash: string;
  /** Site ids this user may edit; ["*"] means all. */
  sites: string[];
}

/** ADMIN_USERS (JSON array), or the single ADMIN_USERNAME / ADMIN_PASSWORD_HASH account with access to every site. */
export function users(): UserConfig[] {
  const raw = env('ADMIN_USERS');
  if (raw) {
    try {
      const list = JSON.parse(raw) as UserConfig[];
      if (Array.isArray(list) && list.every((u) => u.username && u.passwordHash && Array.isArray(u.sites))) return list;
    } catch {
      /* fall through */
    }
    console.error('[api] ADMIN_USERS is invalid: expected [{"username","passwordHash","sites":[...]}]');
    throw new ApiError(503, 'not_configured', 'Admin sign-in is not configured correctly on the server.');
  }
  const username = env('ADMIN_USERNAME');
  const passwordHash = env('ADMIN_PASSWORD_HASH');
  if (!username || !passwordHash) {
    console.error('[api] admin auth is not configured: set ADMIN_USERS, or ADMIN_USERNAME and ADMIN_PASSWORD_HASH');
    throw new ApiError(503, 'not_configured', 'Admin sign-in is not configured on the server yet.');
  }
  return [{ username, passwordHash, sites: ['*'] }];
}

export function sessionSecret(): string {
  const secret = env('SESSION_SECRET');
  if (secret.length < 32) {
    console.error('[api] SESSION_SECRET must be at least 32 characters');
    throw new ApiError(503, 'not_configured', 'Admin sign-in is not configured on the server yet.');
  }
  return secret;
}

/** The sites a user may edit. */
export const sitesFor = (user: UserConfig) => sites().filter((s) => user.sites.includes('*') || user.sites.includes(s.id));
