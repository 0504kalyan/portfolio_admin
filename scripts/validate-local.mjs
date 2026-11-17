import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const envPath = path.join(root, '.env.local');
const failures = [];
const localSites = [];

function trimQuotes(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return /^(['"]).*\1$/s.test(t) ? t.slice(1, -1).trim() : t;
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) {
    failures.push('Missing .env.local in the admin project root. Copy .env.example to .env.local first.');
    return {};
  }
  const raw = fs.readFileSync(file, 'utf8');
  const out = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key] = match;
    let value = match[2];
    const quote = value[0];
    if ((quote === "'" || quote === '"') && !value.endsWith(quote)) {
      while (++i < lines.length) {
        value += `\n${lines[i]}`;
        if (lines[i].trimEnd().endsWith(quote)) break;
      }
    }
    out[key] = trimQuotes(value);
  }
  return out;
}

const env = readEnvFile(envPath);
const contentStore = env.CONTENT_STORE || 'github';
if (contentStore !== 'local' && contentStore !== 'github') {
  failures.push('CONTENT_STORE must be either "local" or "github".');
}

if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
  failures.push('SESSION_SECRET is missing or shorter than 32 characters. Generate it with `npm run hash-password`.');
}

const hasAdminUsers = !!env.ADMIN_USERS && env.ADMIN_USERS.trim().length > 0;
const hasSingleAdmin = !!env.ADMIN_USERNAME && !!env.ADMIN_PASSWORD_HASH;
if (!hasAdminUsers && !hasSingleAdmin) {
  failures.push('Configure one of these: ADMIN_USERS or ADMIN_USERNAME + ADMIN_PASSWORD_HASH.');
}

if (!env.SITES || !env.SITES.trim()) {
  failures.push('SITES is missing. Add the portfolios with their production url and repository.');
} else {
  try {
    const sites = JSON.parse(env.SITES);
    if (!Array.isArray(sites) || sites.length === 0) {
      failures.push('SITES must be a non-empty JSON array.');
    } else {
      for (const site of sites) {
        const id = site.id || 'unknown';
        if (!site.id) failures.push('Each SITES item needs an id.');
        if (!site.url || !/^https?:\/\//.test(site.url)) {
          failures.push(`Site ${id} needs a valid production url.`);
        }
        if (contentStore === 'local') {
          if (!site.localUrl || !/^https?:\/\//.test(site.localUrl)) {
            failures.push(`Site ${id} needs a valid localUrl when CONTENT_STORE=local.`);
          } else {
            localSites.push({ id, url: site.localUrl.replace(/\/+$/, '') });
          }
          if (!site.localPath) {
            failures.push(`Site ${id} is missing localPath. Set it to the local portfolio folder.`);
          } else {
            const localPath = path.resolve(root, site.localPath);
            if (!fs.existsSync(localPath)) {
              failures.push(`localPath for ${id} does not exist: ${localPath}`);
            }
          }
        } else {
          if (!site.repo || !/^[\w.-]+\/[\w.-]+$/.test(site.repo)) {
            failures.push(`Site ${id} needs a valid GitHub repo (owner/name) when CONTENT_STORE=github.`);
          }
          const tokenName = site.tokenEnv || 'GITHUB_TOKEN';
          if (!env[tokenName]) {
            failures.push(`${tokenName} is required for site ${id} when CONTENT_STORE=github.`);
          }
          if (site.localUrl && !/^https?:\/\//.test(site.localUrl)) {
            failures.push(`Site ${id} has an invalid localUrl.`);
          }
        }
      }
    }
  } catch (error) {
    failures.push(`SITES is not valid JSON: ${error.message}`);
  }
}

for (const site of localSites) {
  try {
    const response = await fetch(site.url, { signal: AbortSignal.timeout(3000) });
    if (response.status >= 500) {
      failures.push(`Portfolio ${site.id} at ${site.url} returned HTTP ${response.status}. Check its dev server.`);
    }
  } catch {
    failures.push(`Portfolio ${site.id} is not responding at ${site.url}. Start its dev server before the admin.`);
  }
}

if (hasSingleAdmin) {
  const hash = env.ADMIN_PASSWORD_HASH;
  const parts = hash.split(':');
  if (parts[0] !== 'scrypt' || parts.length !== 6) {
    failures.push('ADMIN_PASSWORD_HASH is not a valid scrypt hash. Generate it with `npm run hash-password`.');
  }
}

if (failures.length) {
  console.error('Local admin configuration check failed:\n');
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}

console.log('Local config OK.');
console.log('Auth: ' + (hasAdminUsers ? 'ADMIN_USERS configured' : 'ADMIN_USERNAME + ADMIN_PASSWORD_HASH configured'));
console.log('Portfolio sites: ' + (JSON.parse(env.SITES) || []).map((s) => s.id).join(', '));
console.log(contentStore === 'local'
  ? 'Content store: local only; saves do not deploy to the public sites.'
  : 'Content store: GitHub; saves commit to the configured portfolio branches.');
for (const site of localSites) console.log(`Portfolio ${site.id} responds at ${site.url}.`);
