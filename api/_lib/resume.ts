// Reads an uploaded resume (PDF, DOC or DOCX) into draft portfolio content with plain rules, no AI:
// the file's text is extracted (unpdf for PDFs, word-extractor for Word), split into sections by
// common headings, and mapped to the portfolio's fields (contact details, summary, skills,
// experience, education, projects, certifications). Job roles come from keyword templates
// (roleTemplates.ts). The person reviews and fixes everything before publishing.
import { extractText, getDocumentProxy } from 'unpdf';
import WordExtractor from 'word-extractor';
import {
  getPath,
  ID_PATTERN,
  normalizeContent,
  setPath,
  slugify,
  uniqueId,
  validateContent,
  type BaseItem,
  type Content,
  type Field,
  type Schema,
} from '../../lib/schema.js';
import { ApiError } from './http.js';
import { roleTemplates } from './roleTemplates.js';

export type ResumeKind = 'pdf' | 'docx' | 'doc';

/** The resume's format from its extension, checked against the file's signature. */
export function resumeKind(fileName: string, bytes: Uint8Array): ResumeKind {
  const ext = fileName.toLowerCase().split('.').pop();
  const sig = (n: number) => Array.from(bytes.slice(0, n));
  const ok =
    (ext === 'pdf' && String.fromCharCode(...sig(4)) === '%PDF') ||
    (ext === 'docx' && sig(2).join() === '80,75') || // zip
    (ext === 'doc' && sig(4).join() === '208,207,17,224'); // OLE compound file
  if (!ok) throw new ApiError(400, 'bad_file_type', 'Upload your resume as a PDF, DOC or DOCX file.');
  return ext as ResumeKind;
}

/* ---------- Text extraction ---------- */

async function resumeText(kind: ResumeKind, bytes: Uint8Array): Promise<string> {
  try {
    if (kind === 'pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: false });
      return (text as string[]).join('\n');
    }
    const doc = await new WordExtractor().extract(Buffer.from(bytes));
    return [doc.getHeaders({ includeFooters: false }), doc.getTextboxes({ includeHeadersAndFooters: false, includeBody: true }), doc.getBody()]
      .filter((t) => t.trim())
      .join('\n');
  } catch (err) {
    console.error(`[resume] could not read ${kind}`, err);
    throw new ApiError(422, 'unreadable_file', "That file couldn't be read. Check it isn't password-protected, or save it again as a PDF or DOCX.");
  }
}

/* ---------- Dates ---------- */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE = String.raw`(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s*'?\d{2,4}|\d{1,2}[/.-]\d{4}|\d{4})`;
const NOW = String.raw`(?:present|current|now|till\s+date|to\s+date|ongoing|today)`;
const RANGE = new RegExp(`(${DATE})\\s*(?:-|–|—|to|till|until)\\s*(${DATE}|${NOW})`, 'i');

/** "November 2025" → "2025-11", "07/2020" → "2020-07", "2020" → "2020"; "" if unreadable. */
function toDate(text: string): string {
  const t = text.trim().toLowerCase();
  const named = t.match(/^([a-z]+)\.?,?\s*'?(\d{2,4})$/);
  if (named) {
    const m = MONTHS.indexOf(named[1].slice(0, 3));
    const y = named[2].length === 2 ? `20${named[2]}` : named[2];
    return m >= 0 ? `${y}-${String(m + 1).padStart(2, '0')}` : y;
  }
  const numeric = t.match(/^(\d{1,2})[/.-](\d{4})$/);
  if (numeric && +numeric[1] >= 1 && +numeric[1] <= 12) return `${numeric[2]}-${numeric[1].padStart(2, '0')}`;
  return /^\d{4}$/.test(t) ? t : '';
}

/** The first date range in `text`: start, end ("" when current) and whether it runs to the present. */
function findRange(text: string) {
  const m = text.match(RANGE);
  if (!m) return null;
  const current = new RegExp(`^${NOW}$`, 'i').test(m[2].trim());
  return { start: toDate(m[1]), end: current ? '' : toDate(m[2]), current, match: m[0] };
}

/* ---------- Lines and sections ---------- */

type Line = { text: string; bullet: boolean };
type SectionKey = 'summary' | 'skills' | 'experience' | 'education' | 'projects' | 'certifications' | 'achievements';

const HEADINGS: [SectionKey, RegExp][] = [
  ['summary', /^(professional\s+|career\s+|executive\s+)?(summary|profile|objective|about(\s+me)?|overview)$/],
  ['skills', /^((technical|key|core|professional)\s+)?(skills?|skill\s*set|competencies|expertise|technologies|tech\s+stack)(\s+(summary|set))?$/],
  ['experience', /^((professional|work|employment|career|relevant)\s+)?(experience|history|employment)(\s+(summary|details|history))?$/],
  ['education', /^(education(al)?(\s+(qualifications?|background|details))?|academic(s|\s+(qualifications?|background|details))?|qualifications?)$/],
  ['projects', /^((key|major|academic|personal|professional|client)\s+)?projects?(\s+(undertaken|experience|details|handled|summary))?$/],
  ['certifications', /^(certifications?|licen[cs]es?(\s+(and|&)\s+certifications?)?|courses|trainings?(\s+(and|&)\s+certifications?)?)$/],
  ['achievements', /^(achievements?|awards?(\s+(and|&)\s+achievements?)?|honou?rs|accomplishments)$/],
];

/** A heading line ("Skills", "WORK EXPERIENCE:", "Education : B.Sc …") → its section and any text after the colon. */
function heading(text: string): { key: SectionKey; rest: string } | null {
  const [, head, rest = ''] = text.match(/^([A-Za-z &/]{3,40}?)\s*(?::\s*(.*))?$/) ?? text.match(/^([A-Za-z &/]{3,40}?)\s*:\s*(.*)$/) ?? [];
  if (!head) return null;
  const h = head.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [key, re] of HEADINGS) if (re.test(h)) return { key, rest: rest.trim() };
  return null;
}

const BULLET = /^[\s]*([•●▪◦■□➢➤►▶✓✔◆◇*·⚫\-–—]|\d{1,2}[.)])\s+/u;

/** Labelled fields that often share one line ("Technology : C#, … Description : …") get their own lines. */
const LABELS = String.raw`duration|period|technolog(?:y|ies)|environment|tech\s*stack|tools|description|responsibilit(?:y|ies)|role|client|team\s*size|link|url`;

function toLines(text: string): Line[] {
  return text
    .replace(/\r/g, '')
    .replace(new RegExp(`\\s+(?=(?:${LABELS})\\s*:)`, 'gi'), (s, offset: number, all: string) => (all[offset - 1] === '\n' ? s : '\n'))
    .split('\n')
    .map((raw) => {
      const bullet = BULLET.test(raw) || /^[\s]*[•●⚫]/u.test(raw);
      const t = raw.replace(BULLET, '').replace(/^[\s•●⚫]+/u, '').replace(/\s+/g, ' ').trim();
      return { text: t, bullet };
    })
    .filter((l) => l.text);
}

/* ---------- Contact details ---------- */

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const PHONE = /(\+?\d[\d\s().-]{8,}\d)/;
const URL_RE = /\bhttps?:\/\/[^\s,;)]+|\b(?:www\.)?(?:linkedin\.com|github\.com|x\.com|twitter\.com)\/[^\s,;)]+/gi;
const isContact = (t: string) => EMAIL.test(t) || (PHONE.test(t) && t.replace(/\D/g, '').length >= 10 && t.length < 40) || /https?:\/\/|linkedin\.com|github\.com/i.test(t);

function contacts(text: string) {
  const urls = (text.match(URL_RE) ?? []).map((u) => (/^https?:/i.test(u) ? u : `https://${u}`).replace(/[.]+$/, ''));
  const phone = text.split('\n').map((l) => l.match(PHONE)?.[1]).find((p) => p && p.replace(/\D/g, '').length >= 10 && p.replace(/\D/g, '').length <= 15);
  return {
    email: text.match(EMAIL)?.[0] ?? '',
    phone: phone?.replace(/\s+/g, ' ').trim() ?? '',
    linkedin: urls.find((u) => /linkedin\.com/i.test(u)) ?? '',
    github: urls.find((u) => /github\.com/i.test(u)) ?? '',
    twitter: urls.find((u) => /(twitter|x)\.com/i.test(u)) ?? '',
    website: urls.find((u) => !/linkedin|github|twitter|x\.com/i.test(u)) ?? '',
  };
}

/** A name from the file name when the resume's text has none ("Resume-Jane-Doe.pdf" → "Jane Doe"). */
function nameFromFile(fileName: string): string {
  const words = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\b(resume|cv|curriculum|vitae|updated|latest|final|new|profile|\d+)\b/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length >= 1 && words.length <= 4 ? words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') : '';
}

const looksLikeName = (t: string) => /^[A-Za-z][A-Za-z.'-]*(\s+[A-Za-z][A-Za-z.'-]*){1,4}$/.test(t) && !heading(t) && t.length <= 40;

/* ---------- Skills ---------- */

const SKILL_GROUPS: [string, RegExp][] = [
  ['Languages', /^(c#|c\+\+|c|java|python|javascript|typescript|go|golang|rust|kotlin|swift|php|ruby|scala|dart|r|t-sql|pl\/sql|sql|bash|shell|vb\.net|html5?|css3?)$/i],
  ['Frameworks', /(react|angular|vue|svelte|next|nuxt|asp\.net|\.net|dot net|spring|django|flask|fastapi|express|nest|laravel|rails|entity frame ?work|dapper|linq|jquery|bootstrap|tailwind|rxjs|redux|nx|module federation|blazor|wcf|mvc|web ?api|flutter|react native)/i],
  ['Databases', /(sql server|ms ?sql|mysql|postgres|oracle|mongo|redis|sqlite|dynamo|cassandra|firebase|rdbms|elastic)/i],
  ['Cloud & DevOps', /(aws|azure|gcp|google cloud|docker|kubernetes|k8s|ci\/cd|jenkins|terraform|ansible|devops|github actions|linux|nginx|container)/i],
  ['Tools', /(git|tfs|jira|visual studio|vs ?code|postman|pgadmin|management studio|figma|copilot|cursor|claude|intellij|eclipse|swagger|npm)/i],
];

const GENERIC_LABELS = /^((technical|key|core)\s+)?(skills?|technologies|tech stack|expertise|competencies|others?)$/i;
const LABEL_GROUPS: [RegExp, string][] = [
  [/language|scripting/i, 'Languages'],
  [/framework|librar|front|back|web/i, 'Frameworks'],
  [/rdbms|database|db\b|data store/i, 'Databases'],
  [/cloud|devops|version control|ci\/cd|infra/i, 'Cloud & DevOps'],
  [/tool|ide|software|platform/i, 'Tools'],
];
/** "RDBMS" → "Databases"; generic labels ("Technical Skills") → none, so the skill is classified by name. */
function labelName(raw: string): string {
  const label = raw.trim();
  if (GENERIC_LABELS.test(label)) return '';
  return LABEL_GROUPS.find(([re]) => re.test(label))?.[1] ?? label;
}

/** "Languages: C#, SQL" / "React, Angular 16, 18 & 20" → skill names (with a category when labelled). */
function parseSkillLine(text: string): { name: string; label: string }[] {
  const out: { name: string; label: string }[] = [];
  let label = '';
  const lead = text.match(/^([A-Za-z &/]{2,30}?)\s*:\s*(.+)$/);
  let rest = text;
  if (lead) {
    label = labelName(lead[1]);
    rest = lead[2];
  }
  const tokens = rest.split(/\s*[,;|•·]\s*/);
  for (let token of tokens) {
    token = token.trim().replace(/[.]+$/, '');
    let own = label;
    const inner = token.match(/^([A-Za-z &/]{2,30}?)\s*:\s*(.+)$/); // "RDBMS:MS SQL"
    if (inner) {
      own = labelName(inner[1].split(/\s+/).slice(-2).join(' '));
      token = inner[2].trim();
    }
    if (!token) continue;
    if (/^[\d\s&.+-]+$/.test(token) && out.length) {
      out[out.length - 1].name += `, ${token}`; // "Angular 16, 18 & 20"
      continue;
    }
    if (token.length > 40 || token.split(/\s+/).length > 5) continue; // a sentence, not a skill
    out.push({ name: token, label: own });
  }
  return out;
}

const categoryOf = (skill: string, label: string) => label || SKILL_GROUPS.find(([, re]) => re.test(skill))?.[0] || 'Other';

/* ---------- Entries (experience, projects, education) ---------- */

const POSITION = /(engineer|developer|analyst|manager|consultant|intern|lead|architect|designer|specialist|administrator|tester|scientist|programmer|associate|officer|executive|trainee)/i;
const DEGREE = /\b(b\.?\s?tech|b\.?\s?e\b|b\.?\s?sc|b\.?\s?com|b\.?\s?a\b|bca|bba|bachelor[a-z]*(\s+of\s+[a-z ]+)?|m\.?\s?tech|m\.?\s?sc|m\.?\s?e\b|mca|mba|m\.?\s?com|master[a-z]*(\s+of\s+[a-z ]+)?|ph\.?\s?d|diploma|intermediate|ssc|hsc|12th|10th|high school|secondary school)\b/i;
const INSTITUTION = /(university|college|institute|school|academy|iit|nit|polytechnic)/i;
const GRADE = /(\d{1,3}(?:\.\d+)?\s*%|(?:c?gpa|cpi)\s*[:\-]?\s*\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)/i;

/** Reads like a sentence (PDF text loses bullet symbols, so these are the entry's details). */
const isSentence = (t: string) => /[.!?]$/.test(t) || t.length > 90 || t.split(/\s+/).length > 9;

type Exp = { company: string; client: string; position: string; startDate: string; endDate: string; isCurrent: boolean; description: string[]; technologies: string[] };

/** "Worked at Acme (Client: Bank) from July 2020 to July 2023." — anywhere in the resume. */
function sentenceExperience(lines: Line[]): Exp[] {
  const re = new RegExp(`\\b(?:working|worked|work|employed)\\s+(?:at|with|for|in)\\s+(.+?)\\s+(?:as\\s+(?:an?\\s+)?(.+?)\\s+)?from\\s+(${DATE})\\s+(?:to|till|until|-)\\s+(${DATE}|${NOW})`, 'i');
  const out: Exp[] = [];
  for (const { text } of lines) {
    const m = text.match(re);
    if (!m) continue;
    const client = m[1].match(/\((?:client\s*:\s*)?([^)]+)\)/i);
    const current = new RegExp(`^${NOW}$`, 'i').test(m[4].trim());
    out.push({
      company: m[1].replace(/\s*\([^)]*\)\s*/g, ' ').trim(),
      client: client?.[1].trim() ?? '',
      position: m[2]?.trim() ?? '',
      startDate: toDate(m[3]),
      endDate: current ? '' : toDate(m[4]),
      isCurrent: current,
      description: [],
      technologies: [],
    });
  }
  return out;
}

/** An experience section: a new entry at each line with a date range; the lines around it name the company and position. */
function sectionExperience(lines: Line[]): Exp[] {
  const out: Exp[] = [];
  let header: string[] = [];
  let current: Exp | null = null;
  for (const l of lines) {
    const range = !l.bullet ? findRange(l.text) : null;
    if (range) {
      const own = l.text.replace(range.match, '').replace(/[|,–—()-]+\s*$/, '').replace(/^\s*[|,–—()-]+/, '').trim();
      const parts = [...header, own].join(' | ').split(/\s*(?:\||–|—|\s-\s|,\s| at )\s*/).map((p) => p.trim()).filter(Boolean);
      const position = parts.find((p) => POSITION.test(p)) ?? '';
      const company = parts.find((p) => p !== position) ?? '';
      current = { company, client: '', position, startDate: range.start, endDate: range.end, isCurrent: range.current, description: [], technologies: [] };
      out.push(current);
      header = [];
      continue;
    }
    const labelled = l.text.match(/^(technolog(?:y|ies)|environment|tech\s*stack|tools)\s*:\s*(.+)$/i);
    if (current && labelled) current.technologies.push(...parseSkillLine(labelled[2]).map((s) => s.name));
    else if (current && (l.bullet || isSentence(l.text))) current.description.push(l.text);
    else if (!l.bullet) header.push(l.text); // company / position lines before the next date range
  }
  return out;
}

type Proj = { title: string; tagline: string; description: string; responsibilities: string[]; startDate: string; endDate: string; isCurrent: boolean; technologies: string[]; liveUrl: string; githubUrl: string };

function sectionProjects(lines: Line[]): Proj[] {
  const out: Proj[] = [];
  let p: Proj | null = null;
  let field = '';
  const start = (title: string): Proj => {
    const m = title.replace(/^(project\s*(#?\d+)?\s*[:.-]\s*|project\s+name\s*:\s*)/i, '').match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    const clean = title.replace(/^(project\s*(#?\d+)?\s*[:.-]\s*|project\s+name\s*:\s*)/i, '').trim();
    const proj: Proj = { title: m ? m[1].trim() : clean, tagline: m ? m[2].trim() : '', description: '', responsibilities: [], startDate: '', endDate: '', isCurrent: false, technologies: [], liveUrl: '', githubUrl: '' };
    out.push(proj);
    field = '';
    return proj;
  };
  const labelRe = new RegExp(`^(${LABELS})\\s*:\\s*(.*)$`, 'i');
  for (const [i, l] of lines.entries()) {
    const label = l.text.match(labelRe);
    if (label && p) {
      const [, name, value] = label;
      const key = name.toLowerCase();
      field = key;
      if (/^(duration|period)/.test(key)) {
        const r = findRange(value);
        if (r) Object.assign(p, { startDate: r.start, endDate: r.end, isCurrent: r.current });
      } else if (/^(technolog|environment|tech|tools)/.test(key)) p.technologies.push(...parseSkillLine(value).map((s) => s.name));
      else if (key === 'description') p.description = value;
      else if (/^(link|url)/.test(key)) (/github\.com/i.test(value) ? (p.githubUrl = value) : (p.liveUrl = value));
      else if (/^responsib/.test(key) && value) p.responsibilities.push(value);
      continue;
    }
    const titleNext = !l.bullet && l.text.length <= 80 && !/[.:]$/.test(l.text) && labelRe.test(lines[i + 1]?.text ?? '');
    if (titleNext) {
      p = start(l.text);
      continue;
    }
    if (l.bullet || (p && isSentence(l.text) && field !== 'description' && p.description)) {
      p ??= start('Project');
      p.responsibilities.push(l.text);
      continue;
    }
    // A short line that doesn't end a sentence starts a project; longer lines continue the description.
    const range = findRange(l.text);
    if (!p || (l.text.length <= 80 && !/[.:]$/.test(l.text) && field !== 'description') || (range && l.text.length <= 100 && !p.description)) {
      p = start(range ? l.text.replace(range.match, '').replace(/[|,–—()-]+\s*$/, '').trim() || 'Project' : l.text);
      if (range) Object.assign(p, { startDate: range.start, endDate: range.end, isCurrent: range.current });
    } else if (field === 'description' || !p.description) p.description = [p.description, l.text].filter(Boolean).join(' ');
    else p.responsibilities.push(l.text);
  }
  return out.filter((x) => x.title && x.title !== 'Project');
}

function sectionEducation(lines: Line[]) {
  const out: { institution: string; degree: string; field: string; startDate: string; endDate: string; grade: string }[] = [];
  for (const { text } of lines) {
    const degree = text.match(DEGREE)?.[0];
    const last = out[out.length - 1];
    if (!degree && !INSTITUTION.test(text)) {
      if (last && !last.grade) last.grade = text.match(GRADE)?.[0] ?? '';
      continue;
    }
    const years = text.match(/\b(19|20)\d{2}\b/g) ?? [];
    const range = findRange(text);
    const parts = text.split(/\s*(?:\||–|—|\s-\s|,\s)\s*/).map((p) => p.replace(/\(.*?\)/g, '').trim()).filter(Boolean);
    const institution = parts.find((p) => INSTITUTION.test(p)) ?? '';
    const entry = {
      degree: degree ? degree.trim() : '',
      field: text.match(/\b(?:in|of)\s+([A-Z][A-Za-z &]+?)(?=\s*(?:[,|(–—-]|from|at|$))/)?.[1]?.trim() ?? '',
      institution: institution || parts.find((p) => !DEGREE.test(p) && !/^\d/.test(p)) || '',
      startDate: range?.start ?? (years.length > 1 ? (years[0] ?? '') : ''),
      endDate: range?.end ?? (years[years.length - 1] ?? ''),
      grade: text.match(GRADE)?.[0] ?? '',
    };
    if (!degree && last && !last.institution) last.institution = entry.institution;
    else out.push(entry);
  }
  return out;
}

/* ---------- Putting it together ---------- */

const ACCENTS = ['#C778DD', '#4F9CF9', '#3FB68B', '#F2A541', '#E5576B', '#7A6FF0'];
const sentences = (t: string) =>
  t
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((x) => x.trim())
    .filter(Boolean);

/** At most `max` characters, cut at a word boundary. */
const clip = (t: string, max: number) => (t.length <= max ? t : `${t.slice(0, t.lastIndexOf(' ', max)).replace(/[,;:]$/, '')}…`);

/** Up to three paragraphs of about 350 characters from the summary. */
function paragraphs(text: string): string[] {
  const out: string[] = [];
  for (const s of sentences(text)) {
    if (out.length && out[out.length - 1].length + s.length < 350) out[out.length - 1] += ` ${s}`;
    else out.push(s);
  }
  return out.slice(0, 4);
}

const matches = (text: string, keyword: string) => new RegExp(`(^|[^a-z0-9])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9#+])`, 'i').test(text);

/** Reads the resume and returns normalized draft content (not yet saved). */
export async function readResume(schema: Schema, fileName: string, bytes: Uint8Array): Promise<Content> {
  const kind = resumeKind(fileName, bytes);
  const text = await resumeText(kind, bytes);
  if (text.replace(/\s/g, '').length < 100) {
    throw new ApiError(422, 'no_text', "We couldn't find any text in this file. If it's a scanned image, upload a PDF or Word file with real text instead.");
  }
  const lines = toLines(text);

  // Split into sections. Lines before the first heading are the header (name, contacts) and, for
  // resumes without headings, the summary (long prose) and skills (comma lists).
  const sections: Record<SectionKey | 'top', Line[]> = { top: [], summary: [], skills: [], experience: [], education: [], projects: [], certifications: [], achievements: [] };
  let at: SectionKey | 'top' = 'top';
  for (const l of lines) {
    const h = !l.bullet && l.text.length <= 60 ? heading(l.text) : null;
    // "Technology : …" inside a project is a project field, not the start of a skills section.
    if (h && !(h.key === 'skills' && (at === 'projects' || at === 'experience') && h.rest)) {
      at = h.key;
      if (h.rest) sections[at].push({ text: h.rest, bullet: false });
      continue;
    }
    sections[at].push(l);
  }
  for (const l of sections.top) {
    if (isContact(l.text)) continue;
    if (l.text.length >= 150 && !sections.summary.length) sections.summary.push(l);
    else if ((l.text.match(/,/g)?.length ?? 0) >= 4 && l.text.length < 600) sections.skills.push(l);
  }

  // Header: name, location.
  const c = contacts(text);
  const top = sections.top.slice(0, 8).map((l) => l.text);
  const name = top.find(looksLikeName) ?? nameFromFile(fileName);
  const location = top.find((t) => !isContact(t) && t !== name && /,/.test(t) && t.length < 140 && t.length > 8 && !/[.]{2}/.test(t) && (t.match(/,/g)?.length ?? 0) <= 5 && t.split(' ').length <= 16) ?? '';

  // Summary.
  const summary = sections.summary.map((l) => l.text).join(' ').trim();

  // Skills, grouped into categories.
  const seen = new Set<string>();
  const skillList: { id: string; name: string; category: string }[] = [];
  const categories: { id: string; name: string }[] = [];
  for (const l of sections.skills) {
    for (const s of parseSkillLine(l.text)) {
      const key = s.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const catName = categoryOf(s.name, s.label);
      let cat = categories.find((x) => x.name.toLowerCase() === catName.toLowerCase());
      if (!cat) {
        cat = { id: uniqueId(catName, categories.map((x) => x.id)), name: catName };
        categories.push(cat);
      }
      skillList.push({ id: uniqueId(s.name, skillList.map((x) => x.id)), name: s.name, category: cat.id });
    }
  }

  // Experience: from an experience section, else from "worked at … from … to …" sentences.
  const experience = sections.experience.length ? sectionExperience(sections.experience) : sentenceExperience(lines);
  const expItems = experience.map((e) => ({ ...e, id: '', description: e.description.join('\n') }));
  expItems.forEach((e, i) => (e.id = uniqueId(e.company || 'experience', expItems.slice(0, i).map((x) => x.id))));

  const projects = sectionProjects(sections.projects).map((p, i) => ({ ...p, id: '', accent: ACCENTS[i % ACCENTS.length], featured: i < 3 }));
  projects.forEach((p, i) => (p.id = uniqueId(p.title, projects.slice(0, i).map((x) => x.id))));
  const education = sectionEducation(sections.education);
  const certifications = sections.certifications.map((l) => {
    const [certName, issuer = ''] = l.text.split(/\s+(?:-|–|—|by|from)\s+|\s*\|\s*/i);
    const date = l.text.match(new RegExp(DATE, 'i'))?.[0];
    return { name: certName.replace(new RegExp(`\\(?${DATE}\\)?`, 'i'), '').trim(), issuer: issuer.replace(new RegExp(`\\(?${DATE}\\)?`, 'i'), '').trim(), issueDate: date ? toDate(date) : '' };
  });
  const achievements = sections.achievements.map((l) => ({ title: l.text.slice(0, 140), description: l.text.length > 140 ? l.text : '' }));

  // Title and years: "Dot Net Developer with around 5.10 years of … experience".
  const years =
    summary.match(/(\d{1,2}(?:\.\d{1,2})?)\s*\+?\s*(?:years|yrs)/i)?.[1] ??
    (() => {
      const starts = expItems.map((e) => e.startDate).filter(Boolean).sort();
      return starts.length ? String(Math.max(0, new Date().getFullYear() - Number(starts[0].slice(0, 4)))) : '';
    })();
  const titleFromSummary = summary.match(/^(?:i am |i'm )?(?:an?\s+)?((?:[A-Za-z.#+/-]+\s+){0,4}?[A-Za-z.#+/-]*(?:developer|engineer|analyst|designer|architect|consultant|manager|tester|scientist|programmer|administrator))\b/i)?.[1];
  const skillNames = skillList.map((s) => s.name);

  // Roles: every keyword template with enough matching skills, best first (up to four).
  const allText = (p: { title: string; description: string; technologies: string[] }) => [p.title, p.description, ...p.technologies].join(' ');
  const roles = roleTemplates()
    .map((t) => {
      const rank = (name: string) => t.keywords.findIndex((k) => matches(name, k));
      const skills = skillList.filter((s) => rank(s.name) >= 0).sort((a, b) => rank(a.name) - rank(b.name));
      const keywords = t.keywords.filter((k) => skillList.some((s) => matches(s.name, k))).length;
      const ownTitle = t.keywords.some((k) => matches(titleFromSummary ?? '', k)) || matches(titleFromSummary ?? '', t.name) ? 5 : 0;
      return { t, skills, score: keywords + ownTitle };
    })
    .filter(({ t, skills }) => skills.length >= (t.minMatches ?? 2))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ t, skills }, i) => {
      const top = skills.slice(0, 3).map((s) => s.name);
      return {
        id: t.id,
        displayOrder: i + 1,
        name: t.name,
        title: t.name,
        headline: `is a [${t.name}] working with [${top.slice(0, 2).join(' & ')}]`,
        shortBio: `${t.name}${years ? ` with ${years} years of experience` : ''}, working with ${top.join(', ')}.`,
        about: [],
        techStack: skills.slice(0, 5).map((s) => s.name),
        resumeUrl: '',
        skills: skills.map((s) => s.id),
        projects: projects.filter((p) => t.keywords.some((k) => matches(allText(p), k))).map((p) => p.id),
        experience: expItems.filter((e) => t.keywords.some((k) => matches([e.position, e.description, ...e.technologies].join(' '), k))).map((e) => e.id),
      };
    });

  const title = titleFromSummary?.trim() || roles[0]?.name || expItems[0]?.position || 'Professional';
  const shortName = name.split(' ')[0] ?? '';
  const topSkills = skillNames.slice(0, 5);

  let content: Content = {};
  const set = (path: string, value: unknown) => (content = setPath(content, path, value));
  set('seo', { title: name ? `${name} · ${title}` : title, description: (summary || `${name} — ${title}.`).slice(0, 160) });
  set('profile', {
    name,
    shortName,
    title,
    location,
    email: c.email,
    phone: c.phone,
    yearsOfExperience: years,
    currentProject: projects.find((p) => p.isCurrent)?.title ?? '',
    shortBio: clip(sentences(summary)[0] ?? '', 200),
    about: summary ? paragraphs(summary) : [`${name} is a ${title}.`],
    techStack: topSkills,
    footerTagline: topSkills.slice(0, 3).join(' · '),
  });
  set('home', {
    headline: `is a [${title}]${topSkills.length ? ` working with [${topSkills.slice(0, 2).join(' & ')}]` : ''}`,
    quote: { text: '', author: '' },
    contactIntro: "I'm open to new opportunities. If you have a request or question, don't hesitate to contact me.",
  });
  set('pageSubtitles', { works: 'List of my projects', about: 'Who am i?', contacts: 'Get in touch' });
  set('socialLinks', { linkedin: c.linkedin, github: c.github, twitter: c.twitter, website: c.website });
  set('skillCategories', categories);
  set('skills', skillList);
  set('experience', expItems);
  set('education', education);
  set('projects', projects);
  set('certifications', certifications);
  set('achievements', achievements);
  set('roles', roles);
  return cleanUp(schema, content);
}

/* ---------- Clean-up ---------- */

/** Unique, valid ids in every collection, with references (select / multiselect) rewritten to match. */
function fixIds(schema: Schema, content: Content): Content {
  const renamed: Record<string, Map<string, string>> = {};
  for (const [key, sec] of Object.entries(schema.sections)) {
    if (sec.type !== 'collection') continue;
    const map = new Map<string, string>();
    const taken: string[] = [];
    content[key] = (content[key] as BaseItem[]).map((item, i) => {
      const wanted = ID_PATTERN.test(item.id) ? item.id : slugify(String(getPath(item, sec.labelField) || item.id || sec.singular));
      const id = uniqueId(wanted, taken);
      taken.push(id);
      if (item.id && !map.has(item.id)) map.set(item.id, id);
      return { ...item, id, displayOrder: i + 1 };
    });
    renamed[key] = map;
  }
  for (const [key, sec] of Object.entries(schema.sections)) {
    if (sec.type !== 'collection') continue;
    for (const f of sec.fields.filter((x) => x.optionsFrom)) {
      const map = renamed[f.optionsFrom!.section] ?? new Map();
      const ids = new Set(((content[f.optionsFrom!.section] as BaseItem[]) ?? []).map((i) => i.id));
      const fix = (v: string) => map.get(v) ?? v;
      content[key] = (content[key] as BaseItem[]).map((item) => {
        const v = getPath(item, f.name);
        if (f.type === 'multiselect') return setPath(item, f.name, ((v as string[]) ?? []).map(fix).filter((x) => ids.has(x)));
        const next = fix(String(v ?? ''));
        return setPath(item, f.name, ids.has(next) ? next : (ids.values().next().value ?? ''));
      });
    }
  }
  return content;
}

/** Clears optional values that don't validate (e.g. a malformed URL), so the draft opens cleanly. */
function dropInvalid(schema: Schema, content: Content): Content {
  let out = content;
  /** Optional fields are emptied; required ones are repaired where there's an obvious fix, else left for the person. */
  const repair = (f: Field, v: unknown): unknown => {
    if (!f.required) return Array.isArray(v) ? [] : '';
    if (f.type === 'color') return typeof f.default === 'string' ? f.default : '#C778DD';
    if (f.type === 'text' && typeof v === 'string') return v.replace(/[[\]]/g, '');
    return v;
  };
  for (const issue of validateContent(schema, out)) {
    const [key, ...rest] = issue.path.split('.');
    const sec = schema.sections[key];
    if (!sec) continue;
    if (sec.type === 'object') {
      const f = sec.fields.find((x) => x.name === rest.join('.'));
      if (f) out = setPath(out, issue.path, repair(f, getPath(out, issue.path)));
      continue;
    }
    const [itemId, ...fieldPath] = rest;
    const f = sec.fields.find((x) => fieldPath.join('.').startsWith(x.name));
    if (!f) continue;
    out = {
      ...out,
      [key]: (out[key] as BaseItem[]).map((item) => (item.id === itemId ? setPath(item, f.name, repair(f, getPath(item, f.name))) : item)),
    };
  }
  return out;
}

/** Parsed content as saveable-looking content: normalized, ids repaired, invalid optional values cleared. */
export const cleanUp = (schema: Schema, raw: unknown): Content => dropInvalid(schema, fixIds(schema, normalizeContent(schema, raw)));
