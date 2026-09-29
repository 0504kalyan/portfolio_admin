// Packages the admin portal for Vercel using the Build Output API (.vercel/output):
//   static/     the built admin UI (dist/)
//   functions/  api/admin, bundled into one file with esbuild
//   config.json routes and security headers
// Runs after `vite build` (see the "build" script).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.vercel/output');
rmSync(out, { recursive: true, force: true });
cpSync(path.join(root, 'dist'), path.join(out, 'static'), { recursive: true });

// Adapts the Web-standard handlers (export GET/POST(request): Response) to Node's (req, res).
const adapter = (source) => `
import * as handlers from ${JSON.stringify(source)};

export default async function handler(req, res) {
  try {
    const fn = handlers[req.method];
    if (!fn) {
      res.statusCode = 405;
      return res.end();
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const proto = req.headers['x-forwarded-proto'] ?? 'https';
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(proto + '://' + req.headers.host + req.url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
    const response = await fn(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => k !== 'set-cookie' && res.setHeader(k, v));
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error('[api] adapter error', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'server_error', message: 'Something went wrong on the server. Please try again.' } }));
  }
}
`;

for (const name of ['admin']) {
  const dir = path.join(out, 'functions/api', `${name}.func`);
  mkdirSync(dir, { recursive: true });
  await build({
    stdin: { contents: adapter(`./api/${name}.ts`), resolveDir: root, loader: 'js' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: path.join(dir, 'index.mjs'),
    // CommonJS dependencies (e.g. word-extractor) call require() for Node built-ins, which ESM lacks.
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  writeFileSync(
    path.join(dir, '.vc-config.json'),
    JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 30 }, null, 2),
  );
}

const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
};

writeFileSync(
  path.join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/assets/(.*)$', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }, continue: true },
        { src: '^/(.*)$', headers: security, continue: true },
        { handle: 'filesystem' },
        { src: '^/api/admin(?:/(.*))?$', dest: '/api/admin?path=$1' },
        { src: '^/api/.*$', status: 404 },
        { src: '^/(.*)$', dest: '/index.html', headers: { 'Cache-Control': 'no-store' } },
      ],
    },
    null,
    2,
  ),
);
console.log('Vercel build output written to .vercel/output');
