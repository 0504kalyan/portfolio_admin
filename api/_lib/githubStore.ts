// GitHub-backed content store for one portfolio, using the REST contents API with a server-side
// token. The content file lives on the portfolio's production branch; a commit there redeploys it.
import type { Content, Schema } from '../../lib/schema.js';
import { githubToken, type SiteConfig } from './config.js';
import { ApiError } from './http.js';
import { conflict, parseSchema, serialize, type ContentStore, type Published, type Version } from './store.js';

type FileResponse = { sha: string; content?: string; encoding?: string; size: number };

const storageError = () => new ApiError(502, 'storage_error', 'Could not reach content storage (GitHub). Please try again in a moment.');

export class GitHubStore implements ContentStore {
  private readonly token: string;

  constructor(private readonly cfg: SiteConfig) {
    this.token = githubToken(cfg);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
    let res: Response;
    try {
      res = await fetch(`https://api.github.com/repos/${this.cfg.repo}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'portfolio-admin',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      console.error(`[github] ${this.cfg.repo} ${method} ${path} failed`, err);
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new ApiError(504, 'timeout', 'Content storage (GitHub) took too long to respond. Please try again.');
      }
      throw storageError();
    }
    const data = res.status === 204 ? null : ((await res.json().catch(() => null)) as T | null);
    if (res.ok || res.status === 404 || res.status === 409 || res.status === 422) return { status: res.status, data };
    // Log GitHub's response for debugging; the browser only gets a generic message.
    console.error(`[github] ${this.cfg.repo} ${method} ${path} → ${res.status}`, data);
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(502, 'storage_auth', 'The server could not access content storage. Check the GitHub token configuration.');
    }
    throw storageError();
  }

  private contentsPath(path: string, ref?: string) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return `/contents/${encoded}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
  }

  /** File text and blob SHA at `ref`, or null if it doesn't exist. */
  private async readFile(path: string, ref: string): Promise<{ text: string; sha: string } | null> {
    const { status, data } = await this.request<FileResponse>('GET', this.contentsPath(path, ref));
    if (status === 404 || !data) return null;
    let base64 = data.content ?? '';
    if (!base64 && data.size > 0) {
      // Files over 1 MB come back without content; fetch the blob instead.
      const blob = await this.request<{ content: string }>('GET', `/git/blobs/${data.sha}`);
      base64 = blob.data?.content ?? '';
    }
    return { text: Buffer.from(base64, 'base64').toString('utf8'), sha: data.sha };
  }

  private async writeFile(path: string, text: string | Uint8Array, message: string, branch: string, sha?: string) {
    const content = Buffer.from(text).toString('base64');
    const { status, data } = await this.request<{ content: { sha: string }; commit: { sha: string; committer?: { date?: string } } }>(
      'PUT',
      this.contentsPath(path),
      { message, content, branch, ...(sha ? { sha } : {}) },
    );
    // 409, or 422 about the sha: the file changed since `sha` (a version conflict).
    const reason = String((data as { message?: string } | null)?.message ?? '');
    if (status === 409 || (status === 422 && /sha/i.test(reason))) return null;
    if (status === 422 || !data) {
      // e.g. branch protection that requires pull requests on the production branch.
      console.error(`[github] PUT ${path} on ${branch} rejected: ${reason}`);
      throw new ApiError(502, 'storage_rejected', 'GitHub rejected the commit. Check that the token can push to the branch (branch protection may block it).');
    }
    return data;
  }

  async load(): Promise<{ raw: unknown; sha: string; updatedAt: string | null; schema: Schema }> {
    const [file, schemaFile, commits] = await Promise.all([
      this.readFile(this.cfg.contentPath, this.cfg.branch),
      this.readFile(this.cfg.schemaPath, this.cfg.branch),
      this.request<{ commit: { committer: { date: string } } }[]>(
        'GET',
        `/commits?path=${encodeURIComponent(this.cfg.contentPath)}&sha=${encodeURIComponent(this.cfg.branch)}&per_page=1`,
      ),
    ]);
    if (!file) {
      console.error(`[github] ${this.cfg.repo}: ${this.cfg.contentPath} not found on ${this.cfg.branch}`);
      throw new ApiError(502, 'storage_missing', `${this.cfg.name}'s content file was not found in its repository.`);
    }
    return {
      raw: JSON.parse(file.text),
      sha: file.sha,
      updatedAt: commits.data?.[0]?.commit.committer.date ?? null,
      schema: parseSchema(schemaFile?.text ?? null, this.cfg),
    };
  }

  async publish(content: Content, baseSha: string, message: string): Promise<Published> {
    // The contents API rejects the write if the file's SHA isn't `baseSha`, so a concurrent
    // publish can never be silently overwritten, even between our check and the commit.
    const result = await this.writeFile(this.cfg.contentPath, serialize(content), message, this.cfg.branch, baseSha);
    if (!result) throw conflict();
    return { content, sha: result.content.sha, updatedAt: result.commit.committer?.date ?? new Date().toISOString() };
  }

  async listVersions(): Promise<Version[]> {
    const { data } = await this.request<{ sha: string; commit: { message: string; author: { name: string; date: string } } }[]>(
      'GET',
      `/commits?path=${encodeURIComponent(this.cfg.contentPath)}&sha=${encodeURIComponent(this.cfg.branch)}&per_page=50`,
    );
    return (data ?? []).map((c) => ({ commitSha: c.sha, message: c.commit.message, date: c.commit.author.date, author: c.commit.author.name }));
  }

  async getVersion(commitSha: string): Promise<unknown> {
    const file = await this.readFile(this.cfg.contentPath, commitSha);
    if (!file) throw new ApiError(404, 'not_found', 'That version does not contain portfolio content.');
    return JSON.parse(file.text);
  }

  async uploadAsset(fileName: string, bytes: Uint8Array): Promise<string> {
    const dot = fileName.lastIndexOf('.');
    const [stem, ext] = [fileName.slice(0, dot), fileName.slice(dot)];
    for (let n = 1; n < 50; n++) {
      const name = n === 1 ? fileName : `${stem}-${n}${ext}`;
      const path = `${this.cfg.uploadDir}/${name}`;
      if (await this.readFile(path, this.cfg.branch)) continue;
      const result = await this.writeFile(path, bytes, `Upload asset: ${name}`, this.cfg.branch);
      if (result) return `/${path.replace(/^public\//, '')}`;
    }
    throw new ApiError(409, 'upload_conflict', 'Could not choose a file name for the upload. Rename the file and try again.');
  }
}
