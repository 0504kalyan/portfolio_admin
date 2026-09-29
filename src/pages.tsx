import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type { BaseItem, CollectionSection, ObjectSection } from '../lib/schema';
import { CollectionEditor, SectionForm } from './editors';
import { LiveStatus } from './Layout';
import { useAdmin } from './store';
import { ApiFailure, siteApi } from './api';
import { Button, EmptyState, formatDate, useConfirm, useToast } from './ui';

function PageHead({ title, children }: Readonly<{ title: string; children?: ReactNode }>) {
  return (
    <div className="adm-page-head">
      <h1>{title}</h1>
      {children && <p className="adm-muted">{children}</p>}
    </div>
  );
}

const liveCount = (items: BaseItem[] = []) => items.filter((i) => i.status === 'active' && i.isVisible).length;

export function Dashboard() {
  const { site, published, content, schema } = useAdmin();
  // One tile per collection, linking to the page that edits it.
  const stats = Object.entries(schema.sections)
    .filter(([, s]) => s.type === 'collection')
    .map(([key, s]) => ({
      key,
      label: s.label,
      value: liveCount(content[key] as BaseItem[]),
      page: schema.pages.find((p) => p.sections.some((ps) => ps.section === key))?.id,
    }));

  return (
    <>
      <PageHead title={site.name}>
        Changes you save here update{' '}
        <a href={site.url} target="_blank" rel="noopener noreferrer">
          {site.url.replace(/^https?:\/\//, '')}
        </a>
        .
      </PageHead>
      <div className="adm-stats">
        <div className="adm-stat">
          <span className="adm-stat__label">Last saved</span>
          <span className="adm-stat__value adm-stat__value--sm">{published.updatedAt ? formatDate(published.updatedAt) : 'Not recorded yet'}</span>
          <span className="adm-muted">Version {published.sha.slice(0, 7)}</span>
        </div>
        <div className="adm-stat">
          <span className="adm-stat__label">Portfolio</span>
          <span>
            <LiveStatus />
          </span>
          <span className="adm-muted">Checked against the portfolio's live version</span>
        </div>
        {stats.map((s) => (
          <Link key={s.key} to={s.page ? `p/${s.page}` : '.'} className="adm-stat adm-stat--link">
            <span className="adm-stat__label">{s.label}</span>
            <span className="adm-stat__value">{s.value}</span>
            <span className="adm-muted">visible on the portfolio</span>
          </Link>
        ))}
      </div>
      <section className="adm-card">
        <h2>How saving works</h2>
        <ol className="adm-steps">
          <li>Open a section from the menu and edit, or add a new entry.</li>
          <li>
            Press <b>Preview</b> to see the portfolio with your change before saving (optional).
          </li>
          <li>
            Press <b>Save</b>. The change is committed to this portfolio's GitHub repository and it redeploys by itself.
          </li>
          <li>
            The status at the top shows <b>Updating portfolio…</b> and then <b>Portfolio is up to date</b>, usually within 1–2 minutes.
          </li>
        </ol>
        <p className="adm-muted">Deleting, restoring, hiding and reordering also save straight away. Version History can undo any save.</p>
      </section>
      {site.hostsProfiles && <ProfilesCard />}
    </>
  );
}

/** Portfolios people created from their resumes on this site (/p/<slug>), for moderation. */
function ProfilesCard() {
  const { site } = useAdmin();
  const confirm = useConfirm();
  const toast = useToast();
  const [profiles, setProfiles] = useState<{ slug: string; url: string }[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const api = siteApi(site.id);

  useEffect(() => {
    siteApi(site.id)
      .profiles()
      .then((r) => setProfiles(r.profiles), (err) => setError(err instanceof ApiFailure ? err.message : 'Could not load the portfolios.'));
  }, [site.id]);

  const remove = async (slug: string) => {
    const ok = await confirm({ title: `Delete /p/${slug}?`, message: 'The portfolio, its role pages and its uploads are removed. This cannot be undone here.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    setBusy(slug);
    try {
      await api.deleteProfile(slug);
      setProfiles((list) => list?.filter((p) => p.slug !== slug) ?? null);
      toast('success', `/p/${slug} deleted. It disappears after the next deployment.`);
    } catch (err) {
      toast('error', err instanceof ApiFailure ? err.message : 'Delete failed.');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="adm-card">
      <h2>Portfolios created from resumes</h2>
      <p className="adm-muted">
        Anyone can create one at <a href="/start">/start</a>. They're served by this portfolio at /p/&lt;name&gt;.
      </p>
      {error && <p className="adm-field__error">{error}</p>}
      {profiles && profiles.length === 0 && <EmptyState>None yet.</EmptyState>}
      {profiles && profiles.length > 0 && (
        <ul className="adm-list">
          {profiles.map((p) => (
            <li key={p.slug} className="adm-row">
              <div className="adm-row__main">
                <div className="adm-row__title">/p/{p.slug}</div>
              </div>
              <a className="adm-btn adm-btn--secondary adm-btn--sm" href={p.url} target="_blank" rel="noopener noreferrer">
                View ↗
              </a>
              <Button size="sm" variant="danger" busy={busy === p.slug} onClick={() => remove(p.slug)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One admin page, built from the portfolio's schema.pages entry. */
export function SchemaPage() {
  const { pageId } = useParams();
  const { schema } = useAdmin();
  const page = schema.pages.find((p) => p.id === pageId);
  if (!page) return <Navigate to=".." relative="path" replace />;

  return (
    <>
      <PageHead title={page.label}>{page.description}</PageHead>
      {page.sections.map((ps) => {
        const section = schema.sections[ps.section];
        if (section.type === 'collection') {
          return <CollectionEditor key={ps.section} sectionKey={ps.section} previewPath={ps.preview ?? (section as CollectionSection).preview} />;
        }
        const all = (section as ObjectSection).fields;
        const fields = ps.fields ? ps.fields.map((n) => all.find((f) => f.name === n)).filter((f) => f !== undefined) : all;
        return (
          <SectionForm
            key={`${ps.section}:${ps.fields?.join(',') ?? '*'}`}
            sectionKey={ps.section}
            fields={fields}
            title={ps.title ?? section.label}
            description={ps.description}
            previewPath={ps.preview}
          />
        );
      })}
    </>
  );
}
