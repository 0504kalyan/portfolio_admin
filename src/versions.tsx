import { useCallback, useEffect, useState } from 'react';
import { describeChanges, type Content } from '../lib/schema';
import { ApiFailure, type Version } from './api';
import { LIVE_NOTE } from './editors';
import { PreviewControls, PreviewFrame, type Device } from './PreviewFrame';
import { useAdmin } from './store';
import { Banner, Button, Dialog, EmptyState, formatDate, Spinner, useConfirm, useToast } from './ui';

/** Every save is a Git commit; restoring commits an old version again, so history is never rewritten. */
export function VersionsPage() {
  const { api, published, restore, busy, schema } = useAdmin();
  const toast = useToast();
  const confirm = useConfirm();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<{ version: Version; content: Content | null; error?: string } | null>(null);
  const [path, setPath] = useState('/');
  const [device, setDevice] = useState<Device>('desktop');

  const load = useCallback(async () => {
    setError('');
    try {
      setVersions((await api.versions()).versions);
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Could not load versions.');
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load, published.sha]);

  const view = async (version: Version) => {
    setViewing({ version, content: null });
    try {
      const { content } = await api.version(version.commitSha);
      setViewing((v) => (v && v.version.commitSha === version.commitSha ? { ...v, content } : v));
    } catch (err) {
      setViewing((v) => v && { ...v, error: err instanceof ApiFailure ? err.message : 'Could not load this version.' });
    }
  };

  const doRestore = async (version: Version) => {
    const ok = await confirm({
      title: 'Restore this version?',
      message: `The portfolio goes back to the content from ${formatDate(version.date)}. This is saved as a new version, so nothing is removed from the history and you can switch back later.`,
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    try {
      const res = await restore(version.commitSha);
      setViewing(null);
      toast(res.unchanged ? 'info' : 'success', res.unchanged ? 'The portfolio already matches this version.' : `Version restored successfully. ${LIVE_NOTE}`);
    } catch (err) {
      if (!(err instanceof ApiFailure && err.code === 'conflict')) {
        toast('error', `Restore failed. ${err instanceof ApiFailure ? err.message : 'Please try again.'}`);
      }
    }
  };

  const restoring = busy === 'restoring';
  const current = versions?.[0]?.commitSha;

  return (
    <>
      <div className="adm-page-head">
        <h1>Version History</h1>
        <p className="adm-muted">Every save is a version. Restoring saves an old version again as a new one; history is never rewritten.</p>
      </div>
      {error && (
        <Banner kind="error">
          <span>{error}</span>
          <Button size="sm" onClick={load}>
            Retry
          </Button>
        </Banner>
      )}
      <section className="adm-card">
        {!versions && !error && <Spinner label="Loading versions…" />}
        {versions && versions.length === 0 && <EmptyState>No versions yet.</EmptyState>}
        {versions && versions.length > 0 && (
          <ul className="adm-list">
            {versions.map((v) => (
              <li key={v.commitSha} className="adm-row">
                <div className="adm-row__main">
                  <div className="adm-row__title">
                    {v.message.split('\n')[0]}
                    {v.commitSha === current && <span className="adm-badge adm-badge--accent">Current</span>}
                  </div>
                  <div className="adm-row__meta">
                    {formatDate(v.date)} · {v.author} · {v.commitSha.slice(0, 7)}
                  </div>
                </div>
                <div className="adm-row__actions">
                  <Button size="sm" onClick={() => view(v)}>
                    View
                  </Button>
                  <Button size="sm" onClick={() => doRestore(v)} disabled={v.commitSha === current || Boolean(busy)} busy={restoring}>
                    {restoring ? 'Restoring…' : 'Restore'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={Boolean(viewing)}
        wide
        title={viewing ? `Version from ${formatDate(viewing.version.date)}` : ''}
        onClose={() => setViewing(null)}
        actions={
          <>
            <Button onClick={() => setViewing(null)}>Close</Button>
            {viewing && viewing.version.commitSha !== current && (
              <Button variant="primary" onClick={() => doRestore(viewing.version)} busy={restoring} disabled={Boolean(busy) || !viewing.content}>
                Restore this version
              </Button>
            )}
          </>
        }
      >
        {viewing?.error && <Banner kind="error">{viewing.error}</Banner>}
        {viewing && !viewing.content && !viewing.error && <Spinner label="Loading version…" />}
        {viewing?.content && (
          <>
            <details className="adm-advanced">
              <summary>What restoring would change ({describeChanges(schema, published.content, viewing.content).length})</summary>
              <ul className="adm-changes">
                {describeChanges(schema, published.content, viewing.content).map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </details>
            <PreviewControls path={path} setPath={setPath} device={device} setDevice={setDevice} />
            <PreviewFrame content={viewing.content} path={path} device={device} title="Version preview" />
          </>
        )}
      </Dialog>
    </>
  );
}
