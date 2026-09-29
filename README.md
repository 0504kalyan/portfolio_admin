# Portfolio Admin

One admin app for several portfolios. It currently manages:

| Portfolio | Live site | Repository |
|---|---|---|
| Pavan Kalyan Kama | <https://portfolio-of-pavan.vercel.app/> | `0504kalyan/PortFolio` |
| Koteswara Rao Doppalapudi | <https://koti-potifoli.vercel.app/> | `0504kalyan/koti_potifoli` |

The admin is its own app, repository and Vercel project. The portfolios contain no admin code and no secrets, and there is no database.

## How it works

```text
                ┌──────────────── Portfolio Admin (this app) ────────────────┐
 Browser ──────►│  React UI  ──►  /api/admin  (auth · CSRF · validation)       │
                └───────────────────────┬───────────────────┬─────────────────┘
                     GitHub API, commit │                   │ GitHub API, commit
                                        ▼                   ▼
                    0504kalyan/PortFolio              0504kalyan/koti_potifoli
                    content/portfolio.json            content/portfolio.json
                    content/schema.json               content/schema.json
                                        │ Vercel rebuild    │ Vercel rebuild
                                        ▼                   ▼
                    portfolio-of-pavan.vercel.app     Koti's portfolio
                    (/preview.html, /version.json)    (/preview.html, /version.json)
```

- **Each portfolio describes its own content.** Its repository has `content/portfolio.json` (the content) and `content/schema.json` (which sections, fields, lists and rules exist). The admin reads both and builds the menu, forms and validation from the schema, so the two portfolios can have completely different content models. Nothing about either one is hard-coded here.
- **Save = publish.** Saving validates the content on the server against that portfolio's schema, then commits it to that portfolio's repository with a message like `Add module: Banking`. The portfolio's Vercel project redeploys by itself (1–2 minutes). The admin polls the portfolio's `/version.json` and shows **Updating portfolio…**, then **Portfolio is up to date**.
- **Preview** loads the portfolio's own `/preview.html` in an iframe and sends it the unsaved content, so you see the real design before saving.
- **Version history** is the Git history of the content file. Restoring commits an old version again as a new commit.
- **Users** can be limited to some portfolios, e.g. Koti signs in and only sees his own.

## Portfolios from resumes (self-service)

Anyone can turn their resume into a portfolio of their own, without an account and without a new app or Vercel project:

1. **`<admin>/start`**: upload a resume (PDF, DOC or DOCX, up to 3 MB). The server extracts its text (`unpdf` for PDFs, `word-extractor` for Word) and fills in the host portfolio's content with plain rules, no AI (`api/_lib/resume.ts`): contact details by pattern, sections by common headings (Summary, Skills, Experience, Education, Projects, Certifications, Achievements), dates and date ranges, labelled project fields (Duration, Technology, Description, Responsibilities), "worked at X from … to …" sentences, and skills grouped by a small dictionary. The name falls back to the file name. It also suggests **roles**, job-based versions such as *Frontend Developer* or *.NET Developer*: each keyword template in `api/_lib/roleTemplates.ts` (or `ROLE_TEMPLATES`) that matches enough of the person's skills becomes a role with its own title, headline, bio and the matching skills, projects and experience. Scanned (image-only) resumes have no text and are refused.
2. **`<admin>/start/review`**: the draft opens in the normal editor screens (with Preview). Nothing is saved yet; the draft stays in the browser. Resumes are laid out in many ways, so the person checks every section; anything invalid (e.g. a missing name or start date) is listed and must be fixed before publishing.
3. **Publish**: choose an address. One commit to the host repo adds `content/profiles/<name>.json`, `content/profiles/<name>.owner.json` (the SHA-256 of the edit token, nothing else) and, if chosen, the resume as the CV under `public/uploads/profiles/<name>/`. The host redeploys and serves it at **`<host>/p/<name>`**, with each role at **`<host>/p/<name>/<role>`**.
4. **`<admin>/edit/<name>#<token>`**: the secret edit link shown once after publishing. It gives the owner the same editor, version history and uploads for their profile only, plus **Delete portfolio**. The token is in the `#fragment`, so it isn't sent in URLs or logged; lose it and the profile can only be changed by an admin.

Admins see every profile on the host's **Dashboard → Portfolios created from resumes**, with Delete for moderation.

**Setup:** add `"profiles": true` to one site in `SITES` (it must have the roles section and `/profiles/*.json` support; `my portfolio` does), and in production set `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` (a free Cloudflare Turnstile widget for the admin's domain). Limits: reading a resume 20 per IP per hour; creating 5 per IP per hour and 200 per day (in function memory, like the sign-in throttle).

**Limits to know:** every publish or save commits to the host repo and triggers a Vercel build, so heavy use counts against the host project's build minutes and deploy limits. Everything a person publishes, including the CV file, is public, as is the host repository if it's public.

## Local development

Run the admin next to one or both portfolios:

```bash
# the portfolios (each in its own terminal)
cd "../my portfolio"   && npm install && npm run dev                  # http://localhost:5173
cd "../koti portfolio" && npm install && npm run dev -- --port 5175   # http://localhost:5175

# the admin
npm install
cp .env.example .env.local
npm run hash-password        # once per user; paste each hash into ADMIN_USERS, and the secret into SESSION_SECRET
npm run dev                  # http://localhost:5174
```

In `.env.local`, keep `CONTENT_STORE=local`. Each site's `localUrl` (`http://localhost:5173`, `http://localhost:5175`) is used instead of `url` while running locally; on Vercel `localUrl` is ignored and the live `url` is used, so the same `SITES` value works in both places. Saving then writes that portfolio's `content/portfolio.json` directly (via `localPath`), and its dev server reloads with the change. Version snapshots go to the portfolio's git-ignored `.cms/` folder. The portfolios' dev servers accept previews from `http://localhost:5174` automatically.

## Deploying (one-time)

1. **Create a GitHub repository** for this folder (for example `0504kalyan/portfolio-admin`) and push it.
2. **GitHub token:** GitHub → Settings → Developer settings → Fine-grained tokens → *Generate new token*.
   - Repository access: **only** `0504kalyan/PortFolio` and `0504kalyan/koti_potifoli`.
   - Permissions: **Contents: Read and write**. Nothing else.
   - Set an expiry and a reminder to rotate it.
3. **Passwords:** run `npm run hash-password` once for each person who will sign in.
4. **Vercel:** *Add New… → Project* → import the admin repository. Framework preset **Other**; the build is configured by `vercel.json`. Name it, e.g. `portfolio-admin`; its URL is the admin URL.
5. **Environment variables** (admin project → Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `SITES` | JSON list of portfolios (see below) with the **production** URLs |
   | `GITHUB_TOKEN` | the token from step 2 |
   | `ADMIN_USERS` | JSON list of users (see below) |
   | `SESSION_SECRET` | 32+ random characters (printed by `hash-password`) |

   Then redeploy.
6. **On each portfolio's Vercel project**, add `VITE_ADMIN_ORIGIN = https://<your-admin>.vercel.app` (no trailing slash) and redeploy it. This isn't secret; it only allows the admin's Preview to send content to that portfolio's `preview.html`.
7. **Check:** `https://<your-admin>.vercel.app/api/admin/session` returns JSON. Sign in at `https://<your-admin>.vercel.app`.

### `SITES`

```json
[
  { "id": "pavan", "name": "Pavan Kalyan Kama", "url": "https://portfolio-of-pavan.vercel.app", "repo": "0504kalyan/PortFolio" },
  { "id": "koti", "name": "Koteswara Rao Doppalapudi", "url": "https://koti-potifoli.vercel.app", "repo": "0504kalyan/koti_potifoli" }
]
```

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Short key used in admin URLs (`/pavan/p/projects`) and in `ADMIN_USERS`. |
| `name` | yes | Shown in the admin. |
| `url` | yes | The live portfolio (for Preview, image thumbnails and the live check). |
| `localUrl` | no | The portfolio's local dev server (e.g. `http://localhost:5173`). Used instead of `url` under `npm run dev`; ignored on Vercel. |
| `repo` | yes | GitHub `owner/name`. |
| `branch` | no | Branch the portfolio's Vercel project deploys. Default `main`. If it requires pull requests, saving fails with a clear message. |
| `contentPath`, `schemaPath` | no | Defaults `content/portfolio.json`, `content/schema.json`. |
| `uploadDir` | no | Default `public/uploads` (served by the portfolio as `/uploads/…`). |
| `tokenEnv` | no | Env var with this repo's token, if it shouldn't use `GITHUB_TOKEN`. |
| `deployHookEnv` | no | Env var with a Vercel Deploy Hook URL, only for a portfolio project that isn't connected to its GitHub repo. |
| `localPath` | dev only | The portfolio's folder for `CONTENT_STORE=local`. |

### `ADMIN_USERS`

```json
[
  { "username": "pavan", "passwordHash": "scrypt:…", "sites": ["*"] },
  { "username": "koti", "passwordHash": "scrypt:…", "sites": ["koti"] }
]
```

`"sites": ["*"]` gives access to every portfolio; otherwise list site ids. Access is enforced on the server for every request. To change a password, generate a new hash, update the variable and redeploy; that user's sessions end. For a single admin you can use `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH` instead (access to every site).

## Adding another portfolio

Any static portfolio can be managed if its repository provides these four things. Both current portfolios show how.

1. **`content/portfolio.json`**: all editable content. The site imports it at build time instead of hard-coding text.
2. **`content/schema.json`**: describes that content (format below). Validate it by opening the portfolio in the admin; a mistake is reported as *"…schema.json is invalid: …"*.
3. **`/preview.html`**: renders the site from content received by `postMessage`. It must only accept messages from `VITE_ADMIN_ORIGIN`, answer `{ type: 'portfolio-preview-ready' }` to its parent, and then render `{ type: 'portfolio-preview', content, path }`. `path` is one of the schema's `previewPages`.
4. **`/version.json`**: `{ "contentSha": "<git blob SHA of content/portfolio.json>" }`, emitted at build time, served with `Access-Control-Allow-Origin: *`. It drives the "up to date" status. (Both portfolios' `vite.config.ts` show a 20-line plugin.)

Then add the site to `SITES`, give the token access to its repo, and add it to the right users.

### `schema.json` format

```jsonc
{
  "schemaVersion": 1,
  "previewPages": [{ "path": "/", "label": "Home" }, { "path": "/works", "label": "Works" }],  // or anchors: "#skills"
  "sections": {
    "profile": {                          // an object section
      "type": "object", "label": "Profile",
      "fields": [{ "name": "email", "label": "Email", "type": "email", "required": true }]
    },
    "projects": {                         // a list of items
      "type": "collection", "label": "Projects", "singular": "project",
      "labelField": "title", "metaFields": ["tagline"], "preview": "/works",
      "fields": [
        { "name": "title", "label": "Project title", "type": "text", "required": true },
        { "name": "startDate", "label": "Start", "type": "date" },
        { "name": "endDate", "label": "End", "type": "date" },
        { "name": "isCurrent", "label": "Ongoing", "type": "toggle" }
      ],
      "rules": [{ "type": "dateRange", "start": "startDate", "end": "endDate", "current": "isCurrent" }]
    }
  },
  "pages": [                              // the admin menu
    { "id": "projects", "label": "Projects", "sections": [{ "section": "projects" }] }
  ]
}
```

- **Field types:** `text`, `textarea`, `email`, `tel`, `url` (http/https only), `asset` (upload or site path; `accept`: `image` / `document`), `date` (`YYYY` or `YYYY-MM`), `color` (`#RRGGBB`), `toggle`, `number` (`min`, `max`), `select` (`options`, or `optionsFrom: { section, labelField }` to pick an item of another collection), `multiselect` (checkboxes over the same options; saved as a list of ids, e.g. a role's projects), `list` (one entry per line; `mustAppearIn` a sibling text field), `objectList` (repeatable group with its own `fields`, e.g. process steps).
- **Field options:** `required`, `hint`, `placeholder`, `wide`, `maxLength`, `pattern` + `patternMessage`, `default` (for new items). Dotted names (`project.client`) edit nested objects.
- **Collections** get `id`, `displayOrder`, `isVisible` and `status` (`active` / `archived` / `deleted`) automatically; the site should show only `active` + visible items, sorted by `displayOrder`. `groupBy` orders items within groups (e.g. skills by a `category` select). `idHint` explains the ID where it matters (URLs, icons).
- **Pages** can show part of an object section (`"fields": ["about"]`), set a `title`, `description` and `preview` page.
- **Fields not in the schema are dropped on save**, so add a field to the schema before the site starts using it.

## Build

`npm run build` type-checks, builds the UI with Vite, then `scripts/build-vercel.mjs` writes Vercel's [Build Output API](https://vercel.com/docs/build-output-api) folder `.vercel/output`: the static UI, the `api/admin` function (bundled into one file with esbuild) and the routes. `lib/schema.ts` (the schema engine) is shared by the UI and the function.

## API

| Method & path | Purpose |
|---|---|
| `GET /api/admin/session` | Signed-in user and the portfolios they may edit |
| `POST /api/admin/login`, `/logout` | Sign in / out |
| `GET /api/admin/sites/:site/portfolio` | That portfolio's schema, content and version |
| `POST /api/admin/sites/:site/publish` | Save: validate against its schema, commit to its repo |
| `GET /api/admin/sites/:site/versions`, `/versions/:sha` | Its version list / one version's content |
| `POST /api/admin/sites/:site/restore` | Commit an old version again as a new version |
| `POST /api/admin/sites/:site/upload` | Upload JPG/PNG/WebP/GIF/PDF/DOC/DOCX (≤3 MB) to its `public/uploads/` |
| `GET /api/admin/sites/:site/profiles`, `POST …/delete-profile` | Profiles hosted by that site (moderation) |
| `GET /api/admin/public/config`, `/public/slug/:name` | No sign-in: whether profiles are enabled; whether an address is free |
| `POST /api/admin/public/parse` | No sign-in: read a resume into draft content with rules (nothing saved) |
| `POST /api/admin/public/profiles` | No sign-in: publish a new profile; returns its edit token once |
| `/api/admin/public/profiles/:name/…` | With the `x-profile-token` header: `portfolio`, `publish`, `versions`, `restore`, `upload`, `delete` for that profile only |

Every `/sites/:site/…` call checks the session **and** that the user may edit that site.

## Security

- GitHub tokens, password hashes and the session secret exist only in this project's server function. The portfolio projects hold no secrets.
- Passwords are checked against scrypt hashes with constant-time comparison; unknown usernames take the same time as wrong passwords. Sessions are HMAC-signed `__Host-` cookies (`HttpOnly; Secure; SameSite=Strict`, 8 hours) and end when that user's password changes.
- Per-portfolio access is enforced on the server for every request (403 otherwise).
- Profile edit tokens are 256-bit random values; only their SHA-256 is stored, compared in constant time. Profile routes can only touch that profile's content file and upload folder. Public endpoints use the same CSRF checks, body limits, content validation and upload signature checks as the admin, plus rate limits and optional Turnstile.
- Writes need a custom header and a same-origin `Origin` (CSRF). Bodies over 1 MB are rejected.
- Content is rebuilt from the schema's fields only and validated before any commit. URLs must be `http(s)`, so no `javascript:` links. Uploads are type-checked by file signature, and SVG/HTML are refused.
- Saves carry the version they started from; GitHub rejects the commit if the file changed since, so newer content is never overwritten silently.
- Failed sign-ins are limited to 5 per IP (30 overall) per 15 minutes, in function memory (resets when Vercel starts a new instance). For a hard limit, add a Vercel Firewall rule on `/api/admin/login`.
- The admin is `noindex` and can't be framed. Error messages in the UI never include GitHub responses, tokens or stack traces (those go to the function logs).
