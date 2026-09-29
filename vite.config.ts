import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = __dirname;

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

async function sendResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => k !== 'set-cookie' && res.setHeader(k, v));
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * Local development: runs the api/ functions inside the dev server, so `npm run dev` works without
 * the Vercel CLI. Server env vars are loaded into this Node process only; the browser bundle only
 * ever sees VITE_-prefixed variables (this app defines none).
 */
function devApi(mode: string): Plugin {
  return {
    name: 'admin-dev-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      for (const [k, v] of Object.entries(loadEnv(mode, root, ''))) process.env[k] ??= v;
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url ?? '/').split('?')[0];
        const fn = pathname.startsWith('/api/admin') ? '/api/admin.ts' : null;
        if (!fn) return next();
        try {
          const mod = await server.ssrLoadModule(fn);
          const handler = mod[req.method ?? 'GET'];
          if (!handler) {
            res.statusCode = 405;
            return res.end();
          }
          await sendResponse(res, await handler(await toRequest(req)));
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), devApi(mode)],
  server: { port: 5174, strictPort: true },
}));
