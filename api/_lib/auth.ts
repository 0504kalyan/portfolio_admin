// Admin authentication: accounts from env vars (each limited to some portfolios), scrypt password
// hashes, and an HMAC-signed session token in an HttpOnly, SameSite=Strict cookie.
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type BinaryLike, type ScryptOptions } from 'node:crypto';
import { sessionSecret, sites, sitesFor, users, type SiteConfig, type UserConfig } from './config.js';
import { ApiError, clientIp, isHttps } from './http.js';

const SESSION_HOURS = 8;
const COOKIE = 'pf_admin';
const SECURE_COOKIE = `__Host-${COOKIE}`;

const scrypt = (password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

/** Hash format: scrypt:N:r:p:saltHex:hashHex (colons so .env files don't expand it). */
export async function hashPassword(password: string): Promise<string> {
  const [N, r, p] = [16384, 8, 1];
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('hex'), hash.toString('hex')].join(':');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) {
    console.error('[api] a password hash has the wrong format; generate it with `npm run hash-password`');
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}

/** Checked when a username doesn't exist, so response time doesn't reveal valid usernames. */
const DUMMY_HASH = 'scrypt:16384:8:1:00000000000000000000000000000000:' + '0'.repeat(128);

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest('base64url');

/** Short fingerprint of a user's password hash: changing the password signs that user out. */
const passwordVersion = (passwordHash: string, secret: string) => sign(`pv:${passwordHash}`, secret).slice(0, 12);

type Token = { u: string; iat: number; exp: number; pv: string };
export type Session = { username: string; user: UserConfig };

function createToken(user: UserConfig): string {
  const secret = sessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const payload: Token = { u: user.username, iat: now, exp: now + SESSION_HOURS * 3600, pv: passwordVersion(user.passwordHash, secret) };
  const body = `v1.${b64url(JSON.stringify(payload))}`;
  return `${body}.${sign(body, secret)}`;
}

function readToken(token: string): Session | null {
  const secret = sessionSecret();
  const [version, payload, signature] = token.split('.');
  if (version !== 'v1' || !payload || !signature) return null;
  if (!safeEqual(signature, sign(`${version}.${payload}`, secret))) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Token;
    const user = users().find((u) => u.username === t.u);
    if (!user || t.exp <= Date.now() / 1000 || t.pv !== passwordVersion(user.passwordHash, secret)) return null;
    return { username: user.username, user };
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** The signed-in user's session, or null. */
export function getSession(request: Request): Session | null {
  const token = readCookie(request, SECURE_COOKIE) ?? readCookie(request, COOKIE);
  return token ? readToken(token) : null;
}

export function requireSession(request: Request): Session {
  const session = getSession(request);
  if (!session) throw new ApiError(401, 'unauthorized', 'Your session has expired. Please sign in again.');
  return session;
}

/** The site `siteId`, if it exists and this user may edit it. Enforced on every site request. */
export function requireSite(session: Session, siteId: string): SiteConfig {
  const site = sites().find((s) => s.id === siteId);
  if (!site) throw new ApiError(404, 'unknown_site', 'That portfolio is not configured in this admin.');
  if (!sitesFor(session.user).some((s) => s.id === site.id)) throw new ApiError(403, 'forbidden', "You don't have access to this portfolio.");
  return site;
}

/** `__Host-` + Secure on HTTPS (production); a plain cookie on http://localhost for development. */
function cookie(request: Request, value: string, maxAge: number): string {
  const secure = isHttps(request);
  return [`${secure ? SECURE_COOKIE : COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`, ...(secure ? ['Secure'] : [])].join('; ');
}

export const sessionCookie = (request: Request, user: UserConfig) => cookie(request, createToken(user), SESSION_HOURS * 3600);
export const clearedCookie = (request: Request) => cookie(request, '', 0);

/* ---------- Login throttling ----------
 * Best effort: counters live in the function instance's memory, so they reset on cold starts and
 * aren't shared between instances. With the slow hash and the failure delay, online guessing stays
 * impractical. See README → Security.
 */
const WINDOW_MS = 15 * 60 * 1000;
const PER_IP = 5;
const GLOBAL = 30;
const failures = new Map<string, { count: number; since: number }>();

function bucket(key: string) {
  const now = Date.now();
  const b = failures.get(key);
  if (!b || now - b.since > WINDOW_MS) {
    const fresh = { count: 0, since: now };
    failures.set(key, fresh);
    return fresh;
  }
  return b;
}

export async function login(request: Request, username: string, password: string): Promise<UserConfig> {
  const ip = clientIp(request);
  const perIp = bucket(`ip:${ip}`);
  const global = bucket('global');
  if (perIp.count >= PER_IP || global.count >= GLOBAL) {
    throw new ApiError(429, 'rate_limited', 'Too many failed sign-in attempts. Please wait 15 minutes and try again.');
  }
  const user = users().find((u) => safeEqual(u.username, username));
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (user && passwordOk) {
    failures.delete(`ip:${ip}`);
    return user;
  }
  perIp.count++;
  global.count++;
  await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
  throw new ApiError(401, 'invalid_credentials', 'Incorrect username or password.');
}
