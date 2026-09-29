import { useEffect, useState } from 'react';
import { NavLink, Outlet, useBlocker, useLocation, useNavigate } from 'react-router-dom';
import { ApiFailure, type SiteInfo } from './api';
import { useAnyFormDirty } from './forms';
import { useAdmin, type LiveState } from './store';
import { Button, Dialog, useConfirm, useToast } from './ui';

const LIVE_LABELS: Record<LiveState, { text: string; kind: string }> = {
  checking: { text: 'Checking portfolio…', kind: 'info' },
  deploying: { text: 'Updating portfolio…', kind: 'warn' },
  live: { text: 'Portfolio is up to date', kind: 'ok' },
  unknown: { text: "Couldn't confirm the portfolio's version", kind: 'info' },
};

export function LiveStatus() {
  const { live, busy } = useAdmin();
  const { text, kind } = busy === 'saving' ? { text: 'Saving…', kind: 'info' } : LIVE_LABELS[live];
  return (
    <span className={`adm-pill adm-pill--${kind}`} role="status">
      {text}
    </span>
  );
}

export function Layout({ username, sites, onSignOut }: Readonly<{ username: string; sites: SiteInfo[]; onSignOut: () => void }>) {
  const { busy, conflict, reload, site, schema } = useAdmin();
  const anyFormDirty = useAnyFormDirty();
  const confirm = useConfirm();
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const base = `/${site.id}`;

  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Block in-app navigation away from a form with unsaved edits.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => anyFormDirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    confirm({ title: 'You have unsaved changes', message: 'Leave this page and lose the changes in the open form?', confirmLabel: 'Leave', cancelLabel: 'Stay', danger: true }).then(
      (leave) => (leave ? blocker.proceed() : blocker.reset()),
    );
  }, [blocker, confirm]);

  const signOut = async () => {
    if (anyFormDirty) {
      const ok = await confirm({ title: 'Sign out?', message: 'A form has unsaved changes that will be lost.', confirmLabel: 'Sign out', cancelLabel: 'Stay', danger: true });
      if (!ok) return;
    }
    onSignOut();
  };

  const reloadLatest = async () => {
    try {
      await reload();
      toast('info', 'Loaded the latest content. Reapply your change and save again.');
    } catch (err) {
      toast('error', err instanceof ApiFailure ? err.message : 'Reload failed. Please try again.');
    }
  };

  return (
    <div className="adm-shell">
      <aside className={`adm-sidebar ${menuOpen ? 'is-open' : ''}`}>
        <div className="adm-sidebar__brand">
          <span>Portfolio Admin</span>
          <button type="button" className="adm-menu-btn" aria-expanded={menuOpen} aria-controls="adm-nav" onClick={() => setMenuOpen((o) => !o)}>
            {menuOpen ? 'Close' : 'Menu'}
          </button>
        </div>
        <nav id="adm-nav" className="adm-nav" aria-label="Admin">
          <div className="adm-nav__group">
            <label className="adm-nav__heading" htmlFor="adm-site">
              Portfolio
            </label>
            {sites.length > 1 ? (
              <select id="adm-site" className="adm-site-select" value={site.id} onChange={(e) => navigate(`/${e.target.value}`)}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : (
              <p id="adm-site" className="adm-site-name">
                {site.name}
              </p>
            )}
          </div>
          <div className="adm-nav__group">
            <p className="adm-nav__heading">Overview</p>
            <NavLink to={base} end className="adm-nav__link">
              Dashboard
            </NavLink>
          </div>
          <div className="adm-nav__group">
            <p className="adm-nav__heading">Content</p>
            {schema.pages.map((p) => (
              <NavLink key={p.id} to={`${base}/p/${p.id}`} className="adm-nav__link">
                {p.label}
              </NavLink>
            ))}
          </div>
          <div className="adm-nav__group">
            <p className="adm-nav__heading">History</p>
            <NavLink to={`${base}/versions`} className="adm-nav__link">
              Version History
            </NavLink>
          </div>
          <div className="adm-nav__footer">
            <p className="adm-muted">Signed in as {username}</p>
            <Button size="sm" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </nav>
      </aside>

      <div className="adm-main">
        <header className="adm-topbar">
          <LiveStatus />
          <div className="adm-topbar__actions">
            <a className="adm-btn adm-btn--secondary adm-btn--md" href={site.url} target="_blank" rel="noopener noreferrer">
              View portfolio ↗
            </a>
          </div>
        </header>

        <main className="adm-content">
          <Outlet />
        </main>
      </div>

      <Dialog
        open={conflict}
        title="The portfolio changed elsewhere"
        onClose={() => {}}
        actions={
          <Button variant="primary" onClick={reloadLatest} busy={busy === 'reloading'}>
            Reload Latest
          </Button>
        }
      >
        <p>
          Someone saved a newer version (in another tab or on another device) since this page loaded, so your change was <b>not</b> saved, to avoid
          overwriting it. Reload the latest content, then make your change again.
        </p>
      </Dialog>
    </div>
  );
}
