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
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, value] = match;
    out[key] = trimQuotes(value);
  }
  return out;
}

const env = readEnvFile(envPath);
if (!env.CONTENT_STORE || env.CONTENT_STORE !== 'local') {
  failures.push('Set CONTENT_STORE=local in .env.local for local development.');
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
  failures.push('SITES is missing. Add the portfolio list with each site\'s localUrl and localPath.');
} else {
  try {
    const sites = JSON.parse(env.SITES);
    if (!Array.isArray(sites) || sites.length === 0) {
      failures.push('SITES must be a non-empty JSON array.');
    } else {
      for (const site of sites) {
        if (!site.id) failures.push('Each SITES item needs an id.');
        if (!site.localUrl || !/^https?:\/\//.test(site.localUrl)) {
          failures.push(`Site ${site.id || 'unknown'} needs a valid localUrl for live local updates.`);
        } else {
          localSites.push({ id: site.id || 'unknown', url: site.localUrl.replace(/\/+$/, '') });
        }
        if (!site.localPath) {
          failures.push(`Site ${site.id || 'unknown'} is missing localPath. Set it to the local portfolio folder.`);
          continue;
        }
        const localPath = path.resolve(root, site.localPath);
        if (!fs.existsSync(localPath)) {
          failures.push(`localPath for ${site.id} does not exist: ${localPath}`);
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
for (const site of localSites) console.log(`Portfolio ${site.id} responds at ${site.url}.`);
