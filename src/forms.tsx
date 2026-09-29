// Form plumbing shared by the section and collection editors, driven by the portfolio's schema.
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { getPath, selectOptions, setPath, type Content, type Field, type Issue } from '../lib/schema';
import { ApiFailure } from './api';
import { useAdmin } from './store';
import { Button, SelectField, TextField, Toggle, useToast } from './ui';

/**
 * Form state. Lists are kept as raw text while editing (so typing new lines works), numbers as text,
 * and object lists as an array of nested form states.
 */
export type FormValue = string | boolean | FormValues[];
export type FormValues = Record<string, FormValue>;

export function toForm(obj: unknown, fields: Field[]): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const v = getPath(obj, f.name);
    if (f.type === 'toggle') out[f.name] = v === true;
    else if (f.type === 'list') out[f.name] = ((v as string[] | undefined) ?? []).join('\n');
    else if (f.type === 'objectList') out[f.name] = ((v as unknown[] | undefined) ?? []).map((entry) => toForm(entry, f.fields ?? []));
    else out[f.name] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

const lines = (v: FormValue) =>
  String(v ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

export function fromForm<T>(obj: T, form: FormValues, fields: Field[]): T {
  let out = obj;
  for (const f of fields) {
    const v = form[f.name];
    let value: unknown;
    if (f.type === 'toggle') value = v === true;
    else if (f.type === 'list') value = lines(v);
    else if (f.type === 'objectList') value = ((v as FormValues[]) ?? []).map((entry) => fromForm({}, entry, f.fields ?? []));
    else if (f.type === 'number') value = String(v).trim() === '' ? null : Number(v);
    else value = String(v ?? '').trim();
    out = setPath(out, f.name, value);
  }
  return out;
}

/** Issues keyed by the form field they belong to (nested object-list issues roll up to their list). */
export function issuesByField(issues: Issue[], fields: Field[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const f = i.path === 'id' ? null : fields.find((x) => i.path === x.name || i.path.startsWith(`${x.name}.`));
    const key = i.path === 'id' ? 'id' : f?.name;
    if (!key || out[key]) continue;
    const entry = f && i.path !== f.name ? Number(i.path.slice(f.name.length + 1).split('.')[0]) : NaN;
    out[key] = Number.isFinite(entry) ? `Entry ${entry + 1}: ${i.message}` : i.message;
  }
  return out;
}

/* ---------- Uploads ---------- */

const ACCEPT = {
  image: '.jpg,.jpeg,.png,.webp,.gif,image/jpeg,image/png,image/webp,image/gif',
  document: '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new ApiFailure(0, 'read_failed', 'Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

function UploadButton({ accept, onUploaded }: Readonly<{ accept: 'image' | 'document'; onUploaded: (url: string) => void }>) {
  const { api } = useAdmin();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const upload = async (file: File) => {
    if (file.size > 3 * 1024 * 1024) return toast('error', 'Files must be 3 MB or smaller.');
    setBusy(true);
    try {
      const { url } = await api.upload(file.name, await readAsBase64(file));
      onUploaded(url);
      toast('success', 'File uploaded. Press Save to use it; it appears on the portfolio after its next deployment (about 1–2 minutes).');
    } catch (err) {
      toast('error', err instanceof ApiFailure ? err.message : 'Upload failed. Please try again.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <>
      <input ref={input} type="file" hidden accept={ACCEPT[accept]} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      <Button onClick={() => input.current?.click()} busy={busy}>
        {busy ? 'Uploading…' : 'Upload'}
      </Button>
    </>
  );
}

/* ---------- Field rendering ---------- */

type FieldProps = {
  field: Field;
  value: FormValue;
  error?: string;
  content: Content;
  onChange: (v: FormValue) => void;
};

/** A repeatable group of sub-fields, e.g. the steps of a process. */
function ObjectListInput({ field: f, value, error, content, onChange }: Readonly<FieldProps>) {
  const entries = (value as FormValues[]) ?? [];
  const sub = f.fields ?? [];
  const set = (next: FormValues[]) => onChange(next);
  const move = (i: number, dir: -1 | 1) => {
    const next = [...entries];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    set(next);
  };
  return (
    <fieldset className={`adm-field adm-field--wide adm-objlist ${error ? 'has-error' : ''}`}>
      <legend className="adm-field__label">
        {f.label}
        {f.required && <span className="adm-required" aria-hidden="true"> *</span>}
      </legend>
      {entries.map((entry, i) => (
        <div key={i} className="adm-objlist__entry">
          <div className="adm-objlist__head">
            <b>
              {i + 1}. {String(entry[f.itemLabel ?? sub[0]?.name] ?? '') || 'New entry'}
            </b>
            <span className="adm-inline-actions">
              <button type="button" className="adm-icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move entry ${i + 1} up`}>
                ↑
              </button>
              <button type="button" className="adm-icon-btn" onClick={() => move(i, 1)} disabled={i === entries.length - 1} aria-label={`Move entry ${i + 1} down`}>
                ↓
              </button>
              <Button size="sm" variant="danger" onClick={() => set(entries.filter((_, n) => n !== i))}>
                Remove
              </Button>
            </span>
          </div>
          <div className="adm-grid">
            {sub.map((sf) => (
              <FieldInput
                key={sf.name}
                field={sf}
                value={entry[sf.name]}
                content={content}
                onChange={(v) => set(entries.map((e, n) => (n === i ? { ...e, [sf.name]: v } : e)))}
              />
            ))}
          </div>
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => set([...entries, toForm({}, sub)])}>
          + Add {f.label.toLowerCase().replace(/s$/, '')}
        </Button>
      </div>
      {error ? <p className="adm-field__error">{error}</p> : f.hint && <p className="adm-field__hint">{f.hint}</p>}
    </fieldset>
  );
}

const isPreviewable = (url: string, accept?: string) => accept === 'image' && /^(\/|https:\/\/)/.test(url);

export function FieldInput(props: Readonly<FieldProps>) {
  const { field: f, value, error, content, onChange } = props;
  const { site, schema } = useAdmin();
  const shell = { label: f.label, hint: f.hint, error, required: f.required, wide: f.wide || f.type === 'textarea' };
  const text = typeof value === 'string' ? value : '';
  switch (f.type) {
    case 'objectList':
      return <ObjectListInput {...props} />;
    case 'toggle':
      return <Toggle label={f.label} checked={value === true} onChange={onChange} hint={f.hint} />;
    case 'select':
      return <SelectField {...shell} value={text} onChange={onChange} options={selectOptions(f, content, schema)} />;
    case 'textarea':
      return <TextField {...shell} multiline rows={5} value={text} onChange={onChange} placeholder={f.placeholder} />;
    case 'list':
      return <TextField {...shell} multiline rows={Math.min(12, Math.max(3, text.split('\n').length + 1))} value={text} onChange={onChange} />;
    case 'number':
      return <TextField {...shell} type="number" value={text} onChange={onChange} placeholder={f.placeholder} />;
    case 'color':
      return (
        <TextField
          {...shell}
          value={text}
          onChange={onChange}
          placeholder="#C778DD"
          after={
            <input
              type="color"
              aria-label={`${f.label} picker`}
              value={/^#[0-9a-f]{6}$/i.test(text) ? text : '#c778dd'}
              onChange={(e) => onChange(e.target.value.toUpperCase())}
            />
          }
        />
      );
    case 'asset':
      return (
        <TextField
          {...shell}
          value={text}
          onChange={onChange}
          placeholder={f.accept === 'document' ? '/Resume.pdf' : '/photo.jpg'}
          hint={
            <>
              {f.hint} Upload a file, or enter a site path (/file.jpg) or https:// URL.
              {text && isPreviewable(text, f.accept) && <img className="adm-thumb" src={text.startsWith('/') ? site.url + text : text} alt="" />}
            </>
          }
          after={<UploadButton accept={f.accept ?? 'image'} onUploaded={onChange} />}
        />
      );
    case 'date':
      return <TextField {...shell} value={text} onChange={onChange} placeholder={f.placeholder ?? 'YYYY-MM'} />;
    case 'url':
      return <TextField {...shell} type="url" value={text} onChange={onChange} placeholder={f.placeholder ?? 'https://'} />;
    case 'email':
    case 'tel':
      return <TextField {...shell} type={f.type} value={text} onChange={onChange} placeholder={f.placeholder} />;
    default:
      return <TextField {...shell} value={text} onChange={onChange} placeholder={f.placeholder} />;
  }
}

export function FieldGrid({
  fields,
  form,
  errors,
  content,
  onChange,
}: Readonly<{
  fields: Field[];
  form: FormValues;
  errors: Record<string, string>;
  content: Content;
  onChange: (name: string, v: FormValue) => void;
}>) {
  return (
    <div className="adm-grid">
      {fields.map((f) => (
        <FieldInput key={f.name} field={f} value={form[f.name]} error={errors[f.name]} content={content} onChange={(v) => onChange(f.name, v)} />
      ))}
    </div>
  );
}

/* ---------- Unsaved form guard ----------
 * Each open form reports whether it has unsaved edits; the layout blocks in-app navigation
 * (and the browser warns on tab close) while any form is dirty.
 */
const GuardContext = createContext<{ set: (id: string, dirty: boolean) => void; anyDirty: boolean }>({ set: () => {}, anyDirty: false });

export function GuardProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const set = useRef((id: string, d: boolean) => setDirty((s) => (s[id] === d ? s : { ...s, [id]: d }))).current;
  const anyDirty = Object.values(dirty).some(Boolean);

  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyDirty]);

  return <GuardContext.Provider value={{ set, anyDirty }}>{children}</GuardContext.Provider>;
}

export const useAnyFormDirty = () => useContext(GuardContext).anyDirty;

export function useDirtyGuard(dirty: boolean) {
  const { set } = useContext(GuardContext);
  const id = useId();
  useEffect(() => {
    set(id, dirty);
    return () => set(id, false);
  }, [id, dirty, set]);
}
