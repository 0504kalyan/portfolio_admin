// State for the portfolio being edited. Every save commits the whole content file to that
// portfolio's GitHub repo, which redeploys it; the admin then polls the portfolio's /version.json
// until the saved version is live. There is no separate draft copy.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { validateContent, type Content, type Schema } from '../lib/schema';
import { ApiFailure, siteApi, type PublishedState, type SaveResponse, type SiteApi, type SiteInfo } from './api';

type Busy = null | 'saving' | 'restoring' | 'reloading';
/**
 * checking: first look; deploying: saved, the portfolio is rebuilding; live: portfolio shows the saved
 * version; draft: nothing is published yet (a new profile being reviewed before it's created).
 */
export type LiveState = 'checking' | 'deploying' | 'live' | 'unknown' | 'draft';

interface AdminData {
  site: SiteInfo;
  schema: Schema;
  api: SiteApi;
  /** Draft mode: saves only change this page's copy; nothing is sent to the server. */
  draft: boolean;
  published: PublishedState;
  content: Content;
  busy: Busy;
  conflict: boolean;
  live: LiveState;
  /** Applies `fn` to the current content, validates it and commits it. Throws ApiFailure on error. */
  save: (fn: (c: Content) => Content) => Promise<SaveResponse>;
  restore: (commitSha: string) => Promise<SaveResponse>;
  reload: () => Promise<void>;
}

const Ctx = createContext<AdminData | null>(null);
export const useAdmin = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAdmin outside AdminDataProvider');
  return v;
};

const POLL_MS = 5000;
const GIVE_UP_MS = 10 * 60 * 1000;

/** Watches the portfolio's /version.json (or a profile's version file) until it reports `sha`. */
function useLiveStatus(versionUrl: string | null, sha: string) {
  const [live, setLive] = useState<LiveState>(versionUrl ? 'checking' : 'draft');

  useEffect(() => {
    if (!versionUrl) return setLive('draft');
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    setLive('checking');
    const check = async () => {
      try {
        const res = await fetch(`${versionUrl}?t=${Date.now()}`, { cache: 'no-store' });
        const { contentSha } = (await res.json()) as { contentSha?: string };
        if (stopped) return;
        if (contentSha === sha) return setLive('live');
        setLive('deploying');
      } catch {
        // Unreachable, or an older build without /version.json. Keep trying while a deploy may be running.
        if (stopped) return;
        setLive((s) => (s === 'deploying' ? s : 'unknown'));
      }
      if (Date.now() - started > GIVE_UP_MS) return setLive('unknown');
      timer = setTimeout(check, POLL_MS);
    };
    check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [versionUrl, sha]);

  return live;
}

export function AdminDataProvider({
  site,
  schema,
  initial,
  api: customApi,
  draft = false,
  onChange,
  children,
}: Readonly<{
  site: SiteInfo;
  schema: Schema;
  initial: PublishedState;
  /** Profiles: the owner's API instead of the signed-in admin's. */
  api?: SiteApi;
  draft?: boolean;
  /** Called with the content after every save (drafts keep a local copy with it). */
  onChange?: (content: Content) => void;
  children: ReactNode;
}>) {
  const [api] = useState(() => customApi ?? siteApi(site.id));
  const [published, setPublished] = useState(initial);
  const [busy, setBusy] = useState<Busy>(null);
  const [conflict, setConflict] = useState(false);
  const busyRef = useRef<Busy>(null);
  const publishedRef = useRef(published);
  publishedRef.current = published;
  const live = useLiveStatus(draft ? null : (site.versionUrl ?? `${site.url}/version.json`), published.sha);

  /** One action at a time, so double clicks can't save twice. */
  const run = useCallback(async <T,>(kind: Exclude<Busy, null>, fn: () => Promise<T>): Promise<T> => {
    if (busyRef.current) throw new ApiFailure(0, 'busy', 'Another save is still in progress. Please wait a moment.');
    busyRef.current = kind;
    setBusy(kind);
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'conflict') setConflict(true);
      throw err;
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, []);

  const value: AdminData = {
    site,
    schema,
    api,
    draft,
    published,
    content: published.content,
    busy,
    conflict,
    live,
    save: (fn) =>
      run('saving', async () => {
        const base = publishedRef.current;
        const next = fn(base.content);
        let issues = validateContent(schema, next);
        if (draft) {
          // A draft read from a resume can start with problems; only block the ones this save adds, so
          // they can be fixed one form at a time. Publishing checks everything.
          const before = new Set(validateContent(schema, base.content).map((i) => `${i.path}:${i.message}`));
          issues = issues.filter((i) => !before.has(`${i.path}:${i.message}`));
        }
        if (issues.length) throw new ApiFailure(422, 'invalid_content', `Can't save: ${issues[0].message} (${issues[0].path})`, issues);
        if (draft) {
          setPublished({ ...base, content: next });
          onChange?.(next);
          return { published: { ...base, content: next }, changes: [], deployment: 'none' as const };
        }
        const res = await api.publish(next, base.sha);
        setPublished(res.published);
        onChange?.(res.published.content);
        return res;
      }),
    restore: (commitSha) =>
      run('restoring', async () => {
        const res = await api.restore(commitSha, publishedRef.current.sha);
        setPublished(res.published);
        return res;
      }),
    reload: () =>
      run('reloading', async () => {
        setPublished((await api.load()).published);
        setConflict(false);
      }),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
