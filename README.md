# my corner — a tiny indie blog

A minimal, hand-drawn-flavored personal blog built with [Astro](https://astro.build).
Just words on paper — plus a tiny script for the light/dark switch (hand-drawn
light theme, professional dark theme) with a circular-reveal animation, and
smooth client-side page transitions.

## themes

The 🌙 button in the header switches between light and dark. **Light is the
default**; choosing dark once remembers it in `localStorage`. The switch
animates with a circular reveal via the
[View Transitions API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transitions_API),
falling back to an instant (and reduced-motion-friendly) swap.

All colors live as CSS custom properties at the top of
`src/styles/global.css` — the light palette on `:root`, the dark palette on
`:root[data-theme='dark']`.## page transitions

Navigating between pages uses Astro's [`<ClientRouter />`](https://docs.astro.build/en/guides/view-transitions/)
view transitions. The header and footer persist across navigations (no
flicker) while the content crossfades with a gentle upward drift, and internal
links are prefetched as soon as they enter the viewport — so navigation feels
instant. The current theme is handed to each incoming page via
`astro:before-swap`, so it never flickers either.

## quickstart

```bash
npm install
npm run dev       # → http://localhost:4321
npm run build     # static site into dist/
npm run preview   # preview the production build
```

## structure

```
.
├── astro.config.mjs          # site URL + sitemap integration
├── public/
│   └── favicon.svg           # hand-drawn asterisk
└── src/
    ├── consts.ts             # ✏️ site title, author, description — edit me first
    ├── content.config.ts     # blog + now collection schemas (frontmatter validation)
    ├── content/blog/         # ✏️ write posts here as .md files
    ├── content/now/now.md    # ✏️ the /now page, editable from the admin
    ├── styles/global.css     # all the indie/hand-drawn styling lives here
    ├── layouts/BaseLayout.astro
    ├── components/           # Header, Footer, PostCard, Squiggle divider
    ├── scripts/admin/        # the /admin SPA (app.js, github.js, content.js, editor-tools.js)
    ├── lib/posts.ts          # isPublished filter (drafts + scheduled posts)
    └── pages/
        ├── index.astro       # homepage (hero + latest writings)
        ├── about.astro       # bio + colophon
        ├── now.astro         # classic indie-web "now" page
        ├── admin.astro       # hidden back office (token-gated, noindex)
        ├── posts/[...slug].astro  # single-post pages (auto-generated)
        ├── rss.xml.js        # RSS feed at /rss.xml
        └── 404.astro
```

## make it yours

1. **`src/consts.ts`** — your name, site title, description, and real domain.
2. **`astro.config.mjs`** — set `site` to your real domain (used by sitemap + RSS).
3. **Write posts** — drop Markdown files in `src/content/blog/`. Required
   frontmatter: `title`, `description`, `pubDate`. Optional: `tags`,
   `updatedDate`, `draft` (hides the post).
4. **Tune the look** — all colors, fonts, and quirks are CSS custom properties
   at the top of `src/styles/global.css`.The handwritten font (Caveat) is self-hosted via
`@fontsource/caveat` — zero third-party requests.

## admin (professional back office)

There's a full admin app at **`/admin`** (not linked from the nav, `noindex`'d)
that manages the whole blog straight from the browser through the GitHub API —
no server, no database. Light/dark themes, keyboard-driven, with a sidebar
layout like any modern SaaS dashboard:

- **dashboard** — stats (total / published / scheduled / drafts / words),
  quick actions, recent writings, live deploy status of the Actions workflow
- **posts** — create, edit, delete, duplicate, search, filter by
  published / scheduled / drafts, and one-click publish⇄draft toggling
- **editor** — a full **WYSIWYG studio** (Toast UI): rich toolbar (bold,
  italic, headings, lists, quotes, links, code, tables, HR…), markdown source
  view, live word count + reading time, drafts, slugs, tags, copy & download
- **images** — media library with upload / delete / copy-markdown; add images
  to any post via the 🖼 button, drag-and-drop, or paste — uploaded to
  `public/images/` and committed atomically with your save
- **pages & files** — browse and edit every text file in the repo
  (`about.astro`, `global.css`, configs…) right from the browser
- **tags** — see every tag with counts, filter by tag, rename or remove a tag
  across all posts in one commit
- **import / export** — download all posts as a .zip (fflate), or bulk-import
  .md files with a review step before committing
- **deploy** — live workflow-run history and a one-click "rebuild & deploy"
  button
- **settings** — the `SITE` fields in `src/consts.ts` (title, author,
  description)
- **now** — the `/now` page content, stored in `src/content/now/now.md`

**Scheduled publishing:** give a post a future date and it's marked
`scheduled` — hidden at build time (via `src/lib/posts.ts`) until its
publish date, then published automatically by the deploy workflow's daily
rebuild (`.github/workflows/deploy.yml` runs twice a day in UTC).

Every save is **one atomic commit** to the repo (the git data API) —
including any attached images — which triggers the deploy workflow; publish
from the browser, site updates in about a minute.

**One-time setup:** open `/admin`, paste a GitHub **personal access token**
with contents read & write on this repo (a
[fine-grained token](https://github.com/settings/personal-access-tokens/new)
scoped to this repo — a classic token with broad scopes gets flagged by the
admin). The token lives only in your browser's `localStorage` and talks to
`api.github.com` directly; use the **lock** button to forget it.

The admin's code lives in `src/pages/admin.astro` (shell) +
`src/styles/admin.css` (design system), and `src/scripts/admin/`
(`app.js` SPA, `github.js` API client, `content.js` frontmatter/consts
helpers, `editor-tools.js` image pipeline).

## deploying

**GitHub Pages (recommended — free):** this project is already configured as
a project page — `site` + `base` are set in `astro.config.mjs` and every
internal link uses the base-aware `BASE` helper from `src/consts.ts`.

1. Push the repository to GitHub (the repo must be **public** on the free plan):

   ```bash
   git remote add origin git@github.com:ayush-rdev/ayushwrites.git   # or https://github.com/ayush-rdev/ayushwrites.git
   git push -u origin main
   ```

2. In the repository's **Settings → Pages**, set Source to **GitHub Actions**.

The site builds and publishes on every push at
`https://ayush-rdev.github.io/ayushwrites/`. If you later rename the repo,
update `base` in `astro.config.mjs` to match (and change `SITE.url` in
`src/consts.ts`).

That's it — the included workflow (`.github/workflows/deploy.yml`) builds and
publishes on every push, so future `git push`es update the site automatically.

Any other static host works too (Netlify, Cloudflare Pages, Vercel, a $5 VPS,
a USB stick handed to a friend...). Build command: `npm run build`, output:
`dist/`.

### on your local network (phone access)

Serve the built site to every device on your Wi-Fi:

```bash
npm run build
npm run network   # serves dist/ on 0.0.0.0:4322
```

Then open `http://<your-machine-ip>:4322` from your phone. Find the IP with
`hostname -I` on Linux or `ipconfig` on Windows/macOS. Two gotchas:

- The phone must be on the **same network** as this machine.
- If this runs inside a VM/container, the IP your phone sees is the *host*
machine's address — forward port 4322 to the container if needed.

To stop the server, kill the process (`Ctrl+C` if foregrounded, or
`pkill -f 'astro preview'`).
