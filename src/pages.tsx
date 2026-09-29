import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type { BaseItem, CollectionSection, ObjectSection } from '../lib/schema';
import { CollectionEditor, SectionForm } from './editors';
import { LiveStatus } from './Layout';
import { useAdmin } from './store';
import { formatDate } from './ui';

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
    </>
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
