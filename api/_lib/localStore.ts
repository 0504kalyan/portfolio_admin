// File-based content store for local development (CONTENT_STORE=local): reads and writes a portfolio's
// folder directly (so its `npm run dev` shows changes at once) and keeps version snapshots in the
// portfolio's git-ignored .cms/ folder. It's refused on Vercel (see config.ts).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Content, Schema } from '../../lib/schema.js';
import type { SiteConfig } from './config.js';
import { ApiError } from './http.js';
import { blobSha, conflict, parseSchema, serialize, type ContentStore, type Published, type RepoFile, type Version } from './store.js';

export class LocalStore implements ContentStore {
  private readonly contentFile: string;
  private readonly schemaFile: string;
  private readonly cmsDir: string;
  private readonly historyDir: string;
  private readonly uploadDir: string;

  constructor(
    private readonly site: SiteConfig,
    private readonly root: string,
  ) {
    this.contentFile = path.join(root, site.contentPath);
    this.schemaFile = path.join(root, site.schemaPath);
    this.cmsDir = path.join(root, '.cms');
    // One history folder per content file, so each profile has its own versions.
    const key = site.contentPath === 'content/portfolio.json' ? 'history' : `history-${site.contentPath.replace(/[^\w.-]+/g, '_')}`;
    this.historyDir = path.join(this.cmsDir, key);
    this.uploadDir = path.join(root, site.uploadDir);
  }

  /** A repo-relative path inside the portfolio's folder; refuses anything that would escape it. */
  private resolve(rel: string) {
    const full = path.resolve(this.root, rel);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new ApiError(400, 'bad_path', 'Invalid file path.');
    return full;
  }

  async readText(rel: string): Promise<string | null> {
    const full = this.resolve(rel);
    return existsSync(full) ? readFile(full, 'utf8') : null;
  }

  async listDir(rel: string): Promise<string[]> {
    const full = this.resolve(rel);
    if (!existsSync(full)) return [];
    return (await readdir(full, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  }

  async commitFiles(files: RepoFile[], message: string): Promise<{ date: string }> {
    const date = new Date().toISOString();
    for (const f of files) {
      const full = this.resolve(f.path);
      if (f.content === null) {
        await rm(full, { force: true });
        continue;
      }
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, f.content);
      if (full === path.resolve(this.contentFile)) {
        await mkdir(this.historyDir, { recursive: true });
        await this.snapshot(Buffer.from(f.content).toString('utf8'), message, date);
      }
    }
    return { date };
  }

  async load(): Promise<{ raw: unknown; sha: string; updatedAt: string | null; schema: Schema }> {
    if (!existsSync(this.contentFile)) throw new ApiError(404, 'not_found', 'That portfolio was not found.');
    const text = await readFile(this.contentFile, 'utf8');
    const schemaText = existsSync(this.schemaFile) ? await readFile(this.schemaFile, 'utf8') : null;
    const versions = await this.listVersions();
    return { raw: JSON.parse(text), sha: blobSha(text), updatedAt: versions[0]?.date ?? null, schema: parseSchema(schemaText, this.site) };
  }

  async publish(content: Content, baseSha: string, message: string): Promise<Published> {
    const current = await readFile(this.contentFile, 'utf8');
    if (blobSha(current) !== baseSha) throw conflict();
    const text = serialize(content);
    const now = new Date().toISOString();
    await mkdir(this.historyDir, { recursive: true });
    if (!(await this.listVersions()).length) {
      // Keep the pre-CMS version so the first publish can be rolled back too.
      await this.snapshot(current, 'Initial content', new Date(Date.now() - 1000).toISOString());
    }
    await writeFile(this.contentFile, text);
    await this.snapshot(text, message, now);
    return { content, sha: blobSha(text), updatedAt: now };
  }

  private async snapshot(text: string, message: string, date: string) {
    const commitSha = createHash('sha1').update(date + text).digest('hex');
    const file = `${date.replace(/[:.]/g, '-')}_${commitSha}.json`;
    await writeFile(path.join(this.historyDir, file), JSON.stringify({ commitSha, message, date, author: 'local', text }));
  }

  private async historyFiles() {
    if (!existsSync(this.historyDir)) return [];
    return (await readdir(this.historyDir)).filter((f) => f.endsWith('.json')).sort().reverse();
  }

  async listVersions(): Promise<Version[]> {
    const files = await this.historyFiles();
    return Promise.all(
      files.map(async (f) => {
        const { commitSha, message, date, author } = JSON.parse(await readFile(path.join(this.historyDir, f), 'utf8'));
        return { commitSha, message, date, author };
      }),
    );
  }

  async getVersion(commitSha: string): Promise<unknown> {
    const file = (await this.historyFiles()).find((f) => f.endsWith(`_${commitSha}.json`));
    if (!file) throw new ApiError(404, 'not_found', 'That version was not found.');
    return JSON.parse(JSON.parse(await readFile(path.join(this.historyDir, file), 'utf8')).text);
  }

  async uploadAsset(fileName: string, bytes: Uint8Array): Promise<string> {
    await mkdir(this.uploadDir, { recursive: true });
    const dot = fileName.lastIndexOf('.');
    for (let n = 1; n < 50; n++) {
      const name = n === 1 ? fileName : `${fileName.slice(0, dot)}-${n}${fileName.slice(dot)}`;
      const target = path.join(this.uploadDir, name);
      if (existsSync(target)) continue;
      await writeFile(target, bytes);
      return `/${this.site.uploadDir.replace(/^public\//, '')}/${name}`;
    }
    throw new ApiError(409, 'upload_conflict', 'Could not choose a file name for the upload. Rename the file and try again.');
  }
}
