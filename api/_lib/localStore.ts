// File-based content store for local development (CONTENT_STORE=local): reads and writes a portfolio's
// folder directly (so its `npm run dev` shows changes at once) and keeps version snapshots in the
// portfolio's git-ignored .cms/ folder. It's refused on Vercel (see config.ts).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Content, Schema } from '../../lib/schema.js';
import type { SiteConfig } from './config.js';
import { ApiError } from './http.js';
import { conflict, parseSchema, serialize, type ContentStore, type Published, type Version } from './store.js';

/** Same algorithm as a git blob SHA, so local and GitHub version tokens behave alike. */
const blobSha = (text: string) => {
  const bytes = Buffer.from(text);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};

export class LocalStore implements ContentStore {
  private readonly contentFile: string;
  private readonly schemaFile: string;
  private readonly cmsDir: string;
  private readonly historyDir: string;
  private readonly uploadDir: string;

  constructor(
    private readonly site: SiteConfig,
    root: string,
  ) {
    this.contentFile = path.join(root, site.contentPath);
    this.schemaFile = path.join(root, site.schemaPath);
    this.cmsDir = path.join(root, '.cms');
    this.historyDir = path.join(this.cmsDir, 'history');
    this.uploadDir = path.join(root, site.uploadDir);
  }

  async load(): Promise<{ raw: unknown; sha: string; updatedAt: string | null; schema: Schema }> {
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
