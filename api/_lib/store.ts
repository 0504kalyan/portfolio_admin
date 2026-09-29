// Content storage, one store per portfolio. Production commits to the portfolio's GitHub repository
// (which redeploys it); local development can read and write the portfolio's folder directly.
import { checkSchema, type Content, type Schema } from '../../lib/schema.js';
import { localRoot, useLocalStore, type SiteConfig } from './config.js';
import { ApiError } from './http.js';

export interface Published {
  content: Content;
  /** Git blob SHA of the content file: the version token for optimistic concurrency. */
  sha: string;
  updatedAt: string | null;
}

export interface Version {
  commitSha: string;
  message: string;
  date: string;
  author: string;
}

export interface ContentStore {
  /** The raw content file, its SHA, and the portfolio's schema. */
  load(): Promise<{ raw: unknown; sha: string; updatedAt: string | null; schema: Schema }>;
  /** Commits the content. Throws a 409 ApiError when the file is no longer `baseSha`. */
  publish(content: Content, baseSha: string, message: string): Promise<Published>;
  listVersions(): Promise<Version[]>;
  getVersion(commitSha: string): Promise<unknown>;
  /** Stores a file under the portfolio's public uploads folder and returns its site path (/uploads/…). */
  uploadAsset(fileName: string, bytes: Uint8Array): Promise<string>;
}

export const conflict = () =>
  new ApiError(409, 'conflict', 'The portfolio was changed elsewhere (another tab or device) since you loaded it. Reload the latest content and try again.');

export const serialize = (content: unknown) => `${JSON.stringify(content, null, 2)}\n`;

/** Parses a portfolio's schema.json, turning problems into a clear (non-secret) message. */
export function parseSchema(text: string | null, site: SiteConfig): Schema {
  if (text === null) throw new ApiError(502, 'schema_missing', `${site.name} has no ${site.schemaPath}, so the admin can't tell what to edit.`);
  try {
    return checkSchema(JSON.parse(text));
  } catch (err) {
    console.error(`[api] ${site.id}: bad schema`, err);
    throw new ApiError(502, 'bad_schema', `${site.name}'s ${site.schemaPath} is invalid: ${err instanceof Error ? err.message : 'unreadable'}`);
  }
}

export async function getStore(site: SiteConfig): Promise<ContentStore> {
  if (useLocalStore()) {
    const { LocalStore } = await import('./localStore.js');
    return new LocalStore(site, localRoot(site));
  }
  const { GitHubStore } = await import('./githubStore.js');
  return new GitHubStore(site);
}
