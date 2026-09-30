// Portfolio admin API. One function serves every /api/admin/* route (see scripts/build-vercel.mjs).
// It manages several portfolios ("sites"); each site's routes check that the signed-in user may
// edit it. Saving validates against the portfolio's own content/schema.json and commits the content
// file to its GitHub repo, which redeploys that portfolio.
// /api/admin/public/* is the self-service part: anyone can turn a resume into a profile on the host
// portfolio (/p/<slug>), and edit it later with the secret link they get (see _lib/profiles.ts).
import { commitMessage, describeChanges, getPath, normalizeContent, setPath, slugify, validateContent, type Content, type Schema } from '../lib/schema.js';
import { clearedCookie, getSession, login, requireSession, requireSite, sessionCookie } from './_lib/auth.js';
import { deployHookUrl, sitesFor, turnstile, profileHost, type SiteConfig } from './_lib/config.js';
import { ApiError, assertSameOrigin, clientIp, errorResponse, json, readJson } from './_lib/http.js';
import {
  checkSlug,
  limit,
  listProfiles,
  newOwner,
  profileFiles,
  profileSite,
  profileUploadDir,
  requireHost,
  requireOwner,
  slugTaken,
  verifyHuman,
} from './_lib/profiles.js';
import { readResume } from './_lib/resume.js';
import { blobSha, conflict, getStore, serialize, type RepoFile } from './_lib/store.js';

const MAX_JSON = 1024 * 1024; // content is well under 100 KB; 1 MB leaves plenty of room
const MAX_UPLOAD = 4 * 1024 * 1024; // Vercel caps request bodies at 4.5 MB
const MAX_FILE = 3 * 1024 * 1024; // decoded file size (base64 adds ~33%)
const MAX_CREATE = 4.4 * 1024 * 1024; // content plus the resume file, under Vercel's 4.5 MB cap
const HOUR = 60 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;

type Body = Record<string, unknown>;
type Handler = (request: Request, params: string[]) => Promise<Response>;

/** Normalizes submitted content with the site's schema. Throws 422 with every issue when it isn't valid. */
function validContent(schema: Schema, raw: unknown) {
  const content = normalizeContent(schema, raw);
  const issues = validateContent(schema, content);
  if (issues.length) throw new ApiError(422, 'invalid_content', 'Some content is invalid. Fix the highlighted fields and try again.', { issues });
  return content;
}

function requireSha(value: unknown, what: string): string {
  if (typeof value !== 'string' || !SHA.test(value)) throw new ApiError(400, 'bad_request', `Missing or invalid ${what}.`);
  return value;
}

async function triggerDeploy(site: SiteConfig): Promise<'git' | 'hook' | 'hook_failed'> {
  const hook = deployHookUrl(site);
  if (!hook) return 'git'; // Vercel's Git integration deploys the new commit by itself
  try {
    const res = await fetch(hook, { method: 'POST', signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`deploy hook returned ${res.status}`);
    return 'hook';
  } catch (err) {
    console.error(`[api] ${site.id}: deploy hook failed`, err);
    return 'hook_failed';
  }
}

const publicSite = (s: SiteConfig) => ({ id: s.id, name: s.name, url: s.url, liveUrl: s.liveUrl, versionUrl: s.versionUrl, hostsProfiles: s.profiles || undefined });

/* ---------- Uploads ---------- */

const UPLOAD_TYPES: Record<string, (b: Uint8Array) => boolean> = {
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8,
  '.jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  '.png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  '.webp': (b) => String.fromCharCode(...b.slice(8, 12)) === 'WEBP',
  '.gif': (b) => String.fromCharCode(...b.slice(0, 3)) === 'GIF',
  '.pdf': (b) => String.fromCharCode(...b.slice(0, 4)) === '%PDF',
  // .docx is a zip archive; .doc an OLE compound file
  '.docx': (b) => b[0] === 0x50 && b[1] === 0x4b,
  '.doc': (b) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0,
};

function safeFileName(name: string): string {
  const clean = name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .toLowerCase()
    .slice(-80);
  const ext = clean.slice(clean.lastIndexOf('.'));
  if (!clean.includes('.') || !UPLOAD_TYPES[ext]) {
    throw new ApiError(400, 'bad_file_type', 'Upload a JPG, PNG, WebP or GIF image, or a PDF, DOC or DOCX document.');
  }
  return clean;
}

/** A base64 file from a request body, size- and signature-checked. */
function decodeFile(fileName: unknown, data: unknown): { name: string; bytes: Uint8Array } {
  const name = safeFileName(typeof fileName === 'string' ? fileName : '');
  const bytes = new Uint8Array(Buffer.from(typeof data === 'string' ? data : '', 'base64'));
  if (!bytes.length) throw new ApiError(400, 'bad_request', 'The file is empty.');
  if (bytes.length > MAX_FILE) throw new ApiError(413, 'too_large', 'Files must be 3 MB or smaller.');
  if (!UPLOAD_TYPES[name.slice(name.lastIndexOf('.'))](bytes)) throw new ApiError(400, 'bad_file_type', "The file's contents don't match its extension.");
  return { name, bytes };
}

/** The first field of an object section matching `pick` (e.g. the CV field), as a content path. */
function findField(schema: Schema, pick: (f: { name: string; type: string; accept?: string }) => boolean): string | null {
  for (const [key, sec] of Object.entries(schema.sections)) {
    if (sec.type !== 'object') continue;
    const f = sec.fields.find(pick);
    if (f) return `${key}.${f.name}`;
  }
  return null;
}

/* ---------- Self-service profiles (public) ---------- */

const publicRoutes: Record<string, Handler> = {
  'GET config': async () => {
    const host = profileHost();
    return json({ enabled: Boolean(host), hostUrl: host?.url ?? null, turnstileSiteKey: turnstile().siteKey || null });
  },

  /** Is <host>/p/<slug> free? */
  'GET slug': async (_request, [slug = '']) => {
    const host = requireHost();
    checkSlug(slug);
    return json({ available: !(await slugTaken(host, slug)) });
  },

  /** Reads a resume into draft content. Nothing is saved. */
  'POST parse': async (request) => {
    assertSameOrigin(request);
    const host = requireHost();
    limit(`parse:${clientIp(request)}`, 20, HOUR, 'You have read several resumes in the last hour. Please try again later.');
    const body = await readJson<Body>(request, MAX_UPLOAD);
    await verifyHuman(request, body.turnstileToken);
    const file = decodeFile(body.fileName, body.data);
    if (!/\.(pdf|docx?)$/.test(file.name)) throw new ApiError(400, 'bad_file_type', 'Upload your resume as a PDF, DOC or DOCX file.');
    const { schema } = await (await getStore(host)).load();
    const content = await readResume(schema, file.name, file.bytes);

    // Suggest a free address from the person's name.
    const namePath = findField(schema, (f) => f.name === 'name');
    const base = slugify(String((namePath && getPath(content, namePath)) || 'my-portfolio')).slice(0, 36).replace(/-+$/, '') || 'my-portfolio';
    let suggestedSlug = base.length >= 3 ? base : `${base}-portfolio`;
    for (let n = 2; n < 6 && (await slugTaken(host, suggestedSlug)); n++) suggestedSlug = `${base}-${n}`;

    return json({ site: { id: 'draft', name: 'Your portfolio', url: host.url }, schema, content, suggestedSlug });
  },

  /** Publishes a new profile in one commit: content, owner file and (optionally) the resume as the CV. */
  'POST profiles': async (request) => {
    assertSameOrigin(request);
    const host = requireHost();
    limit(`create:${clientIp(request)}`, 5, HOUR, 'You have created several portfolios in the last hour. Please try again later.');
    limit('create:all', 200, 24 * HOUR, 'Too many portfolios were created today. Please try again tomorrow.');
    const body = await readJson<Body>(request, MAX_CREATE);
    await verifyHuman(request, body.turnstileToken);
    const slug = checkSlug(typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '');
    if (await slugTaken(host, slug)) throw new ApiError(409, 'slug_taken', 'That address is already taken. Please choose another.');
    const site = profileSite(host, slug);
    const hostStore = await getStore(host);
    const { schema } = await hostStore.load();

    let draft: Content = normalizeContent(schema, body.content);
    const files: RepoFile[] = [];
    const resume = body.resume as Body | undefined;
    if (resume && typeof resume === 'object') {
      const file = decodeFile(resume.fileName, resume.data);
      const path = `${profileUploadDir(slug)}/${file.name}`;
      files.push({ path, content: file.bytes });
      const cvPath = findField(schema, (f) => f.type === 'asset' && f.accept === 'document');
      if (cvPath && !getPath(draft, cvPath)) draft = setPath(draft, cvPath, `/${path.replace(/^public\//, '')}`);
    }
    const content = validContent(schema, draft);
    const text = serialize(content);
    const owner = newOwner(host, slug);
    files.push({ path: site.contentPath, content: text }, owner.file);
    const { date } = await hostStore.commitFiles(files, `Create profile: ${slug}`);
    return json({
      slug,
      token: owner.token,
      site: publicSite(site),
      published: { content, sha: blobSha(text), updatedAt: date },
      deployment: await triggerDeploy(host),
    });
  },
};

/** /public/profiles/:slug/… for the profile's owner (edit token): the same routes as a site, plus delete. */
async function ownerRoute(request: Request, slug: string, action: string, params: string[]): Promise<Response> {
  const site = await requireOwner(request, slug);
  if (request.method === 'POST' && action === 'delete') {
    assertSameOrigin(request);
    const host = requireHost();
    const files = await profileFiles(host, slug);
    await (await getStore(host)).commitFiles(files.map((path) => ({ path, content: null })), `Delete profile: ${slug}`);
    return json({ deleted: true, deployment: await triggerDeploy(host) });
  }
  const handler = siteRoutes[`${request.method} ${action}`];
  if (!handler) throw new ApiError(404, 'not_found', 'Unknown admin endpoint.');
  return handler(request, site, params);
}

/* ---------- Routes ---------- */

const routes: Record<string, Handler> = {
  'GET session': async (request) => {
    const session = getSession(request);
    return json({
      authenticated: Boolean(session),
      username: session?.username ?? null,
      sites: session ? sitesFor(session.user).map(publicSite) : [],
    });
  },

  'POST login': async (request) => {
    assertSameOrigin(request);
    const body = await readJson<Body>(request, 4096);
    const username = typeof body.username === 'string' ? body.username.slice(0, 200) : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, 500) : '';
    if (!username || !password) throw new ApiError(400, 'bad_request', 'Enter your username and password.');
    const user = await login(request, username, password);
    return json({ authenticated: true, username: user.username }, { headers: { 'Set-Cookie': sessionCookie(request, user) } });
  },

  'POST logout': async (request) => {
    assertSameOrigin(request);
    return json({ authenticated: false }, { headers: { 'Set-Cookie': clearedCookie(request) } });
  },
};

/** Routes under /api/admin/sites/:site/…, run after the session and site access are checked. */
const siteRoutes: Record<string, (request: Request, site: SiteConfig, params: string[]) => Promise<Response>> = {
  /** The site's schema, current content and version token. */
  'GET portfolio': async (_request, site) => {
    const { raw, sha, updatedAt, schema } = await (await getStore(site)).load();
    return json({ site: publicSite(site), schema, published: { content: normalizeContent(schema, raw), sha, updatedAt } });
  },

  /** Save: validate against the site's schema, then commit to its repo (the portfolio redeploys). */
  'POST publish': async (request, site) => {
    assertSameOrigin(request);
    const body = await readJson<Body>(request, MAX_JSON);
    const baseSha = requireSha(body.baseSha, 'base version');
    const store = await getStore(site);
    const current = await store.load();
    const content = validContent(current.schema, body.content);
    if (current.sha !== baseSha) throw conflict();
    const previous = normalizeContent(current.schema, current.raw);
    const changes = describeChanges(current.schema, previous, content);
    if (!changes.length) {
      return json({ published: { content: previous, sha: current.sha, updatedAt: current.updatedAt }, changes, deployment: 'none', unchanged: true });
    }
    const published = await store.publish(content, baseSha, commitMessage(changes));
    return json({ published, changes, deployment: await triggerDeploy(site) });
  },

  'GET versions': async (_request, site, [sha]) => {
    const store = await getStore(site);
    if (sha) {
      const [{ schema }, raw] = await Promise.all([store.load(), store.getVersion(requireSha(sha, 'version'))]);
      return json({ content: normalizeContent(schema, raw) });
    }
    return json({ versions: await store.listVersions() });
  },

  /** Restores an old version by committing its content as a new version; history is never rewritten. */
  'POST restore': async (request, site) => {
    assertSameOrigin(request);
    const body = await readJson<Body>(request, 4096);
    const commitSha = requireSha(body.commitSha, 'version');
    const baseSha = requireSha(body.baseSha, 'base version');
    const store = await getStore(site);
    const [current, versions] = await Promise.all([store.load(), store.listVersions()]);
    if (current.sha !== baseSha) throw conflict();
    const version = versions.find((v) => v.commitSha === commitSha);
    const content = validContent(current.schema, await store.getVersion(commitSha));
    const previous = normalizeContent(current.schema, current.raw);
    const changes = describeChanges(current.schema, previous, content);
    if (!changes.length) {
      return json({ published: { content: previous, sha: current.sha, updatedAt: current.updatedAt }, changes, deployment: 'none', unchanged: true });
    }
    const date = version ? new Date(version.date).toISOString().slice(0, 10) : 'an earlier date';
    const published = await store.publish(content, baseSha, commitMessage(changes, `Restore version from ${date} (${commitSha.slice(0, 7)})`));
    return json({ published, changes, deployment: await triggerDeploy(site) });
  },

  'POST upload': async (request, site) => {
    assertSameOrigin(request);
    const body = await readJson<Body>(request, MAX_UPLOAD);
    const { name, bytes } = decodeFile(body.fileName, body.data);
    return json({ url: await (await getStore(site)).uploadAsset(name, bytes) });
  },

  /** Self-service profiles hosted by this portfolio (moderation). */
  'GET profiles': async (_request, site) => {
    if (!site.profiles) return json({ profiles: [] });
    const slugs = await listProfiles(site);
    return json({ profiles: slugs.map((slug) => ({ slug, url: `${site.url}/p/${slug}` })) });
  },

  'POST delete-profile': async (request, site) => {
    assertSameOrigin(request);
    if (!site.profiles) throw new ApiError(404, 'not_found', 'This portfolio does not host profiles.');
    const body = await readJson<Body>(request, 4096);
    const slug = checkSlug(typeof body.slug === 'string' ? body.slug : '');
    const files = await profileFiles(site, slug);
    await (await getStore(site)).commitFiles(files.map((path) => ({ path, content: null })), `Delete profile: ${slug} (by admin)`);
    return json({ deleted: true, deployment: await triggerDeploy(site) });
  },
};

/** "/api/admin/sites/pavan/versions/abc" → ["sites", "pavan", "versions", "abc"]; also accepts ?path=. */
function routeSegments(request: Request): string[] {
  const url = new URL(request.url);
  const fromPath = url.pathname.replace(/^\/api\/admin\/?/, '');
  const raw = fromPath && fromPath !== url.pathname ? fromPath : (url.searchParams.get('path') ?? '');
  return raw.split('/').filter(Boolean).map(decodeURIComponent);
}

async function handle(request: Request): Promise<Response> {
  try {
    const segments = routeSegments(request);
    if (segments[0] === 'public') {
      if (segments[1] === 'profiles' && segments.length >= 4) return await ownerRoute(request, segments[2], segments[3], segments.slice(4));
      const handler = publicRoutes[`${request.method} ${segments[1]}`];
      if (handler) return await handler(request, segments.slice(2));
    } else if (segments[0] === 'sites' && segments.length >= 3) {
      const site = requireSite(requireSession(request), segments[1]);
      const handler = siteRoutes[`${request.method} ${segments[2]}`];
      if (handler) return await handler(request, site, segments.slice(3));
    } else {
      const handler = routes[`${request.method} ${segments.join('/')}`];
      if (handler) return await handler(request, []);
    }
    throw new ApiError(404, 'not_found', 'Unknown admin endpoint.');
  } catch (err) {
    return errorResponse(err);
  }
}

export const GET = handle;
export const POST = handle;
