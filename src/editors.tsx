// The two editors every admin page is built from, both driven by the portfolio's schema:
// SectionForm edits an object section (profile, hero text, SEO…); CollectionEditor manages a list
// (projects, modules…) with add / edit / hide / reorder / archive / soft delete / restore.
// Every action saves straight to the portfolio: it's committed to GitHub and the portfolio redeploys.
import { useEffect, useMemo, useState } from 'react';
import {
  blankItem,
  getPath,
  ID_PATTERN,
  itemLabel,
  uniqueId,
  validateFields,
  validateItem,
  type BaseItem,
  type CollectionSection,
  type Content,
  type Field,
} from '../lib/schema';
import { ApiFailure } from './api';
import { FieldGrid, fromForm, issuesByField, toForm, useDirtyGuard, type FormValues } from './forms';
import { PreviewDialog } from './PreviewFrame';
import { useAdmin } from './store';
import { Button, Dialog, EmptyState, TextField, Toggle, useConfirm, useToast } from './ui';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const LIVE_NOTE = 'The portfolio updates in about 1–2 minutes.';

/** Runs a save and reports the outcome; returns true on success. */
function useSaveAction() {
  const { save } = useAdmin();
  const toast = useToast();
  return async (fn: (c: Content) => Content, success: string) => {
    try {
      const res = await save(fn);
      toast('success', res.unchanged ? 'Nothing changed.' : `${success} ${LIVE_NOTE}`);
      if (res.deployment === 'hook_failed') toast('error', 'Saved, but the deploy hook failed. Redeploy the portfolio from Vercel if it does not update.');
      return true;
    } catch (err) {
      // A conflict opens the "reload" dialog; everything else gets a toast.
      if (!(err instanceof ApiFailure && err.code === 'conflict')) {
        toast('error', `Save failed. ${err instanceof ApiFailure ? err.message : 'Please try again.'}`);
      }
      return false;
    }
  };
}

/* ---------- Object sections ---------- */

export function SectionForm({
  sectionKey,
  fields,
  title,
  description,
  previewPath,
}: Readonly<{ sectionKey: string; fields: Field[]; title: string; description?: string; previewPath?: string }>) {
  const { content, busy, schema } = useAdmin();
  const toast = useToast();
  const saveAction = useSaveAction();
  const value = content[sectionKey];
  const initial = useMemo(() => toForm(value, fields), [value, fields]);
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Content | null>(null);
  const dirty = !same(form, initial);
  useDirtyGuard(dirty);

  // Pick up external changes (reload, restore).
  useEffect(() => {
    setForm(initial);
    setErrors({});
  }, [initial]);

  /** The section with the form applied, or null (and errors shown) when invalid. */
  const build = () => {
    const next = fromForm(value ?? {}, form, fields);
    const found = issuesByField(validateFields(fields, next, content, schema), fields);
    setErrors(found);
    if (Object.keys(found).length) {
      toast('error', 'Please fix the highlighted fields.');
      return null;
    }
    return next;
  };

  const save = async () => {
    const next = build();
    if (next) await saveAction((c) => ({ ...c, [sectionKey]: next }), `${title} saved.`);
  };

  return (
    <section className="adm-card">
      <header className="adm-card__head">
        <div>
          <h2>{title}</h2>
          {description && <p className="adm-muted">{description}</p>}
        </div>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        noValidate
      >
        <FieldGrid fields={fields} form={form} errors={errors} content={content} onChange={(name, v) => setForm((f) => ({ ...f, [name]: v }))} />
        <div className="adm-form-actions">
          <Button type="submit" variant="primary" disabled={!dirty || Boolean(busy)} busy={busy === 'saving' && dirty}>
            {busy === 'saving' && dirty ? 'Saving…' : 'Save'}
          </Button>
          <Button
            disabled={!dirty}
            onClick={() => {
              const next = build();
              if (next) setPreview({ ...content, [sectionKey]: next });
            }}
          >
            Preview
          </Button>
          <Button
            variant="ghost"
            disabled={!dirty || Boolean(busy)}
            onClick={() => {
              setForm(initial);
              setErrors({});
            }}
          >
            Undo changes
          </Button>
          {dirty && <span className="adm-muted">Unsaved changes</span>}
        </div>
      </form>
      <PreviewDialog content={preview} onClose={() => setPreview(null)} startPath={previewPath} />
    </section>
  );
}

/* ---------- Collections ---------- */

type Editing = { isNew: boolean; original: BaseItem; form: FormValues; id: string; errors: Record<string, string> };

const byOrder = (a: BaseItem, b: BaseItem) => a.displayOrder - b.displayOrder;
const groupValue = (item: BaseItem, groupBy?: string) => (groupBy ? String(getPath(item, groupBy) ?? '') : '');

/** Active items sharing a group, in display order. */
function scopeOf(items: BaseItem[], group: string, groupBy?: string) {
  return items.filter((i) => i.status === 'active' && groupValue(i, groupBy) === group).sort(byOrder);
}

const nextOrder = (items: BaseItem[], group: string, groupBy?: string) =>
  Math.max(0, ...scopeOf(items, group, groupBy).map((i) => i.displayOrder)) + 1;

export function CollectionEditor({ sectionKey, previewPath }: Readonly<{ sectionKey: string; previewPath?: string }>) {
  const { content, busy, schema } = useAdmin();
  const section = schema.sections[sectionKey] as CollectionSection;
  const confirm = useConfirm();
  const toast = useToast();
  const saveAction = useSaveAction();
  const [tab, setTab] = useState<BaseItem['status']>('active');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [preview, setPreview] = useState<Content | null>(null);
  const items = (content[sectionKey] as BaseItem[]) ?? [];
  const { groupBy, singular, fields } = section;
  const Singular = capitalize(singular);
  const locked = Boolean(busy);
  const startPath = previewPath ?? section.preview;

  // Grouping (e.g. skills by category) uses the collection named by the group field's options.
  const groupField = groupBy ? fields.find((f) => f.name === groupBy) : undefined;
  const groupSource = groupField?.optionsFrom;
  const groupItems = groupSource ? ((content[groupSource.section] as BaseItem[]) ?? []) : [];
  const cannotAdd = Boolean(groupSource) && !groupItems.some((g) => g.status !== 'deleted');

  const initialForm = useMemo(() => (editing ? toForm(editing.original, fields) : {}), [editing?.original, fields]);
  const editorDirty = Boolean(editing) && (!same(editing!.form, initialForm) || editing!.id !== editing!.original.id);
  useDirtyGuard(editorDirty);

  /** Saves `fn` applied to this collection's latest list. */
  const saveItems = (fn: (list: BaseItem[]) => BaseItem[], success: string) =>
    saveAction((c) => ({ ...c, [sectionKey]: fn((c[sectionKey] as BaseItem[]) ?? []) }), success);

  const counts = useMemo(() => {
    const c = { active: 0, archived: 0, deleted: 0 };
    for (const i of items) c[i.status]++;
    return c;
  }, [items]);

  const label = (item: BaseItem) => itemLabel(section, item);
  const meta = (item: BaseItem) =>
    (section.metaFields ?? [])
      .map((f) => getPath(item, f))
      .filter((v) => v !== '' && v !== null && v !== undefined)
      .map(String)
      .join(' · ');

  /* ----- editor ----- */

  const openNew = () => {
    const blank = blankItem(schema, sectionKey, content);
    setEditing({ isNew: true, original: blank, form: toForm(blank, fields), id: '', errors: {} });
  };
  const openEdit = (item: BaseItem) => setEditing({ isNew: false, original: item, form: toForm(item, fields), id: item.id, errors: {} });

  const closeEditor = async () => {
    if (editorDirty) {
      const leave = await confirm({ title: 'You have unsaved changes', message: 'Leave this form and lose your changes?', confirmLabel: 'Leave', cancelLabel: 'Stay', danger: true });
      if (!leave) return;
    }
    setEditing(null);
  };

  /** The edited item, validated against the current list, or null (errors shown) when invalid. */
  const buildItem = (): BaseItem | null => {
    if (!editing) return null;
    const others = items.filter((i) => editing.isNew || i.id !== editing.original.id);
    let next = fromForm(editing.original, editing.form, fields);
    const id = editing.id.trim() || uniqueId(label(next), others.map((i) => i.id));
    next = { ...next, id };
    const group = groupValue(next, groupBy);
    if (editing.isNew || group !== groupValue(editing.original, groupBy)) next = { ...next, displayOrder: nextOrder(others, group, groupBy) };

    const issues = validateItem(section, next, content, schema);
    if (others.some((i) => i.id === id)) issues.push({ path: 'id', message: 'Another entry already uses this ID.' });
    if (id && !ID_PATTERN.test(id)) issues.push({ path: 'id', message: 'Use lowercase letters, numbers and hyphens.' });
    const errors = issuesByField(issues, fields);
    setEditing({ ...editing, errors });
    if (Object.keys(errors).length) {
      toast('error', 'Please fix the highlighted fields.');
      return null;
    }
    return next;
  };

  const withItem = (list: BaseItem[], next: BaseItem, ed: Editing) => (ed.isNew ? [...list, next] : list.map((i) => (i.id === ed.original.id ? next : i)));

  const saveEditor = async () => {
    const ed = editing;
    const next = buildItem();
    if (!ed || !next) return;
    const ok = await saveItems((list) => withItem(list, next, ed), `${Singular} ${ed.isNew ? 'added' : 'updated'} successfully.`);
    if (ok) setEditing(null);
  };

  const previewEditor = () => {
    const ed = editing;
    const next = buildItem();
    if (ed && next) setPreview({ ...content, [sectionKey]: withItem(items, next, ed) });
  };

  /* ----- list actions (each saves immediately) ----- */

  const patch = (item: BaseItem, changes: Partial<BaseItem>, success: string) =>
    saveItems((list) => list.map((i) => (i.id === item.id ? { ...i, ...changes } : i)), success);

  const move = (item: BaseItem, dir: -1 | 1) =>
    saveItems((list) => {
      const scope = scopeOf(list, groupValue(item, groupBy), groupBy);
      const at = scope.findIndex((i) => i.id === item.id);
      const to = at + dir;
      if (at < 0 || to < 0 || to >= scope.length) return list;
      [scope[at], scope[to]] = [scope[to], scope[at]];
      // Renumber the whole group so displayOrder stays a clean 1..n sequence.
      const order = new Map(scope.map((i, n) => [i.id, n + 1]));
      return list.map((i) => (order.has(i.id) ? { ...i, displayOrder: order.get(i.id)! } : i));
    }, 'Order saved.');

  const setStatus = async (item: BaseItem, status: BaseItem['status']) => {
    if (status === 'deleted') {
      const dependents = Object.entries(schema.sections).filter(
        ([, s]) => s.type === 'collection' && s.fields.some((f) => f.optionsFrom?.section === sectionKey),
      );
      const extra = dependents.length ? ` Entries in ${dependents.map(([, s]) => s.label).join(', ')} that use it also disappear until you restore it.` : '';
      const ok = await confirm({
        title: `Delete ${singular}?`,
        message: `Are you sure you want to delete this ${singular}? "${label(item)}" is removed from the portfolio and moves to Deleted, where you can restore it.${extra}`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
    }
    const changes: Partial<BaseItem> = { status };
    if (status === 'active') changes.displayOrder = nextOrder(items, groupValue(item, groupBy), groupBy);
    const verb = { active: 'restored', archived: 'archived', deleted: 'deleted' }[status];
    await patch(item, changes, `${Singular} ${verb} successfully.`);
  };

  const purge = async (item: BaseItem) => {
    const ok = await confirm({
      title: 'Delete permanently?',
      message: `"${label(item)}" is removed from the content file. It can only be recovered from Version History afterwards.`,
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (ok) await saveItems((list) => list.filter((i) => i.id !== item.id), `${Singular} permanently deleted.`);
  };

  /* ----- rendering ----- */

  const visible = items.filter((i) => i.status === tab);
  const groups = useMemo(() => {
    if (!groupSource || tab !== 'active') return [{ key: '', title: '', items: [...visible].sort(byOrder) }];
    const heads = [...groupItems].sort(byOrder);
    const known = new Set(heads.map((g) => g.id));
    const out = heads.map((g) => {
      const name = String(getPath(g, groupSource.labelField) ?? g.id);
      return { key: g.id, title: g.status === 'active' ? name : `${name} (${g.status})`, items: visible.filter((i) => groupValue(i, groupBy) === g.id).sort(byOrder) };
    });
    const orphans = visible.filter((i) => !known.has(groupValue(i, groupBy)));
    if (orphans.length) out.push({ key: '__none', title: 'No group', items: orphans });
    return out.filter((g) => g.items.length);
  }, [visible, groupSource, groupItems, groupBy, tab]);

  const row = (item: BaseItem, index: number, count: number) => (
    <li key={item.id} className={`adm-row ${item.isVisible ? '' : 'is-hidden'}`}>
      {tab === 'active' && (
        <div className="adm-row__order">
          <button type="button" className="adm-icon-btn" onClick={() => move(item, -1)} disabled={index === 0 || locked} aria-label={`Move ${label(item)} up`} title="Move up">
            ↑
          </button>
          <button type="button" className="adm-icon-btn" onClick={() => move(item, 1)} disabled={index === count - 1 || locked} aria-label={`Move ${label(item)} down`} title="Move down">
            ↓
          </button>
        </div>
      )}
      <div className="adm-row__main">
        <div className="adm-row__title">
          {label(item) || <em>Untitled</em>}
          {!item.isVisible && <span className="adm-badge">Hidden</span>}
          {item.featured === true && <span className="adm-badge adm-badge--accent">Featured</span>}
          {item.isCurrent === true && <span className="adm-badge adm-badge--accent">Current</span>}
        </div>
        {meta(item) && <div className="adm-row__meta">{meta(item)}</div>}
      </div>
      <div className="adm-row__actions">
        {tab === 'active' && (
          <>
            <Toggle label="Visible" checked={item.isVisible} disabled={locked} onChange={(v) => patch(item, { isVisible: v }, `${Singular} ${v ? 'shown' : 'hidden'}.`)} />
            <Button size="sm" onClick={() => openEdit(item)} disabled={locked}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStatus(item, 'archived')} disabled={locked}>
              Archive
            </Button>
            <Button size="sm" variant="danger" onClick={() => setStatus(item, 'deleted')} disabled={locked}>
              Delete
            </Button>
          </>
        )}
        {tab !== 'active' && (
          <Button size="sm" onClick={() => setStatus(item, 'active')} disabled={locked}>
            Restore
          </Button>
        )}
        {tab === 'archived' && (
          <Button size="sm" variant="danger" onClick={() => setStatus(item, 'deleted')} disabled={locked}>
            Delete
          </Button>
        )}
        {tab === 'deleted' && (
          <Button size="sm" variant="danger" onClick={() => purge(item)} disabled={locked}>
            Delete permanently
          </Button>
        )}
      </div>
    </li>
  );

  const saving = busy === 'saving';

  return (
    <section className="adm-card">
      <header className="adm-card__head">
        <div>
          <h2>{section.label}</h2>
          {section.description && <p className="adm-muted">{section.description}</p>}
          {cannotAdd && <p className="adm-muted">Add a {groupField?.label.toLowerCase()} first.</p>}
        </div>
        <Button variant="primary" onClick={openNew} disabled={locked || cannotAdd}>
          + Add {singular}
        </Button>
      </header>

      <div className="adm-tabs" role="tablist" aria-label={`${section.label} by status`}>
        {(['active', 'archived', 'deleted'] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={tab === s} className="adm-tab" onClick={() => setTab(s)}>
            {capitalize(s)} <span className="adm-count">{counts[s]}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState>{tab === 'active' ? `Nothing here yet. Use "+ Add ${singular}" to create one.` : `Nothing ${tab}.`}</EmptyState>
      ) : (
        groups.map((g) => (
          <div key={g.key} className="adm-group">
            {g.title && <h3 className="adm-group__title">{g.title}</h3>}
            <ul className="adm-list">{g.items.map((item, n) => row(item, n, g.items.length))}</ul>
          </div>
        ))
      )}

      <Dialog
        open={Boolean(editing)}
        wide
        title={editing ? `${editing.isNew ? 'Add' : 'Edit'} ${singular}` : ''}
        onClose={closeEditor}
        actions={
          <>
            <Button onClick={closeEditor} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={previewEditor} disabled={saving}>
              Preview
            </Button>
            <Button variant="primary" type="submit" form={`edit-${sectionKey}`} busy={saving} disabled={locked}>
              {saving ? 'Saving…' : editing?.isNew ? `Add ${singular}` : 'Save changes'}
            </Button>
          </>
        }
      >
        {editing && (
          <form
            id={`edit-${sectionKey}`}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              saveEditor();
            }}
          >
            <p className="adm-muted adm-form-note">Saving updates the portfolio. Use Preview to check it first.</p>
            <FieldGrid
              fields={fields}
              form={editing.form}
              errors={editing.errors}
              content={content}
              onChange={(name, v) => setEditing((ed) => ed && { ...ed, form: { ...ed.form, [name]: v } })}
            />
            <details className="adm-advanced" open={Boolean(editing.errors.id)}>
              <summary>Advanced</summary>
              <TextField
                label="ID"
                value={editing.id}
                onChange={(v) => setEditing((ed) => ed && { ...ed, id: v })}
                placeholder={editing.isNew ? 'Generated from the name' : ''}
                error={editing.errors.id}
                hint={section.idHint ?? 'Internal identifier. Leave empty on new entries to generate one.'}
              />
            </details>
          </form>
        )}
      </Dialog>
      <PreviewDialog content={preview} onClose={() => setPreview(null)} startPath={startPath} />
    </section>
  );
}
