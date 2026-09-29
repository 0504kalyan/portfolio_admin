// Portfolio admin: one app that manages several portfolios. Each portfolio's editing screens are
// generated from the content/schema.json in its own repository.
import { createContext, StrictMode, useCallback, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link, Navigate, RouterProvider, useParams } from 'react-router-dom';
import type { Schema } from '../lib/schema';
import { api, ApiFailure, setUnauthorizedHandler, siteApi, type PublishedState, type SiteInfo } from './api';
import { GuardProvider } from './forms';
import { Layout } from './Layout';
import { LoginForm, LoginScreen } from './Login';
import { Dashboard, SchemaPage } from './pages';
import { AdminDataProvider } from './store';
import { Banner, Button, ConfirmProvider, Dialog, Spinner, ToastProvider } from './ui';
import { VersionsPage } from './versions';
import './admin.css';

type SessionInfo = { username: string; sites: SiteInfo[]; signOut: () => void };
const SessionContext = createContext<SessionInfo | null>(null);
const useSession = () => useContext(SessionContext)!;

function ErrorScreen({ message, onRetry }: Readonly<{ message: string; onRetry: () => void }>) {
  return (
    <div className="adm-login">
      <div className="adm-login__card">
        <h1>Portfolio Admin</h1>
        <Banner kind="error">{message}</Banner>
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

/** "/": pick a portfolio (or go straight to the only one). */
function SitePicker() {
  const { sites, username, signOut } = useSession();
  if (sites.length === 1) return <Navigate to={`/${sites[0].id}`} replace />;
  return (
    <div className="adm-login">
      <div className="adm-login__card adm-picker">
        <h1>Choose a portfolio</h1>
        {sites.length === 0 && <Banner kind="warning">Your account ({username}) doesn't have access to any portfolio yet.</Banner>}
        <ul className="adm-list">
          {sites.map((s) => (
            <li key={s.id} className="adm-row">
              <div className="adm-row__main">
                <div className="adm-row__title">{s.name}</div>
                <div className="adm-row__meta">{s.url.replace(/^https?:\/\//, '')}</div>
              </div>
              <Link className="adm-btn adm-btn--primary adm-btn--sm" to={`/${s.id}`}>
                Manage
              </Link>
            </li>
          ))}
        </ul>
        <Button size="sm" onClick={signOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

/** "/:siteId/*": loads that portfolio's schema and content, then shows the editor. */
function SiteShell() {
  const { siteId = '' } = useParams();
  const { username, sites, signOut } = useSession();
  const [data, setData] = useState<{ site: SiteInfo; schema: Schema; published: PublishedState } | null>(null);
  const [error, setError] = useState('');
  const allowed = sites.some((s) => s.id === siteId);

  const load = useCallback(() => {
    if (!allowed) return;
    setError('');
    setData(null);
    siteApi(siteId)
      .load()
      .then(setData)
      .catch((err) => setError(err instanceof ApiFailure ? err.message : 'Could not load the portfolio.'));
  }, [siteId, allowed]);
  useEffect(load, [load]);

  if (!allowed) return <Navigate to="/" replace />;
  if (error) return <ErrorScreen message={error} onRetry={load} />;
  if (!data || data.site.id !== siteId) return <Spinner label="Loading portfolio…" />;
  return (
    <AdminDataProvider key={siteId} site={data.site} schema={data.schema} initial={data.published}>
      <Layout username={username} sites={sites} onSignOut={signOut} />
    </AdminDataProvider>
  );
}

const router = createBrowserRouter([
  { path: '/', element: <SitePicker /> },
  {
    path: '/:siteId',
    element: <SiteShell />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'p/:pageId', element: <SchemaPage /> },
      { path: 'versions', element: <VersionsPage /> },
      { path: '*', element: <Navigate to="." replace /> },
    ],
  },
]);

function Root() {
  const [auth, setAuth] = useState<{ state: 'checking' } | { state: 'anon' } | { state: 'error'; message: string } | { state: 'authed'; username: string; sites: SiteInfo[] }>({
    state: 'checking',
  });
  const [expired, setExpired] = useState(false);

  const check = useCallback(() => {
    setAuth({ state: 'checking' });
    api
      .session()
      .then((s) => setAuth(s.authenticated && s.username ? { state: 'authed', username: s.username, sites: s.sites } : { state: 'anon' }))
      .catch((err) =>
        setAuth({ state: 'error', message: err instanceof ApiFailure ? err.message : "Couldn't reach the admin server. Check your connection and try again." }),
      );
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setExpired(true));
    check();
  }, [check]);

  const signOut = useCallback(() => {
    api.logout().finally(() => window.location.assign('/'));
  }, []);

  if (auth.state === 'checking') return <Spinner label="Loading…" />;
  if (auth.state === 'error') return <ErrorScreen message={auth.message} onRetry={check} />;
  if (auth.state === 'anon') return <LoginScreen onSignedIn={check} />;

  return (
    <SessionContext.Provider value={{ username: auth.username, sites: auth.sites, signOut }}>
      <GuardProvider>
        <RouterProvider router={router} />
      </GuardProvider>
      {/* Session expired mid-edit: sign in again without losing what's on screen. */}
      <Dialog open={expired} title="Session expired" onClose={() => {}}>
        <LoginForm intro="Please sign in again to continue. Your edits are still here." onSignedIn={() => setExpired(false)} />
      </Dialog>
    </SessionContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <Root />
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
);
