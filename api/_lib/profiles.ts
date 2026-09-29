// Self-service profiles: anyone can upload a resume and publish a portfolio at <host>/p/<slug>, served
// by the host portfolio's existing deployment. Each profile is one content file in the host's repo
// (content/profiles/<slug>.json), edited with the same schema as the host. There are no accounts: the
// creator gets a secret edit link, and only a SHA-256 of its token is stored (content/profiles/<slug>.owner.json).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { profileHost, turnstile, type SiteConfig } from './config.js';
import { ApiError, clientIp } from './http.js';
import { getStore } from './store.js';

export const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const RESERVED = new Set(['admin', 'api', 'assets', 'uploads', 'profiles', 'preview', 'edit', 'start', 'new', 'www', 'p', 'r', 'works', 'about-me', 'contacts']);

export function requireHost(): SiteConfig {
  const host = profileHost();
  if (!host) throw new ApiError(404, 'profiles_disabled', 'Creating portfolios is not enabled on this server.');
  return host;
}

export function checkSlug(slug: string): string {
  if (!SLUG.test(slug) || slug.includes('--')) {
    throw new ApiError(400, 'bad_slug', 'Use 3–40 lowercase letters, numbers and single hyphens, starting and ending with a letter or number.');
  }
  if (RESERVED.has(slug)) throw new ApiError(409, 'slug_taken', 'That address is reserved. Please choose another.');
  return slug;
}

const ownerPath = (host: SiteConfig, slug: string) => `${host.profilesDir}/${slug}.owner.json`;
export const profileUploadDir = (slug: string) => `public/uploads/profiles/${slug}`;

/** A profile as a site of its own: same repo, schema and preview as the host, its own content file and uploads. */
export function profileSite(host: SiteConfig, slug: string): SiteConfig {
  return {
    ...host,
    id: slug,
    name: slug,
    contentPath: `${host.profilesDir}/${slug}.json`,
    uploadDir: profileUploadDir(slug),
    profiles: false,
    liveUrl: `${host.url}/p/${slug}`,
    versionUrl: `${host.url}/profiles/${slug}.json`,
  };
}

export async function slugTaken(host: SiteConfig, slug: string): Promise<boolean> {
  const store = await getStore(host);
  const [owner, content] = await Promise.all([store.readText(ownerPath(host, slug)), store.readText(`${host.profilesDir}/${slug}.json`)]);
  return owner !== null || content !== null;
}

/* ---------- Edit tokens ---------- */

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** A new secret edit token and the owner file that stores only its hash. */
export function newOwner(host: SiteConfig, slug: string) {
  const token = randomBytes(32).toString('base64url');
  return { token, file: { path: ownerPath(host, slug), content: `${JSON.stringify({ tokenHash: hashToken(token), createdAt: new Date().toISOString() }, null, 2)}\n` } };
}

/** The profile's site config when `token` is its edit token; 403 otherwise (same answer for unknown profiles). */
export async function requireOwner(request: Request, slug: string): Promise<SiteConfig> {
  const host = requireHost();
  const token = request.headers.get('x-profile-token') ?? '';
  const denied = new ApiError(403, 'bad_token', 'This edit link is not valid. Use the full link you received when you created the portfolio.');
  if (!SLUG.test(slug) || token.length < 20 || token.length > 100) throw denied;
  limit(`owner:${clientIp(request)}`, 60, 15 * 60_000, 'Too many attempts. Please wait a few minutes.');
  const text = await (await getStore(host)).readText(ownerPath(host, slug));
  let stored = '';
  try {
    stored = text ? String(JSON.parse(text).tokenHash ?? '') : '';
  } catch {
    /* treated as missing */
  }
  const actual = Buffer.from(hashToken(token));
  if (stored.length !== actual.length || !timingSafeEqual(actual, Buffer.from(stored))) throw denied;
  return profileSite(host, slug);
}

/** Every file that belongs to a profile, for deleting it. */
export async function profileFiles(host: SiteConfig, slug: string): Promise<string[]> {
  const store = await getStore(host);
  const uploads = await store.listDir(profileUploadDir(slug));
  return [`${host.profilesDir}/${slug}.json`, ownerPath(host, slug), ...uploads.map((n) => `${profileUploadDir(slug)}/${n}`)];
}

/** Slugs of every profile, from the content folder. */
export async function listProfiles(host: SiteConfig): Promise<string[]> {
  const names = await (await getStore(host)).listDir(host.profilesDir);
  return names.filter((n) => n.endsWith('.json') && !n.endsWith('.owner.json')).map((n) => n.slice(0, -5));
}

/* ---------- Abuse limits ----------
 * Best effort, like the sign-in throttle: counters live in the function instance's memory. Reading a
 * resume costs money, so there is also a global cap, and Turnstile can be required (TURNSTILE_SECRET_KEY).
 */
const buckets = new Map<string, { count: number; since: number }>();

export function limit(key: string, max: number, windowMs: number, message: string) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.since > windowMs) {
    b = { count: 0, since: now };
    buckets.set(key, b);
  }
  if (b.count >= max) throw new ApiError(429, 'rate_limited', message);
  b.count++;
}

/** Throws unless the Turnstile check passed (only when a secret is configured). */
export async function verifyHuman(request: Request, token: unknown) {
  const { secret } = turnstile();
  if (!secret) return;
  if (typeof token !== 'string' || !token || token.length > 4096) throw new ApiError(400, 'human_check', 'Please complete the security check and try again.');
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token, remoteip: clientIp(request) }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { success?: boolean };
    if (data.success) return;
  } catch (err) {
    console.error('[api] turnstile verification failed', err);
  }
  throw new ApiError(400, 'human_check', 'The security check failed. Please try again.');
}
