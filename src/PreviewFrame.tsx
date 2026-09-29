import { useEffect, useRef, useState } from 'react';
import type { Content } from '../lib/schema';
import { useAdmin } from './store';
import { Button, Dialog } from './ui';

const WIDTHS = { desktop: '100%', tablet: '820px', mobile: '390px' } as const;
export type Device = keyof typeof WIDTHS;

/**
 * The real portfolio, rendered from `content`: an iframe of the portfolio's own /preview.html, which
 * accepts content by postMessage from this admin's origin only. `path` is a route ("/works") or a
 * section anchor ("#skills"), whichever the portfolio uses. Nothing is saved.
 */
export function PreviewFrame({ content, path, device, title }: Readonly<{ content: Content; path: string; device: Device; title: string }>) {
  const { site } = useAdmin();
  const target = new URL(site.url).origin;
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const nonce = useRef(0);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin === target && e.source === frame.current?.contentWindow && e.data?.type === 'portfolio-preview-ready') setReady(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [target]);

  useEffect(() => {
    if (!ready) return;
    frame.current?.contentWindow?.postMessage({ type: 'portfolio-preview', content, path, nonce: ++nonce.current }, target);
  }, [ready, content, path, target]);

  return (
    <div className="adm-preview__stage">
      <iframe ref={frame} src={`${site.url}/preview.html`} title={title} className="adm-preview__frame" style={{ width: WIDTHS[device] }} />
    </div>
  );
}

export function PreviewControls({
  path,
  setPath,
  device,
  setDevice,
}: Readonly<{ path: string; setPath: (p: string) => void; device: Device; setDevice: (d: Device) => void }>) {
  const { schema } = useAdmin();
  return (
    <div className="adm-preview__controls">
      <div className="adm-segmented" role="group" aria-label="Page">
        {schema.previewPages.map((p) => (
          <button key={p.path} type="button" aria-pressed={path === p.path} onClick={() => setPath(p.path)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="adm-segmented" role="group" aria-label="Screen size">
        {(['desktop', 'tablet', 'mobile'] as Device[]).map((d) => (
          <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)}>
            {d.charAt(0).toUpperCase() + d.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Preview" button target: the portfolio with unsaved changes applied. */
export function PreviewDialog({
  content,
  onClose,
  startPath,
  title = 'Preview (not saved yet)',
}: Readonly<{ content: Content | null; onClose: () => void; startPath?: string; title?: string }>) {
  const { schema } = useAdmin();
  const first = startPath ?? schema.previewPages[0]?.path ?? '/';
  const [path, setPath] = useState(first);
  const [device, setDevice] = useState<Device>('desktop');
  useEffect(() => setPath(first), [first, content === null]);
  return (
    <Dialog open={Boolean(content)} wide title={title} onClose={onClose} actions={<Button onClick={onClose}>Close preview</Button>}>
      {content && (
        <>
          <PreviewControls path={path} setPath={setPath} device={device} setDevice={setDevice} />
          <PreviewFrame content={content} path={path} device={device} title="Portfolio preview" />
        </>
      )}
    </Dialog>
  );
}
