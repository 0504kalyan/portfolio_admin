// The schema engine. Every portfolio describes its own content in content/schema.json; this module
// turns that description into normalization, validation and change summaries. The admin UI and the
// API both use it, so the portfolios' content models never have to be coded into the admin.

/* ---------- Schema format ---------- */

export type FieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'tel'
  | 'url'
  | 'asset'
  | 'date'
  | 'color'
  | 'toggle'
  | 'select'
  | 'list'
  | 'multiselect'
  | 'number'
  | 'objectList';

export interface Field {
  /** Property name; dotted for nested objects (`quote.text`, `project.client`). */
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  wide?: boolean;
  /** asset: which uploads the picker accepts. */
  accept?: 'image' | 'document';
  /** select / multiselect: fixed options. */
  options?: { value: string; label: string }[];
  /** select / multiselect: options are the ids of another collection's items. */
  optionsFrom?: { section: string; labelField: string };
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
  patternMessage?: string;
  /** list: every entry must appear verbatim in this sibling text field. */
  mustAppearIn?: string;
  /** objectList: the fields of each entry (text, textarea or list). */
  fields?: Field[];
  /** objectList: which sub-field names an entry, e.g. "title". */
  itemLabel?: string;
  /** Starting value for new items. */
  default?: string | number | boolean;
}

export interface DateRangeRule {
  type: 'dateRange';
  start: string;
  end: string;
  /** Toggle meaning "ongoing": the end date may be empty when it's on. */
  current?: string;
  /** Require an end date unless `current` is on. */
  requireEnd?: boolean;
}

export interface ObjectSection {
  type: 'object';
  label: string;
  fields: Field[];
}

export interface CollectionSection {
  type: 'collection';
  label: string;
  singular: string;
  description?: string;
  /** Field shown as the entry's title in lists and commit messages. */
  labelField: string;
  /** Fields shown under the title in lists. */
  metaFields?: string[];
  /** Order entries within groups of this field (e.g. skills within a category). */
  groupBy?: string;
  /** Hint shown for the ID (e.g. when it appears in URLs). */
  idHint?: string;
  fields: Field[];
  rules?: DateRangeRule[];
  /** Portfolio page to open when previewing this collection. */
  preview?: string;
}

export type Section = ObjectSection | CollectionSection;

export interface PageSection {
  section: string;
  title?: string;
  description?: string;
  /** Object sections only: show just these fields. */
  fields?: string[];
  preview?: string;
}

export interface Page {
  id: string;
  label: string;
  description?: string;
  sections: PageSection[];
}

export interface Schema {
  schemaVersion: number;
  /** Portfolio pages the preview can open: router paths ("/works") or anchors ("#skills"). */
  previewPages: { path: string; label: string }[];
  sections: Record<string, Section>;
  pages: Page[];
}

export type Content = Record<string, unknown>;
export interface BaseItem {
  id: string;
  displayOrder: number;
  isVisible: boolean;
  status: 'active' | 'archived' | 'deleted';
  [field: string]: unknown;
}
export interface Issue {
  /** `section.field` or `section.itemId.field`. */
  path: string;
  message: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/* ---------- Paths ---------- */

export const getPath = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);

export function setPath<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  const src = (isObj(obj) ? obj : {}) as Obj;
  return { ...src, [head]: rest.length ? setPath(src[head], rest.join('.'), value) : value } as T;
}

/* ---------- Schema sanity check ---------- */

const FIELD_TYPES: FieldType[] = ['text', 'textarea', 'email', 'tel', 'url', 'asset', 'date', 'color', 'toggle', 'select', 'list', 'multiselect', 'number', 'objectList'];

/** Throws with a readable message if a portfolio's schema.json is malformed. */
export function checkSchema(raw: unknown): Schema {
  const fail = (m: string): never => {
    throw new Error(`Invalid schema.json: ${m}`);
  };
  if (!isObj(raw) || !isObj(raw.sections) || !Array.isArray(raw.pages)) fail('expected { sections, pages }');
  const s = raw as unknown as Schema;
  const checkFields = (fields: Field[], where: string) => {
    if (!Array.isArray(fields)) fail(`${where}: fields must be an array`);
    for (const f of fields) {
      if (!f.name || !f.label || !FIELD_TYPES.includes(f.type)) fail(`${where}: bad field ${JSON.stringify(f.name)}`);
      if (f.type === 'objectList') checkFields(f.fields ?? [], `${where}.${f.name}`);
    }
  };
  for (const [key, sec] of Object.entries(s.sections)) {
    if (sec.type !== 'object' && sec.type !== 'collection') fail(`section ${key}: type must be object or collection`);
    checkFields(sec.fields, key);
    if (sec.type === 'collection' && (!sec.singular || !sec.labelField)) fail(`section ${key}: collections need singular and labelField`);
  }
  for (const p of s.pages) for (const ps of p.sections) if (!s.sections[ps.section]) fail(`page ${p.id}: unknown section ${ps.section}`);
  s.previewPages ??= [{ path: '/', label: 'Home' }];
  return s;
}

/* ---------- Normalization ---------- */

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

function coerce(f: Field, v: unknown): unknown {
  switch (f.type) {
    case 'toggle':
      return v === true;
    case 'number': {
      const n = typeof v === 'number' ? v : Number(str(v));
      return str(v) === '' || !Number.isFinite(n) ? null : n;
    }
    case 'list':
    case 'multiselect':
      return Array.isArray(v) ? v.map(str).filter(Boolean) : [];
    case 'objectList':
      return Array.isArray(v) ? v.map((entry) => pickFields(isObj(entry) ? entry : {}, f.fields ?? [])) : [];
    default:
      return str(v);
  }
}

function pickFields(raw: Obj, fields: Field[]): Obj {
  let out: Obj = {};
  for (const f of fields) out = setPath(out, f.name, coerce(f, getPath(raw, f.name)));
  return out;
}

const STATUSES = ['active', 'archived', 'deleted'];

/**
 * Rebuilds content from untrusted input using the schema: keeps only described fields, coerces
 * their types, fills missing ones. Key order follows the schema, so saved files stay stable.
 */
export function normalizeContent(schema: Schema, input: unknown): Content {
  const raw = isObj(input) ? input : {};
  const out: Content = { schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : schema.schemaVersion };
  for (const [key, sec] of Object.entries(schema.sections)) {
    if (sec.type === 'object') {
      out[key] = pickFields(isObj(raw[key]) ? raw[key] : {}, sec.fields);
      continue;
    }
    const list = Array.isArray(raw[key]) ? (raw[key] as unknown[]) : [];
    out[key] = list.map((entry, i) => {
      const r = isObj(entry) ? entry : {};
      const order = Number(r.displayOrder);
      return {
        id: str(r.id),
        displayOrder: Number.isFinite(order) ? order : i + 1,
        isVisible: r.isVisible !== false,
        status: STATUSES.includes(r.status as string) ? r.status : 'active',
        ...pickFields(r, sec.fields),
      };
    });
  }
  return out;
}

/** A new, empty collection item with the schema's defaults (select fields start on their first option). */
export function blankItem(schema: Schema, key: string, content: Content): BaseItem {
  const sec = schema.sections[key];
  let item: Obj = { id: '', displayOrder: 0, isVisible: true, status: 'active' };
  for (const f of sec.fields) {
    const first = f.type === 'select' ? selectOptions(f, content, schema)[0]?.value : undefined;
    item = setPath(item, f.name, coerce(f, f.default ?? first));
  }
  return item as BaseItem;
}

/* ---------- Validation ---------- */

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const DATE_PATTERN = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s()-]{6,20}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const LIMITS = { text: 300, textarea: 5000, listItem: 2000, listLength: 100, collection: 500 };

export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/** Site-relative path ("/profile.jpg") or http(s) URL. */
export const isAssetUrl = (v: string) => (/^\/(?!\/)\S*$/.test(v) && !v.includes('..')) || isHttpUrl(v);

export const dateKey = (v: string) => {
  const [y, m = '01'] = v.split('-');
  return Number(y) * 12 + Number(m) - 1;
};

/** Issues for a set of fields on one object. Paths are field names (sub-entries: `steps.2.title`). */
export function validateFields(fields: Field[], value: unknown, content: Content, schema: Schema, prefix = ''): Issue[] {
  const issues: Issue[] = [];
  const push = (name: string, message: string) => issues.push({ path: prefix + name, message });
  for (const f of fields) {
    const v = getPath(value, f.name);
    const text = typeof v === 'string' ? v : '';
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (f.required && empty && f.type !== 'toggle') {
      push(f.name, `${f.label} is required.`);
      continue;
    }
    if (empty) continue;
    const max = f.maxLength ?? (f.type === 'textarea' ? LIMITS.textarea : LIMITS.text);
    switch (f.type) {
      case 'list': {
        const list = v as string[];
        if (list.length > LIMITS.listLength) push(f.name, `Use at most ${LIMITS.listLength} entries.`);
        if (list.some((s) => s.length > (f.maxLength ?? LIMITS.listItem))) push(f.name, `Keep each entry under ${f.maxLength ?? LIMITS.listItem} characters.`);
        if (f.mustAppearIn) {
          const source = String(getPath(value, f.mustAppearIn) ?? '');
          const missing = list.filter((s) => !source.includes(s));
          if (missing.length) push(f.name, `These must appear exactly in the text: ${missing.join(', ')}`);
        }
        break;
      }
      case 'multiselect': {
        const list = v as string[];
        if (list.length > LIMITS.collection) push(f.name, `Pick at most ${LIMITS.collection}.`);
        // References to another collection may outlive the item (deleted later); the site ignores
        // unknown ids, so only fixed options are enforced.
        if (!f.optionsFrom) {
          const allowed = new Set(selectOptions(f, content, schema).map((o) => o.value));
          if (list.some((s) => !allowed.has(s))) push(f.name, 'Pick from the options.');
        }
        break;
      }
      case 'objectList': {
        const list = v as unknown[];
        if (list.length > LIMITS.listLength) push(f.name, `Use at most ${LIMITS.listLength} entries.`);
        list.forEach((entry, i) => issues.push(...validateFields(f.fields ?? [], entry, content, schema, `${prefix}${f.name}.${i}.`)));
        break;
      }
      case 'number': {
        const n = v as number;
        if (typeof n !== 'number' || !Number.isFinite(n)) push(f.name, 'Enter a number.');
        else if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) push(f.name, `Enter a number between ${f.min ?? '…'} and ${f.max ?? '…'}.`);
        break;
      }
      case 'toggle':
        break;
      default: {
        if (text.length > max) push(f.name, `Keep this under ${max} characters.`);
        if (f.type === 'email' && !EMAIL.test(text)) push(f.name, 'Enter a valid email address.');
        if (f.type === 'tel' && !PHONE.test(text)) push(f.name, 'Enter a valid phone number, e.g. +91 8885394611.');
        if (f.type === 'url' && !isHttpUrl(text)) push(f.name, 'Enter a full URL starting with https://');
        if (f.type === 'asset' && !isAssetUrl(text)) push(f.name, 'Enter a site path like /file.pdf or a full https:// URL.');
        if (f.type === 'date' && !DATE_PATTERN.test(text)) push(f.name, 'Use YYYY-MM or YYYY.');
        if (f.type === 'color' && !HEX.test(text)) push(f.name, 'Use a hex colour like #C778DD.');
        if (f.type === 'select') {
          const allowed = selectOptions(f, content, schema).map((o) => o.value);
          if (!allowed.includes(text)) push(f.name, 'Pick one of the options.');
        }
        if (f.pattern && !new RegExp(f.pattern).test(text)) push(f.name, f.patternMessage ?? 'This value has the wrong format.');
        if (f.type === 'text' && text.includes('[') && (text.match(/\[/g)?.length ?? 0) !== (text.match(/\]/g)?.length ?? 0)) {
          push(f.name, 'Every [ needs a matching ].');
        }
      }
    }
  }
  return issues;
}

/** Options for a select or multiselect: fixed, or the (non-deleted) items of another collection. */
export function selectOptions(f: Field, content: Content, schema: Schema): { value: string; label: string }[] {
  if (f.optionsFrom) {
    const items = (content[f.optionsFrom.section] as BaseItem[] | undefined) ?? [];
    const base = schema.sections[f.optionsFrom.section];
    if (!base) return [];
    return items.filter((i) => i.status !== 'deleted').map((i) => ({ value: i.id, label: String(i[f.optionsFrom!.labelField] ?? i.id) }));
  }
  return f.options ?? [];
}

/** Issues for one collection item: its fields, the collection's rules and the ID. */
export function validateItem(section: CollectionSection, item: BaseItem, content: Content, schema: Schema): Issue[] {
  const issues = validateFields(section.fields, item, content, schema);
  if (!ID_PATTERN.test(item.id)) issues.push({ path: 'id', message: 'ID must be lowercase letters, numbers and hyphens.' });
  for (const rule of section.rules ?? []) {
    const start = String(item[rule.start] ?? '');
    const end = String(item[rule.end] ?? '');
    const current = rule.current ? item[rule.current] === true : false;
    if (rule.requireEnd && !current && !end) issues.push({ path: rule.end, message: 'Set an end date, or mark this as current.' });
    if (!current && start && end && DATE_PATTERN.test(start) && DATE_PATTERN.test(end) && dateKey(start) > dateKey(end)) {
      issues.push({ path: rule.end, message: 'End date must be on or after the start date.' });
    }
  }
  return issues;
}

/** Every issue in the document. Empty means it can be saved. */
export function validateContent(schema: Schema, content: Content): Issue[] {
  const issues: Issue[] = [];
  for (const [key, sec] of Object.entries(schema.sections)) {
    if (sec.type === 'object') {
      for (const i of validateFields(sec.fields, content[key], content, schema)) issues.push({ path: `${key}.${i.path}`, message: i.message });
      continue;
    }
    const items = (content[key] as BaseItem[]) ?? [];
    if (items.length > LIMITS.collection) issues.push({ path: key, message: `Too many entries (max ${LIMITS.collection}).` });
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) issues.push({ path: `${key}.${item.id}.id`, message: `Duplicate ID "${item.id}".` });
      seen.add(item.id);
      for (const i of validateItem(sec, item, content, schema)) issues.push({ path: `${key}.${item.id}.${i.path}`, message: i.message });
    }
  }
  return issues;
}

/* ---------- IDs ---------- */

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

export function uniqueId(text: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(text);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

/* ---------- Change summaries ---------- */

export function itemLabel(section: CollectionSection, item: BaseItem): string {
  return String(getPath(item, section.labelField) || item.id).slice(0, 60);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One line per change ("Add project: VoiceChat", "Update profile"). Empty when nothing changed. */
export function describeChanges(schema: Schema, prev: Content, next: Content): string[] {
  const lines: string[] = [];
  for (const [key, sec] of Object.entries(schema.sections)) {
    if (sec.type === 'object') {
      if (!same(prev[key], next[key])) lines.push(`Update ${sec.label.toLowerCase()}`);
      continue;
    }
    const before = new Map(((prev[key] as BaseItem[]) ?? []).map((i) => [i.id, i]));
    const after = new Map(((next[key] as BaseItem[]) ?? []).map((i) => [i.id, i]));
    let reordered = false;
    for (const [id, item] of after) {
      const old = before.get(id);
      const label = itemLabel(sec, item);
      const { displayOrder: _a, ...a } = old ?? ({} as BaseItem);
      const { displayOrder: _b, ...b } = item;
      if (!old) lines.push(`Add ${sec.singular}: ${label}`);
      else if (old.status !== item.status) {
        const verb = item.status === 'deleted' ? 'Delete' : item.status === 'archived' ? 'Archive' : 'Restore';
        lines.push(`${verb} ${sec.singular}: ${label}`);
      } else if (old.isVisible !== item.isVisible) lines.push(`${item.isVisible ? 'Show' : 'Hide'} ${sec.singular}: ${label}`);
      else if (!same(a, b)) lines.push(`Update ${sec.singular}: ${label}`);
      else if (old.displayOrder !== item.displayOrder) reordered = true;
    }
    for (const [id, item] of before) if (!after.has(id)) lines.push(`Permanently remove ${sec.singular}: ${itemLabel(sec, item)}`);
    if (reordered) lines.push(`Reorder ${sec.label.toLowerCase()}`);
  }
  return lines;
}

export function commitMessage(changes: string[], subjectOverride?: string): string {
  const subject = subjectOverride?.trim() || (changes.length <= 2 ? changes.join('; ') : `${changes[0]} and ${changes.length - 1} more changes`);
  const body = changes.length > 1 || subjectOverride ? `\n\n${changes.map((c) => `- ${c}`).join('\n')}` : '';
  return `${(subject || 'Update portfolio content').slice(0, 120)}${body}`;
}
