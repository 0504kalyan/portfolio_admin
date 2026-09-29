// Self-service portfolios, no account needed:
//   /start          upload a resume (PDF, DOC, DOCX); it's read into draft content with suggested job roles
//   /start/review   check and edit the draft with the regular editor screens, then publish it
//   /edit/:slug     the owner edits the published portfolio with the secret link from publishing
// A published profile lives on the host portfolio's deployment at <host>/p/<slug>, one URL per role.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createBrowserRouter, Link, Navigate, Outlet, RouterProvider, useNavigate, useParams } from 'react-router-dom';
import { validateContent, type BaseItem, type Content } from '../lib/schema';
import { ApiFailure, profileApi, publicApi, type Created, type Draft, type PublishedState, type SiteInfo } from './api';
import { readAsBase64 } from './forms';
import { Layout } from './Layout';
import { SchemaPage } from './pages';
import { AdminDataProvider, useAdmin } from './store';
import { Banner, Button, Dialog, Spinner, TextField, useConfirm, useToast } from './ui';
import { VersionsPage } from './versions';

const MAX_BYTES = 3 * 1024 * 1024;
const RESUME_ACCEPT = '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const errorText = (err: unknown, fallback: string) => (err instanceof ApiFailure ? err.message : fallback);

/* ---------- Browser storage (best effort: private windows may refuse it) ---------- */

const store = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* the page still works; the draft just won't survive a reload */
    }
  },
  remove: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

const DRAFT_KEY = 'pf-draft';
const tokenKey = (slug: string) => `pf-edit:${slug}`;

/** The uploaded resume, kept in memory so it can become the CV on publish (too big for storage). */
let resumeFile: { fileName: string; data: string } | null = null;

function loadDraft(): Draft | null {
  try {
    const raw = store.get(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

/* ---------- Turnstile (only when the server has a site key) ---------- */

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; reset: (id?: string) => void; remove: (id: string) => void };
  }
}

let turnstileScript: Promise<void> | null = null;
function loadTurnstile() {
  turnstileScript ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('turnstile'));
    document.head.appendChild(s);
  });
  return turnstileScript;
}

/** The "are you human" check. Calls onToken with a one-time token (empty when it expires). */
function HumanCheck({ siteKey, onToken }: Readonly<{ siteKey: string; onToken: (token: string) => void }>) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let id: string | undefined;
    loadTurnstile()
      .then(() => {
        if (box.current && window.turnstile) {
          id = window.turnstile.render(box.current, { sitekey: siteKey, callback: onToken, 'expired-callback': () => onToken(''), 'error-callback': () => onToken('') });
        }
      })
      .catch(() => setFailed(true));
    return () => {
      if (id) window.turnstile?.remove(id);
    };
  }, [siteKey, onToken]);
  return failed ? <Banner kind="error">The security check couldn't load. Check your connection or ad blocker, then reload the page.</Banner> : <div ref={box} />;
}

/* ---------- Shared bits ---------- */

function PublicCard({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <div className="adm-login">
      <div className="adm-login__card adm-public">
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function CopyField({ label, value, hint }: Readonly<{ label: string; value: string; hint?: ReactNode }>) {
  const toast = useToast();
  const copy = () =>
    navigator.clipboard.writeText(value).then(
      () => toast('success', `${label} copied.`),
      () => toast('error', 'Copy failed. Select the text and copy it yourself.'),
    );
  return <TextField label={label} value={value} onChange={() => {}} hint={hint} wide after={<Button onClick={copy}>Copy</Button>} />;
}

/** The public page for each visible role, e.g. <host>/p/jane/frontend-developer. */
function roleLinks(content: Content, liveUrl: string) {
  const roles = ((content.roles as BaseItem[] | undefined) ?? []).filter((r) => r.status === 'active' && r.isVisible).sort((a, b) => a.displayOrder - b.displayOrder);
  return roles.map((r) => ({ id: r.id, name: String(r.name ?? r.id), url: `${liveUrl}/${r.id}` }));
}

function RoleLinks({ content, liveUrl }: Readonly<{ content: Content; liveUrl: string }>) {
  const roles = roleLinks(content, liveUrl);
  return (
    <ul className="adm-list">
      <li className="adm-row">
        <div className="adm-row__main">
          <div className="adm-row__title">Full portfolio</div>
          <div className="adm-row__meta">{liveUrl.replace(/^https?:\/\//, '')}</div>
        </div>
        <a className="adm-btn adm-btn--secondary adm-btn--sm" href={liveUrl} target="_blank" rel="noopener noreferrer">
          Open ↗
        </a>
      </li>
      {roles.map((r) => (
        <li key={r.id} className="adm-row">
          <div className="adm-row__main">
            <div className="adm-row__title">{r.name}</div>
            <div className="adm-row__meta">{r.url.replace(/^https?:\/\//, '')}</div>
          </div>
          <a className="adm-btn adm-btn--secondary adm-btn--sm" href={r.url} target="_blank" rel="noopener noreferrer">
            Open ↗
          </a>
        </li>
      ))}
    </ul>
  );
}

/** What still stops the draft from publishing, each with a link to the page that fixes it. */
function useDraftIssues() {
  const { content, schema } = useAdmin();
  return validateContent(schema, content).map((issue) => {
    const key = issue.path.split('.')[0];
    const page = schema.pages.find((p) => p.sections.some((ps) => ps.section === key));
    return { ...issue, page };
  });
}

function DraftIssues({ base }: Readonly<{ base: string }>) {
  const issues = useDraftIssues();
  if (!issues.length) return null;
  return (
    <Banner kind="warning">
      <b>Fix before publishing:</b>
      <ul className="adm-bullets">
        {issues.slice(0, 8).map((i) => (
          <li key={`${i.path}:${i.message}`}>
            {i.page ? <Link to={`${base}/p/${i.page.id}`}>{i.page.label}</Link> : i.path.split('.')[0]}: {i.message}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

/* ---------- /start: upload ---------- */

type Config = { enabled: boolean; hostUrl: string | null; turnstileSiteKey: string | null };

function useConfig() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    publicApi.config().then(setConfig, (err) => setError(errorText(err, "Couldn't reach the server. Check your connection and reload the page.")));
  }, []);
  return { config, error };
}

function StartPage() {
  const { config, error } = useConfig();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [human, setHuman] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [dragging, setDragging] = useState(false);
  const existing = loadDraft();

  const pick = (f: File | undefined) => {
    setProblem('');
    if (!f) return;
    if (!/\.(pdf|docx?)$/i.test(f.name)) return setProblem('Choose a PDF, DOC or DOCX file.');
    if (f.size > MAX_BYTES) return setProblem('The file must be 3 MB or smaller.');
    setFile(f);
  };

  const read = async () => {
    if (!file) return;
    setBusy(true);
    setProblem('');
    try {
      const data = await readAsBase64(file);
      const draft = await publicApi.parse(file.name, data, human || undefined);
      resumeFile = { fileName: file.name, data };
      store.set(DRAFT_KEY, JSON.stringify(draft));
      navigate('/start/review');
    } catch (err) {
      setProblem(errorText(err, 'Reading the resume failed. Please try again.'));
      setHuman('');
      window.turnstile?.reset();
    } finally {
      setBusy(false);
    }
  };

  if (error) return <PublicCard title="Create your portfolio"><Banner kind="error">{error}</Banner></PublicCard>;
  if (!config) return <Spinner label="Loading…" />;
  if (!config.enabled) return <PublicCard title="Create your portfolio"><Banner kind="info">Creating portfolios isn't available right now.</Banner></PublicCard>;
  const needsHuman = Boolean(config.turnstileSiteKey);

  return (
    <PublicCard title="Create your portfolio">
      <p className="adm-muted">
        Upload your resume and we'll turn it into a portfolio website, with a separate page for each kind of job you're going for. You can check and
        change everything before it goes live.
      </p>
      {existing && (
        <Banner kind="info">
          You have an unfinished draft. <Link to="/start/review">Continue reviewing it</Link>, or upload a new resume to start over.
        </Banner>
      )}
      <div
        className={`adm-drop ${dragging ? 'is-dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0]);
        }}
      >
        <input ref={input} type="file" hidden accept={RESUME_ACCEPT} onChange={(e) => pick(e.target.files?.[0])} />
        <p>
          <b>{file ? file.name : 'Drop your resume here'}</b>
        </p>
        <p className="adm-muted">PDF, DOC or DOCX, up to 3 MB</p>
        <Button onClick={() => input.current?.click()} disabled={busy}>
          {file ? 'Choose another file' : 'Choose file'}
        </Button>
      </div>
      {needsHuman && <HumanCheck siteKey={config.turnstileSiteKey!} onToken={setHuman} />}
      {problem && <Banner kind="error">{problem}</Banner>}
      <Button variant="primary" onClick={read} busy={busy} disabled={!file || (needsHuman && !human)}>
        {busy ? 'Reading your resume…' : 'Read my resume'}
      </Button>
      <p className="adm-muted adm-small">
        We fill in your portfolio from the resume's text; check every section before publishing. What you publish, including contact details and
        the CV file if you attach it, is public on the web.
      </p>
    </PublicCard>
  );
}

/* ---------- /start/review: edit the draft, then publish ---------- */

const BLANK_SHA = '0'.repeat(40);

function ReviewShell() {
  const [draft, setDraft] = useState(loadDraft);
  const [created, setCreated] = useState<Created | null>(null);
  const confirm = useConfirm();
  const navigate = useNavigate();

  if (created) return <PublishedScreen created={created} />;
  if (!draft) return <Navigate to="/start" replace />;

  const startOver = async () => {
    const ok = await confirm({ title: 'Start over?', message: 'This draft will be discarded.', confirmLabel: 'Discard draft', danger: true });
    if (!ok) return;
    store.remove(DRAFT_KEY);
    resumeFile = null;
    setDraft(null);
    navigate('/start');
  };

  return (
    <AdminDataProvider
      site={draft.site}
      schema={draft.schema}
      initial={{ content: draft.content, sha: BLANK_SHA, updatedAt: null }}
      draft
      onChange={(content) => store.set(DRAFT_KEY, JSON.stringify({ ...draft, content }))}
    >
      <Layout
        base="/start/review"
        actions={<PublishButton draft={draft} onCreated={setCreated} />}
        footer={
          <Button size="sm" onClick={startOver}>
            Start over
          </Button>
        }
      />
    </AdminDataProvider>
  );
}

function ReviewHome() {
  const { content, schema } = useAdmin();
  const roles = roleLinks(content, '');
  return (
    <>
      <div className="adm-page-head">
        <h1>Review your portfolio</h1>
        <p className="adm-muted">We filled in your portfolio from your resume's text. Resumes are laid out in many ways, so check every section. Nothing is public yet.</p>
      </div>
      <DraftIssues base="/start/review" />
      <section className="adm-card">
        <h2>What to do now</h2>
        <ol className="adm-steps">
          <li>Open each section from the menu and check what we found. Fix or add anything that's wrong or missing, and press Save in each form.</li>
          <li>
            Use <b>Preview</b> in any form to see the real portfolio design.
          </li>
          <li>
            Check <b>Roles</b>: we suggested roles from your skills. Each role gets its own page with its own title, summary, skills and projects, so you can send the right link for each job. Add, change or remove roles as you like.
          </li>
          <li>
            Press <b>Publish</b> at the top and choose your web address.
          </li>
        </ol>
      </section>
      {roles.length > 0 && (
        <section className="adm-card">
          <h2>Suggested roles</h2>
          <ul className="adm-bullets">
            {roles.map((r) => (
              <li key={r.id}>{r.name}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="adm-card">
        <h2>Sections</h2>
        <ul className="adm-bullets">
          {schema.pages.map((p) => (
            <li key={p.id}>
              <Link to={`p/${p.id}`}>{p.label}</Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function PublishButton({ draft, onCreated }: Readonly<{ draft: Draft; onCreated: (c: Created) => void }>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Publish
      </Button>
      {open && <PublishDialog draft={draft} onClose={() => setOpen(false)} onCreated={onCreated} />}
    </>
  );
}

function PublishDialog({ draft, onClose, onCreated }: Readonly<{ draft: Draft; onClose: () => void; onCreated: (c: Created) => void }>) {
  const { content, busy: saving } = useAdmin();
  const issues = useDraftIssues();
  const { config } = useConfig();
  const [slug, setSlug] = useState(draft.suggestedSlug);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [attachCv, setAttachCv] = useState(Boolean(resumeFile));
  const [human, setHuman] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const valid = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug) && !slug.includes('--');

  useEffect(() => {
    setAvailable(null);
    if (!valid) return;
    const t = setTimeout(() => publicApi.slugAvailable(slug).then((r) => setAvailable(r.available), () => setAvailable(null)), 400);
    return () => clearTimeout(t);
  }, [slug, valid]);

  const publish = async () => {
    setBusy(true);
    setProblem('');
    try {
      const created = await publicApi.create(slug, content, attachCv ? resumeFile : null, human || undefined);
      store.set(tokenKey(created.slug), created.token);
      store.remove(DRAFT_KEY);
      resumeFile = null;
      onCreated(created);
    } catch (err) {
      setProblem(errorText(err, 'Publishing failed. Please try again.'));
      setHuman('');
      window.turnstile?.reset();
    } finally {
      setBusy(false);
    }
  };

  const host = (config?.hostUrl ?? draft.site.url).replace(/^https?:\/\//, '');
  const needsHuman = Boolean(config?.turnstileSiteKey);
  return (
    <Dialog
      open
      title="Publish your portfolio"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={publish} busy={busy} disabled={issues.length > 0 || !valid || available === false || saving !== null || (needsHuman && !human)}>
            Publish
          </Button>
        </>
      }
    >
      <TextField
        label="Web address"
        value={slug}
        onChange={(v) => setSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        hint={
          <>
            {host}/p/<b>{slug || '…'}</b>
            {valid && available === true && ' is available.'}
          </>
        }
        error={!slug || valid ? (available === false ? 'That address is taken. Try another.' : undefined) : '3–40 lowercase letters, numbers and single hyphens.'}
        wide
      />
      {resumeFile && (
        <label className="adm-multiselect__option">
          <input type="checkbox" checked={attachCv} onChange={(e) => setAttachCv(e.target.checked)} />
          <span>Offer my resume file as the downloadable CV (it becomes public)</span>
        </label>
      )}
      {needsHuman && <HumanCheck siteKey={config!.turnstileSiteKey!} onToken={setHuman} />}
      <DraftIssues base="/start/review" />
      {problem && <Banner kind="error">{problem}</Banner>}
      <p className="adm-muted adm-small">Your portfolio goes live about 1–2 minutes after publishing.</p>
    </Dialog>
  );
}

function PublishedScreen({ created }: Readonly<{ created: Created }>) {
  const editLink = `${window.location.origin}/edit/${created.slug}#${created.token}`;
  const liveUrl = created.site.liveUrl ?? created.site.url;
  return (
    <PublicCard title="Your portfolio is published">
      <p className="adm-muted">It goes live in about 1–2 minutes. These are your links:</p>
      <RoleLinks content={created.published.content} liveUrl={liveUrl} />
      <Banner kind="warning">
        <b>Save your edit link now.</b> It's the only way to change or delete your portfolio later, and we can't send it again. Anyone with this link can
        edit it.
      </Banner>
      <CopyField label="Edit link" value={editLink} />
      <Link className="adm-btn adm-btn--primary adm-btn--md" to={`/edit/${created.slug}#${created.token}`}>
        Open the editor
      </Link>
    </PublicCard>
  );
}

/* ---------- /edit/:slug: the owner's editor ---------- */

/** The edit token: from the link's #fragment (never sent to the server in URLs), else remembered on this device. */
function useEditToken(slug: string) {
  const [token, setToken] = useState(() => {
    const fromHash = window.location.hash.slice(1);
    if (fromHash) {
      store.set(tokenKey(slug), fromHash);
      window.history.replaceState(null, '', window.location.pathname);
      return fromHash;
    }
    return store.get(tokenKey(slug)) ?? '';
  });
  const remember = useCallback(
    (t: string) => {
      if (t) store.set(tokenKey(slug), t);
      else store.remove(tokenKey(slug));
      setToken(t);
    },
    [slug],
  );
  return [token, remember] as const;
}

const EditTokenContext = createContext('');

function OwnerShell() {
  const { slug = '' } = useParams();
  const [token, setToken] = useEditToken(slug);
  const [data, setData] = useState<{ site: SiteInfo; schema: Draft['schema']; published: PublishedState } | null>(null);
  const [error, setError] = useState('');
  const api = useMemo(() => profileApi(slug, token), [slug, token]);

  useEffect(() => {
    if (!token) return;
    setError('');
    setData(null);
    api
      .load()
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiFailure && err.code === 'bad_token') setToken('');
        setError(errorText(err, 'Could not load your portfolio.'));
      });
  }, [api, token, setToken]);

  if (!token) return <PasteLink slug={slug} message={error} onToken={setToken} />;
  if (error) {
    return (
      <PublicCard title="Edit your portfolio">
        <Banner kind="error">{error}</Banner>
      </PublicCard>
    );
  }
  if (!data) return <Spinner label="Loading your portfolio…" />;
  return (
    <EditTokenContext.Provider value={token}>
      <AdminDataProvider key={`${slug}:${token}`} site={data.site} schema={data.schema} initial={data.published} api={api}>
        <Layout base={`/edit/${slug}`} footer={<DeleteProfile slug={slug} token={token} />} />
      </AdminDataProvider>
    </EditTokenContext.Provider>
  );
}

function PasteLink({ slug, message, onToken }: Readonly<{ slug: string; message: string; onToken: (t: string) => void }>) {
  const [link, setLink] = useState('');
  const token = link.includes('#') ? link.slice(link.indexOf('#') + 1).trim() : link.trim();
  return (
    <PublicCard title="Edit your portfolio">
      {message && <Banner kind="error">{message}</Banner>}
      <p className="adm-muted">Paste the edit link you saved when you published /p/{slug}.</p>
      <TextField label="Edit link" value={link} onChange={setLink} placeholder={`${window.location.origin}/edit/${slug}#…`} wide />
      <Button variant="primary" disabled={token.length < 20} onClick={() => onToken(token)}>
        Continue
      </Button>
    </PublicCard>
  );
}

function OwnerHome() {
  const { site, content } = useAdmin();
  const liveUrl = site.liveUrl ?? site.url;
  const editLink = `${window.location.origin}/edit/${site.id}#${useContext(EditTokenContext)}`;
  return (
    <>
      <div className="adm-page-head">
        <h1>Your portfolio</h1>
        <p className="adm-muted">Edit any section from the menu. Each save updates your portfolio in about 1–2 minutes.</p>
      </div>
      <section className="adm-card">
        <h2>Your links</h2>
        <p className="adm-muted">Send the role link that fits each job you apply for. Change roles under Roles.</p>
        <RoleLinks content={content} liveUrl={liveUrl} />
      </section>
      <section className="adm-card">
        <h2>Edit link</h2>
        <CopyField label="Edit link" value={editLink} hint="Keep it private: anyone with this link can edit your portfolio." />
      </section>
    </>
  );
}

function DeleteProfile({ slug, token }: Readonly<{ slug: string; token: string }>) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const remove = async () => {
    const ok = await confirm({
      title: 'Delete your portfolio?',
      message: 'Your portfolio, its role pages and uploaded files are removed from the web (within 1–2 minutes). This cannot be undone.',
      confirmLabel: 'Delete portfolio',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await profileApi(slug, token).remove();
      store.remove(tokenKey(slug));
      setDone(true);
    } catch (err) {
      toast('error', errorText(err, 'Delete failed. Please try again.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="danger" onClick={remove} busy={busy}>
        Delete portfolio
      </Button>
      <Dialog open={done} title="Portfolio deleted" onClose={() => window.location.assign('/start')}>
        <p>It disappears from the web within 1–2 minutes.</p>
        <Button onClick={() => window.location.assign('/start')}>Done</Button>
      </Dialog>
    </>
  );
}

/* ---------- Router ---------- */

function PublicLayout() {
  return <Outlet />;
}

const publicRouter = createBrowserRouter([
  {
    element: <PublicLayout />,
    children: [
      { path: '/start', element: <StartPage /> },
      {
        path: '/start/review',
        element: <ReviewShell />,
        children: [
          { index: true, element: <ReviewHome /> },
          { path: 'p/:pageId', element: <SchemaPage /> },
          { path: '*', element: <Navigate to="." replace /> },
        ],
      },
      {
        path: '/edit/:slug',
        element: <OwnerShell />,
        children: [
          { index: true, element: <OwnerHome /> },
          { path: 'p/:pageId', element: <SchemaPage /> },
          { path: 'versions', element: <VersionsPage /> },
          { path: '*', element: <Navigate to="." replace /> },
        ],
      },
      { path: '*', element: <Navigate to="/start" replace /> },
    ],
  },
]);

export const isPublicPath = (pathname: string) => pathname === '/start' || pathname.startsWith('/start/') || pathname.startsWith('/edit/');

export function PublicApp() {
  return <RouterProvider router={publicRouter} />;
}
