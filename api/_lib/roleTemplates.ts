// Job roles suggested for a resume, by keyword. A role is suggested when enough of the resume's
// skills match its keywords, and then shows the matching skills, projects and experience.
// Override the whole list with the ROLE_TEMPLATES env var (a JSON array of the same shape).

export interface RoleTemplate {
  /** URL id, e.g. /p/jane/frontend-developer. Not works, about-me or contacts. */
  id: string;
  name: string;
  /** Lowercase skill names or words; matched against skills, project technologies and text. */
  keywords: string[];
  /** Skills that must match before the role is suggested (default 2). */
  minMatches?: number;
}

export const DEFAULT_ROLE_TEMPLATES: RoleTemplate[] = [
  { id: 'frontend-developer', name: 'Frontend Developer', keywords: ['react', 'angular', 'vue', 'svelte', 'next.js', 'javascript', 'typescript', 'html', 'css', 'tailwind', 'redux', 'rxjs', 'micro-frontend', 'module federation', 'nx', 'sass', 'jquery'], minMatches: 3 },
  { id: 'dotnet-developer', name: '.NET Developer', keywords: ['c#', '.net', 'dot net', 'asp.net', 'web api', 'entity framework', 'linq', 'dapper', 'wcf', 'mvc', 'blazor'] },
  { id: 'java-developer', name: 'Java Developer', keywords: ['java', 'spring', 'spring boot', 'hibernate', 'jpa', 'maven', 'gradle', 'kotlin', 'j2ee'] },
  { id: 'python-developer', name: 'Python Developer', keywords: ['python', 'django', 'flask', 'fastapi', 'pandas', 'numpy', 'celery'] },
  { id: 'nodejs-developer', name: 'Node.js Developer', keywords: ['node', 'node.js', 'express', 'nestjs', 'npm', 'graphql', 'typescript'] },
  { id: 'full-stack-developer', name: 'Full Stack Developer', keywords: ['react', 'angular', 'vue', 'node', 'node.js', 'asp.net', 'django', 'spring', 'sql', 'mongodb', 'rest', 'rest apis', 'web api'], minMatches: 4 },
  { id: 'database-developer', name: 'Database Developer', keywords: ['sql', 'sql server', 'ms sql', 't-sql', 'pl/sql', 'postgresql', 'mysql', 'oracle', 'mongodb', 'query optimization', 'performance tuning'], minMatches: 3 },
  { id: 'devops-engineer', name: 'DevOps Engineer', keywords: ['docker', 'kubernetes', 'ci/cd', 'azure devops', 'jenkins', 'terraform', 'ansible', 'aws', 'azure', 'gcp', 'github actions', 'linux'], minMatches: 3 },
  { id: 'mobile-developer', name: 'Mobile Developer', keywords: ['android', 'ios', 'swift', 'kotlin', 'flutter', 'react native', 'dart', 'xamarin'] },
  { id: 'qa-engineer', name: 'QA Engineer', keywords: ['selenium', 'cypress', 'playwright', 'testing', 'jest', 'junit', 'nunit', 'test automation', 'manual testing', 'postman'], minMatches: 3 },
  { id: 'data-analyst', name: 'Data Analyst', keywords: ['excel', 'power bi', 'tableau', 'sql', 'python', 'pandas', 'statistics', 'data analysis'], minMatches: 3 },
];

export function roleTemplates(): RoleTemplate[] {
  const raw = process.env.ROLE_TEMPLATES?.trim();
  if (!raw) return DEFAULT_ROLE_TEMPLATES;
  try {
    const list = JSON.parse(raw) as RoleTemplate[];
    if (Array.isArray(list) && list.every((t) => t.id && t.name && Array.isArray(t.keywords))) {
      return list.map((t) => ({ ...t, keywords: t.keywords.map((k) => String(k).toLowerCase()) }));
    }
  } catch {
    /* fall through */
  }
  console.error('[api] ROLE_TEMPLATES is invalid (expected [{"id","name","keywords":[...]}]); using the defaults');
  return DEFAULT_ROLE_TEMPLATES;
}
