// ─────────────────────────────────────────────
//  my corner — admin app.
//  A hash-routed SPA that manages the whole blog
//  from the browser via the GitHub API: posts,
//  images, files, tags, site settings, the now
//  page, import/export and deploys. Every save
//  is a commit to the repo, and the deploy
//  workflow runs it.
// ─────────────────────────────────────────────

// ToastUI's CSS stays in the main bundle (small); the editor JS (~300 KB)
// and the zip exporter load lazily so the admin shell stays light and
// navigation stays instant.
import '@toast-ui/editor/dist/toastui-editor.css';
import '@toast-ui/editor/dist/theme/toastui-editor-dark.css';

let EditorCtor = null;
async function loadEditor() {
  if (!EditorCtor) {
    const mod = await import('@toast-ui/editor');
    EditorCtor = mod.default;
  }
  return EditorCtor;
}

let fflateMod = null;
async function loadFflate() {
  if (!fflateMod) fflateMod = await import('fflate');
  return fflateMod;
}

let markedMod = null;
async function loadMarked() {
  if (!markedMod) markedMod = await import('marked');
  return markedMod;
}

import { GitHub } from './github.js';
import { checkPassword, isSessionOpen, openSession, closeSession, lockoutRemainingMs } from './auth.js';
import { fileToBase64, baseName, imagePathFor, MAX_IMAGE_BYTES } from './editor-tools.js';
import {
  parseFrontmatter,
  buildPostMarkdown,
  buildNowMarkdown,
  slugify,
  countWords,
  readConsts,
  writeConsts,
} from './content.js';
import { SITE } from '../../consts';

// ── base path ('/ayushwrites/') ──────────────
const BASE = import.meta.env.BASE_URL.endsWith('/')
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;

// ── tiny dom helpers ─────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ── localStorage (wrapped so private mode can't crash us) ──
const KEYS = {
  token: 'mc_admin_token',
  owner: 'mc_admin_owner',
  repo: 'mc_admin_repo',
  autoLock: 'mc_admin_autolock',
  analyticsSite: 'mc_admin_analytics_site',
};
const store = {
  get(k) { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  // wipe credentials only — keep preferences like the auto-lock toggle
  clear() {
    try {
      ['token', 'owner', 'repo'].forEach((k) => localStorage.removeItem(KEYS[k]));
    } catch {}
  },
};

// ── state ────────────────────────────────────
const state = {
  gh: null,
  posts: [],
  settings: null, // { path, content }
  now: null, // { path, data, body }
  clone: null, // duplicated-post source for the "new" editor
  tree: null, // cached repo file listing
  stats: null, // cached analytics snapshot (public/stats.json)
  dirty: false,
  lastHash: '#/dashboard',
  scopeWarn: null,
};

// true while a commit is in flight — blocks double-submits
let actionBusy = false;
let lockTimer = null; // auto-lock countdown

const ui = {
  postsFilter: 'all',
  postsQuery: '',
  importItems: [],
};

// live ToastUI editor instances (for theme syncing)
const editors = new Set();
// editors currently attached to the rendered view — destroyed on re-render
let activeEditors = [];

function disposeOneEditor(e) {
  if (!e) return;
  try {
    e.destroy();
  } catch {}
  editors.delete(e);
  activeEditors = activeEditors.filter((x) => x !== e);
}

function disposeEditors() {
  for (const e of activeEditors) disposeOneEditor(e);
  activeEditors = [];
}

// scopes a token does NOT need for this admin
const BROAD_SCOPES = [
  'admin:enterprise', 'admin:gpg_key', 'admin:org', 'admin:org_hook',
  'admin:public_key', 'admin:repo_hook', 'admin:ssh_signing_key',
  'audit_log', 'codespace', 'copilot', 'delete_repo', 'delete:packages',
  'gist', 'notifications', 'project', 'workflow', 'write:discussion',
  'write:network_configurations', 'write:packages',
];

// ── toasts ───────────────────────────────────
function toast(msg, kind = 'info') {
  const box = $('#a-toasts');
  if (!box) return;
  const t = el('div', { class: `a-toast a-toast--${kind}` }, msg);
  box.append(t);
  setTimeout(() => {
    t.classList.add('a-toast--out');
    setTimeout(() => t.remove(), 300);
  }, 4200);
}

// ── small utils ──────────────────────────────
function pretty(d) {
  if (!d) return '—';
  const t = new Date(String(d));
  if (Number.isNaN(t.getTime())) return String(d);
  return t.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function relTime(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}

function isFutureDate(d) {
  if (!d) return false;
  // compare in UTC like the build does, so the admin badge matches the site
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.getTime() > Date.now();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ── connect / auth ───────────────────────────
function lockVisible(on) {
  $('#a-lock-wrap').hidden = !on;
  $('#a-shell').hidden = on;
}

async function connect(silent = false) {
  // password gate — the token step below is the real write-credential, but
  // the password keeps everyone who doesn't have it off the admin entirely
  const cooldown = lockoutRemainingMs();
  if (cooldown > 0) {
    if (!silent) toast(`too many attempts — try again in ${Math.ceil(cooldown / 1000)}s`, 'error');
    return;
  }
  let pwOk = false;
  try {
    const res = await checkPassword($('#a-username').value, $('#a-password').value);
    if (res.locked) {
      if (!silent) toast('too many attempts — try again in a minute', 'error');
      return;
    }
    pwOk = res.ok;
  } catch (e) {
    console.error('password check failed:', e);
    if (!silent) toast('password check unavailable — open the admin over https', 'error');
    return;
  }
  if (!pwOk) {
    if (!silent) toast('wrong username or password', 'error');
    $('#a-password').value = '';
    $('#a-password').focus();
    return;
  }
  openSession();

  const token = $('#a-token').value.trim();
  let owner = $('#a-owner').value.trim();
  const repo = $('#a-repo').value.trim();
  if (!token || !repo) {
    if (!silent) toast('token and repo are required', 'error');
    return;
  }
  const btn = $('#a-connect');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'connecting…';
  }
  try {
    const gh = new GitHub(token, owner, repo);
    const me = await gh.me();
    if (!owner) owner = me.login;
    gh.owner = owner;
    const info = await gh.repoInfo();
    gh.branch = info.default_branch;

    state.gh = gh;
    store.set(KEYS.token, token);
    store.set(KEYS.owner, owner);
    store.set(KEYS.repo, repo);

    const scopes = (gh.lastScopes || '').split(',').map((s) => s.trim()).filter(Boolean);
    state.scopeWarn = scopes.filter((s) => BROAD_SCOPES.includes(s));
    if (state.scopeWarn.length === 0) state.scopeWarn = null;
    if (state.scopeWarn) toast('⚠️ This token has very broad scopes — consider a fine-grained one', 'error');

    $('#a-repo-line').textContent = `${owner}/${repo} · ${gh.branch}`;
    if (!silent) toast(`connected as @${me.login} — ${owner}/${repo}`, 'success');
    lockVisible(false);
    armAutoLock();
    if (!location.hash) location.hash = '#/dashboard';
    await loadAll();
  } catch (e) {
    toast(e.message || 'connection failed', 'error');
    lockVisible(true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'sign in';
    }
  }
}

async function loadAll() {
  setBusy(true);
  try {
    const [dir, settings, nowFile] = await Promise.all([
      state.gh.listDir('src/content/blog'),
      state.gh.getTextFile('src/consts.ts'),
      state.gh.getTextFile('src/content/now/now.md').catch(() => null),
    ]);

    const entries = await Promise.all(
      dir.filter((f) => /\.mdx?$/.test(f.name)).map(async (f) => {
        try {
          const file = await state.gh.getTextFile(f.path);
          const { data, body } = parseFrontmatter(file.content);
          return { id: f.name.replace(/\.mdx?$/, ''), path: f.path, data, body };
        } catch {
          return null;
        }
      }),
    );
    const posts = entries
      .filter(Boolean)
      .sort((a, b) => String(b.data.pubDate || '').localeCompare(String(a.data.pubDate || '')));

    state.posts = posts;
    state.settings = { path: settings.path, content: settings.content };
    if (nowFile) {
      const { data, body } = parseFrontmatter(nowFile.content);
      state.now = { path: nowFile.path, data, body };
    } else {
      state.now = null;
    }
    state.tree = null; // refetch on next media/files view
    renderRoute();
  } catch (e) {
    toast(e.message || 'could not load the repo', 'error');
  } finally {
    setBusy(false);
  }
}

function setBusy(on) {
  const view = $('#a-view');
  if (!view) return;
  view.classList.toggle('a-view--busy', on);
  const bar = view.querySelector('.a-busy');
  if (on && !bar) view.prepend(el('p', { class: 'a-busy' }, 'working…'));
  else if (!on && bar) bar.remove();
}

// ── routing ──────────────────────────────────
function currentRoute() {
  let h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('file/')) return { view: 'file', arg: decodeURIComponent(h.slice(5)) };
  const [view, ...rest] = h.split('/');
  return { view: view || 'dashboard', arg: decodeURIComponent(rest.join('/')) };
}

let guardRevert = false;
function onHashChange() {
  if (guardRevert) {
    guardRevert = false;
    return;
  }
  const prevHash = state.lastHash || '#/dashboard';
  if (state.dirty) {
    const ok = window.confirm('You have unsaved changes. Discard them?');
    if (!ok) {
      if (prevHash !== location.hash) {
        guardRevert = true;
        location.hash = prevHash;
      }
      return;
    }
    state.dirty = false;
  }
  // only record the hash once navigation is accepted, so a cancelled
  // navigation can't poison the revert target
  state.lastHash = location.hash;
  renderRoute();
}

function renderRoute() {
  const viewEl = $('#a-view');
  if (!state.gh || !viewEl) return;
  const { view, arg } = currentRoute();
  disposeEditors(); // no editor should outlive its view
  ui.tab =
    view === 'edit' || view === 'new' ? 'posts' :
    view === 'file' ? 'files' : view;
  syncNav();

  try {
    if (view === 'posts') renderPosts(viewEl);
    else if (view === 'new' || view === 'edit') renderEditor(viewEl, view === 'edit' ? arg : null);
    else if (view === 'media') renderMedia(viewEl);
    else if (view === 'analytics') renderAnalytics(viewEl);
    else if (view === 'files') renderFiles(viewEl);
    else if (view === 'file') renderFile(viewEl, arg);
    else if (view === 'tags') renderTags(viewEl);
    else if (view === 'tools') renderTools(viewEl);
    else if (view === 'deploy') renderDeploy(viewEl);
    else if (view === 'settings') renderSettings(viewEl);
    else if (view === 'now') renderNow(viewEl);
    else renderDashboard(viewEl);
  } catch (err) {
    // one broken view must never dead-end the admin — show a recoverable card
    viewEl.replaceChildren(errorCard(err));
  }
}

function syncNav() {
  document.querySelectorAll('.a-nav').forEach((a) => {
    a.classList.toggle('a-nav--active', a.dataset.view === ui.tab);
  });
}

// ── ToastUI editor helper ────────────────────
/** graceful fallback: a plain textarea that mimics the editor's API */
function fallbackEditor(container, value, onChange) {
  container.replaceChildren();
  const ta = document.createElement('textarea');
  ta.className = 'a-fallback';
  ta.spellcheck = false;
  ta.value = value || '';
  container.append(ta);
  if (onChange) ta.addEventListener('input', onChange);
  return {
    getMarkdown: () => ta.value,
    setMarkdown: (v) => { ta.value = v; },
    on: () => {},
    addHook: () => {},
    getRootElement: () => ta,
    destroy: () => {},
  };
}

async function createEditor({ container, value, onChange, onImage }) {
  let editor;
  try {
    const Ctor = await loadEditor();
    container.replaceChildren(); // drop any "loading…" placeholder
    editor = new Ctor({
      el: container,
      height: 'auto',
      minHeight: '460px',
      initialEditType: 'markdown',
      previewStyle: 'vertical',
      initialValue: value || '',
      placeholder: 'write here… (markdown or rich text)',
      hideModeSwitch: false,
      usageStatistics: false,
    });
  } catch (err) {
    console.error('rich editor failed to start — using plain textarea', err);
    toast('rich editor unavailable — using a plain textarea', 'error');
    return fallbackEditor(container, value, onChange);
  }
  if (onChange) editor.on('change', onChange);
  if (onImage) {
    editor.addHook('addImageBlobHook', (blob, callback) => {
      Promise.resolve(onImage(blob))
        .then((res) => {
          if (res) callback(res.url, res.alt);
        })
        .catch((e) => toast(e.message || 'image upload failed', 'error'));
    });
  }
  syncEditorTheme(editor);
  editors.add(editor);
  activeEditors.push(editor);
  return editor;
}

function syncEditorTheme(editor) {
  try {
    editor.getRootElement().classList.toggle(
      'toastui-editor-dark',
      document.documentElement.dataset.theme === 'dark',
    );
  } catch {}
}

// ── dashboard ────────────────────────────────
function renderDashboard(viewEl) {
  const posts = state.posts;
  const published = posts.filter((p) => !p.data.draft && !isFutureDate(p.data.pubDate));
  const scheduled = posts.filter((p) => !p.data.draft && isFutureDate(p.data.pubDate));
  const drafts = posts.filter((p) => p.data.draft);
  const words = posts.reduce((n, p) => n + countWords(p.body), 0);
  const latest = posts[0]?.data.pubDate;

  const stat = (label, n, sub) =>
    el('div', { class: 'a-stat' },
      el('span', { class: 'a-stat__num' }, String(n)),
      el('span', { class: 'a-stat__label' }, label),
      sub ? el('span', { class: 'a-stat__sub' }, sub) : null,
    );

  const recent = posts.slice(0, 4).map((p) =>
    el('a', { class: 'a-row a-row--link', href: `#/edit/${encodeURIComponent(p.id)}` },
      el('div', { class: 'a-row__main' },
        el('span', { class: 'a-row__title' }, p.data.title || p.id),
        p.data.draft ? el('span', { class: 'a-badge a-badge--draft' }, 'draft') : null,
      ),
      el('div', { class: 'a-row__date' }, pretty(p.data.pubDate)),
    ),
  );

  viewEl.replaceChildren(
    pageHead('dashboard', 'overview', [
      el('button', { class: 'a-btn a-btn--primary', onclick: () => (location.hash = '#/new') }, '✍ new post'),
    ]),

    state.scopeWarn
      ? el('div', { class: 'a-warn' },
          el('strong', {}, '⚠️ This token has far more power than the admin needs'),
          el('p', { class: 'a-note' },
            `It carries scopes like ${state.scopeWarn.join(', ')}. If it has ever been pasted into a chat or config, revoke it now at github.com/settings/tokens. A fine-grained token with Contents: read & write on this repo is all the admin needs.`,
          ),
        )
      : null,

    el('div', { class: 'a-stats' },
      stat('writings', posts.length, 'in the repo'),
      stat('published', published.length, latest ? `latest ${pretty(latest)}` : ''),
      stat('scheduled', scheduled.length, 'auto-publish on date'),
      stat('drafts', drafts.length, 'hidden from listings'),
      stat('words', words.toLocaleString(), 'across all posts'),
      stat('reads', '—', 'pageviews, last 30 days'),
    ),

    el('div', { id: 'a-dash-analytics' },
      el('div', { class: 'a-card' },
        el('div', { class: 'a-card__head' },
          el('h2', {}, 'analytics'),
          el('a', { class: 'a-out', href: '#/analytics' }, 'full stats →'),
        ),
        el('div', { id: 'a-dash-stats' }, el('p', { class: 'a-note' }, 'loading…')),
      ),
    ),

    el('div', { class: 'a-grid-2' },
      el('div', { class: 'a-card' },
        el('div', { class: 'a-card__head' },
          el('h2', {}, 'quick actions'),
          el('a', { class: 'a-out', href: '#/deploy' }, 'deploy →'),
        ),
        el('div', { class: 'a-btn-row' },
          el('button', { class: 'a-btn', onclick: () => (location.hash = '#/media') }, '🖼 media library'),
          el('button', { class: 'a-btn', onclick: () => (location.hash = '#/files') }, '📄 pages & files'),
          el('button', { class: 'a-btn', onclick: () => (location.hash = '#/tools') }, '🧰 import / export'),
        ),
        el('p', { class: 'a-note' },
          `Every save is one commit to `, el('strong', {}, `${state.gh.owner}/${state.gh.repo}`),
          ` on `, el('strong', {}, state.gh.branch),
          ` — the deploy workflow builds and publishes in about a minute.`,
        ),
      ),

      el('div', { class: 'a-card' },
        el('div', { class: 'a-card__head' },
          el('h2', {}, 'latest deploy'),
          el('button', { class: 'a-mini', title: 'refresh', onclick: refreshDeployCard }, '↻'),
        ),
        el('div', { id: 'a-deploy-mini' }, el('p', { class: 'a-note' }, '…')),
      ),
    ),

    posts.length > 0
      ? el('div', { class: 'a-card' },
          el('div', { class: 'a-card__head' },
            el('h2', {}, 'recent writings'),
            el('a', { class: 'a-out', href: '#/posts' }, 'all posts →'),
          ),
          el('div', { class: 'a-list' }, ...recent),
        )
      : el('div', { class: 'a-card' },
          el('div', { class: 'a-card__head' }, el('h2', {}, 'no posts yet')),
          el('p', { class: 'a-note' }, 'Write your first one — the corner is waiting.'),
          el('button', { class: 'a-btn a-btn--primary', onclick: () => (location.hash = '#/new') }, '✍ new post'),
        ),
  );

  refreshDeployCard();
  refreshDashboardStats();
}

async function refreshDashboardStats() {
  const stats = await loadStats();
  const numEl = document.querySelector('.a-stats .a-stat:nth-child(6) .a-stat__num');
  if (numEl) numEl.textContent = stats ? statsMonthTotal().toLocaleString() : '—';
  const box = $('#a-dash-stats');
  if (!box) return;
  if (!stats) {
    box.replaceChildren(
      el('div', { class: 'a-dash-stats__empty' },
        el('span', {}, '📊 no stats yet — '),
        el('a', { class: 'a-out', href: '#/analytics' }, 'connect analytics →'),
      ),
    );
    return;
  }
  const top = stats.hits.slice(0, 1)[0];
  box.replaceChildren(
    el('div', { class: 'a-mini-stats' },
      el('div', { class: 'a-mini-stat' },
        el('span', { class: 'a-mini-stat__num' }, stats.total.toLocaleString()),
        el('span', { class: 'a-mini-stat__label' }, 'total views'),
      ),
      el('div', { class: 'a-mini-stat' },
        el('span', { class: 'a-mini-stat__num' }, statsWeekTotal().toLocaleString()),
        el('span', { class: 'a-mini-stat__label' }, 'last 7 days'),
      ),
    ),
    top
      ? el('div', { class: 'a-dash-top' },
          el('span', { class: 'a-note' }, `top: `, el('strong', {}, top.title || top.path.replace(/\/$/, '').split('/').pop())),
          el('span', { class: 'a-mono' }, `${top.count.toLocaleString()} views`),
        )
      : null,
  );
}

async function refreshDeployCard() {
  const box = $('#a-deploy-mini');
  if (!box || !state.gh) return;
  box.replaceChildren(el('p', { class: 'a-note' }, 'checking…'));
  try {
    const run = await state.gh.latestRun();
    if (!run) {
      box.replaceChildren(el('p', { class: 'a-note' }, 'no workflow runs yet — your first save will kick one off.'));
      return;
    }
    const done = run.status === 'completed';
    const ok = done && run.conclusion === 'success';
    const cls = done ? (ok ? 'a-badge--ok' : 'a-badge--bad') : 'a-badge--run';
    const label = done ? run.conclusion : run.status;
    box.replaceChildren(
      el('div', { class: 'a-run-status' },
        el('span', { class: `dot dot--${done ? (ok ? 'ok' : 'bad') : 'run'}` }),
        el('div', {},
          el('div', {},
            el('span', { class: `a-badge ${cls}` }, label),
            done ? '' : ' building & deploying…',
          ),
          el('div', { class: 'a-note' },
            `${relTime(run.created_at)} · `,
            el('a', { class: 'a-out', href: run.html_url, target: '_blank', rel: 'noopener' }, 'view run ↗'),
          ),
        ),
      ),
    );
  } catch {
    box.replaceChildren(el('p', { class: 'a-note' }, 'could not fetch deploy status (Actions may be off).'));
  }
}

// ── shared page header ───────────────────────
function errorCard(err) {
  console.error('admin view failed:', err);
  return el('div', { class: 'a-card' },
    el('div', { class: 'a-card__head' }, el('h2', {}, 'this view hit a snag')),
    el('p', { class: 'a-note' }, String(err?.message || err)),
    el('div', { class: 'a-btn-row' },
      el('button', { class: 'a-btn', onclick: () => renderRoute() }, 'try again'),
      el('button', { class: 'a-btn', onclick: () => loadAll() }, 'reload data'),
    ),
  );
}

function pageHead(title, sub, actions = []) {
  return el('div', { class: 'a-topbar' },
    el('div', {},
      el('h1', { tabindex: -1 }, title),
      sub ? el('p', { class: 'a-topbar__sub' }, sub) : null,
    ),
    actions.length ? el('div', { class: 'a-topbar__right' }, ...actions) : null,
  );
}

// ── posts list ───────────────────────────────
function renderPosts(viewEl) {
  const chipWrap = el('div', { class: 'a-chip-row' });
  const listWrap = el('div');

  function renderPostList() {
    let posts = state.posts;
    if (ui.postsFilter === 'published') posts = posts.filter((p) => !p.data.draft && !isFutureDate(p.data.pubDate));
    if (ui.postsFilter === 'scheduled') posts = posts.filter((p) => !p.data.draft && isFutureDate(p.data.pubDate));
    if (ui.postsFilter === 'drafts') posts = posts.filter((p) => p.data.draft);
    const q = ui.postsQuery.trim().toLowerCase();
    if (q) {
      posts = posts.filter(
        (p) =>
          (p.data.title || '').toLowerCase().includes(q) ||
          (p.data.tags || []).some((t) => t.toLowerCase().includes(q)),
      );
    }
    const rows = posts.map((p) =>
      el('div', { class: 'a-row' },
        el('div', { class: 'a-row__main' },
          el('a', { class: 'a-row__title', href: `#/edit/${encodeURIComponent(p.id)}` }, p.data.title || p.id),
          p.data.category ? el('span', { class: 'a-cat' }, p.data.category) : null,
          (p.data.tags || []).slice(0, 3).map((t) => el('span', { class: 'a-tag' }, `#${t}`)),
          p.data.draft ? el('span', { class: 'a-badge a-badge--draft' }, 'draft') : null,
          isFutureDate(p.data.pubDate) ? el('span', { class: 'a-badge a-badge--run' }, 'scheduled') : null,
        ),
        el('div', { class: 'a-row__date' }, pretty(p.data.pubDate)),
        el('span', { class: 'a-row__reads', title: 'pageviews (last 60 days)' }, readsTextFor(p.id)),
        el('div', { class: 'a-row__actions' },
          el('button', { class: 'a-mini', title: 'duplicate', onclick: () => duplicatePost(p) }, '⧉'),
          el('button', {
            class: 'a-mini',
            title: p.data.draft ? 'publish now' : 'move to drafts',
            onclick: () => toggleDraft(p),
          }, p.data.draft ? '🚀' : '🙈'),
          el('button', { class: 'a-mini a-mini--danger', title: 'delete', onclick: () => deletePost(p) }, '✕'),
        ),
      ),
    );
    listWrap.replaceChildren(
      posts.length === 0
        ? el('div', { class: 'a-empty' },
            el('div', { class: 'big' }, '✍'),
            q ? 'nothing matches your search.' : 'nothing here yet — write something.',
          )
        : el('div', { class: 'a-list' }, ...rows),
    );
  }

  function renderChips() {
    const chip = (label, value) =>
      el('button', {
        class: `a-chip${ui.postsFilter === value ? ' a-chip--active' : ''}`,
        onclick: () => {
          ui.postsFilter = value;
          renderChips();
          renderPostList();
        },
      }, label);
    chipWrap.replaceChildren(
      chip('all', 'all'),
      chip('published', 'published'),
      chip('scheduled', 'scheduled'),
      chip('drafts', 'drafts'),
    );
  }

  // pageview counts fill in as soon as the stats snapshot arrives
  function readsTextFor(id) {
    const n = readsFor(id);
    if (n === null) return '…';
    return n === 0 ? '0 reads' : `${n.toLocaleString()} reads`;
  }
  loadStats().then(() => {
    if (document.contains(listWrap)) renderPostList();
  });

  viewEl.replaceChildren(
    pageHead('posts', `${state.posts.length} total`, [
      el('button', { class: 'a-btn', onclick: () => (location.hash = '#/tools') }, '🧰 import / export'),
      el('button', { class: 'a-btn a-btn--primary', onclick: () => (location.hash = '#/new') }, '✍ new post'),
    ]),

    el('div', { class: 'a-toolbar-row' },
      el('input', {
        class: 'a-input a-search',
        type: 'search',
        placeholder: 'search titles & tags…',
        value: ui.postsQuery,
        oninput: (e) => {
          ui.postsQuery = e.target.value;
          renderPostList();
        },
      }),
      chipWrap,
    ),

    listWrap,
  );

  renderChips();
  renderPostList();
}

// ── posts: actions ───────────────────────────
function duplicatePost(p) {
  state.clone = { data: { ...p.data, draft: true }, body: p.body, slug: `${slugify(p.id)}-copy` };
  location.hash = '#/new';
}

async function toggleDraft(p) {
  if (actionBusy) return;
  actionBusy = true;
  const next = !p.data.draft;
  try {
    const content = buildPostMarkdown({ ...p.data, draft: next, body: p.body });
    await state.gh.commitFiles([{ path: p.path, content }], `${next ? 'move to drafts' : 'publish'} · ${p.id}`);
    p.data.draft = next;
    toast(next ? 'moved to drafts' : 'published — deploy running', 'success');
    renderRoute();
  } catch (e) {
    toast(e.message || 'update failed', 'error');
  } finally {
    actionBusy = false;
  }
}

async function deletePost(p, redirectHash) {
  if (actionBusy) return;
  if (!window.confirm(`Delete "${p.data.title || p.id}"?\n\nThis removes ${p.path} from the repo.`)) return;
  actionBusy = true;
  try {
    await state.gh.commitFiles([{ path: p.path, delete: true }], `remove post · ${p.id}`);
    state.posts = state.posts.filter((x) => x.id !== p.id);
    state.tree = null;
    toast('post deleted', 'success');
    location.hash = redirectHash || '#/posts';
  } catch (e) {
    toast(e.message || 'delete failed', 'error');
  } finally {
    actionBusy = false;
  }
}

// ── post editor ──────────────────────────────
function renderEditor(viewEl, id) {
  disposeEditors();
  const existing = id ? state.posts.find((p) => p.id === id) : null;
  if (id && !existing) {
    toast('post not found', 'error');
    location.hash = '#/posts';
    return;
  }
  const src = existing || state.clone || { data: {} };
  state.clone = null; // one-shot: never leak a duplicate into a later "new"
  state.dirty = false;
  ui.newSlugTouched = false;

  const titleInput = el('input', {
    class: 'a-title', id: 'f-title', placeholder: 'a good title…',
    value: src.data.title || '',
    oninput: () => {
      markDirty();
      if (!existing && !ui.newSlugTouched) {
        $('#f-slug').value = slugify(titleInput.value);
        updatePathHint();
      }
    },
  });

  const pubDate = el('input', { class: 'a-input', type: 'date', id: 'f-pubdate', value: src.data.pubDate || todayStr() });
  const updatedDate = el('input', { class: 'a-input', type: 'date', id: 'f-updated', value: src.data.updatedDate || '' });
  const slugInput = el('input', {
    class: 'a-input a-mono', id: 'f-slug', placeholder: 'auto from title',
    value: existing ? existing.id : src.slug || '',
    oninput: () => {
      ui.newSlugTouched = true;
      markDirty();
      updatePathHint();
    },
  });
  // current draft state — the save buttons are authoritative (no checkbox)
  let draftState = !!src.data.draft;

  const categoryInput = el('input', {
    class: 'a-input', id: 'f-category', list: 'f-category-list',
    placeholder: 'e.g. tools, essays, notes',
    value: src.data.category || '',
    oninput: markDirty,
  });
  const categoryList = el('datalist', { id: 'f-category-list' });
  const knownCategories = [...new Set(state.posts.map((p) => p.data.category).filter(Boolean))].sort();
  categoryList.replaceChildren(...knownCategories.map((c) => el('option', { value: c })));

  const descInput = el('input', {
    class: 'a-input', id: 'f-desc', placeholder: 'one line for cards, meta & RSS',
    value: src.data.description || '',
    oninput: markDirty,
  });
  const tagsInput = el('input', {
    class: 'a-input', id: 'f-tags', placeholder: 'comma separated — writing, tools',
    value: (src.data.tags || []).join(', '),
    oninput: markDirty,
  });

  // ── featured image ──
  // hero = { url, file? } — url is what gets saved in frontmatter; file is a
  // freshly picked image staged for the next commit (shows as a data-url until saved)
  let hero = { url: src.data.image || '', file: null };
  const heroInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const heroZone = el('div', { class: 'a-hero' });
  function renderHero() {
    const active = hero.file ? hero.file.dataUrl : (hero.url || '');
    if (!active) {
      heroZone.replaceChildren(
        el('div', { class: 'a-hero__empty' },
          el('span', { class: 'a-hero__icon' }, '🖼'),
          el('span', {}, 'featured image — drag & drop or'),
          el('button', { class: 'a-btn a-btn--sm', type: 'button', onclick: () => heroInput.click() }, 'choose'),
          el('span', { class: 'a-hero__hint' }, 'shown at the top of the post'),
        ),
      );
      return;
    }
    const name = hero.file ? hero.file.name : hero.url.split('/').pop();
    heroZone.replaceChildren(
      el('div', { class: 'a-hero__preview' },
        el('img', { src: active, alt: '' }),
        el('div', { class: 'a-hero__meta' },
          el('span', { class: 'a-hero__name', title: name }, name),
          el('div', { class: 'a-btn-row' },
            el('button', { class: 'a-mini', type: 'button', onclick: () => heroInput.click() }, 'replace'),
            el('button', { class: 'a-mini a-mini--danger', type: 'button', onclick: clearHero }, 'remove'),
          ),
        ),
      ),
    );
  }
  function clearHero() {
    hero = { url: '', file: null };
    renderHero();
    markDirty();
  }
  async function pickHeroFile(file) {
    if (actionBusy) {
      toast('wait for the current save to finish first', 'info');
      return;
    }
    if (!file.type.startsWith('image/')) return;
    if (file.size > MAX_IMAGE_BYTES) {
      toast(`${file.name} is over 8 MB — skipped`, 'error');
      return;
    }
    const b64 = await fileToBase64(file);
    const { filename, path } = imagePathFor(file);
    hero = {
      url: `${BASE}images/${filename}`,
      file: { path, content: b64, encoding: 'base64', name: file.name, size: file.size, dataUrl: `data:${file.type};base64,${b64}` },
    };
    renderHero();
    markDirty();
  }
  heroInput.addEventListener('change', () => {
    const f = heroInput.files?.[0];
    heroInput.value = '';
    if (f) pickHeroFile(f);
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    heroZone.addEventListener(ev, (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        heroZone.classList.add('a-hero--drag');
      }
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    heroZone.addEventListener(ev, (e) => {
      if (ev === 'dragleave' && heroZone.contains(e.relatedTarget)) return;
      e.preventDefault();
      heroZone.classList.remove('a-hero--drag');
      if (ev === 'drop') {
        const f = e.dataTransfer?.files?.[0];
        if (f) pickHeroFile(f);
      }
    }),
  );
  renderHero();

  const editorHost = el('div', { class: 'a-editor-host' }, el('p', { class: 'a-note' }, 'loading editor…'));
  let editor = null;
  // the rich editor (~300 KB) loads lazily; if it fails it degrades to a
  // plain textarea — saving and images keep working either way
  (async () => {
    try {
      const e = await createEditor({
        container: editorHost,
        value: src.body,
        onChange: () => {
          markDirty();
          updateStats();
        },
        onImage: stageEditorImage,
      });
      // the user may have navigated away while the editor was loading —
      // don't keep an editor attached to a detached host
      if (!editorHost.isConnected) {
        disposeOneEditor(e);
        return;
      }
      editor = e;
    } catch (err) {
      console.error('editor failed to load — using plain textarea', err);
      if (editorHost.isConnected) {
        editor = fallbackEditor(editorHost, src.body, () => {
          markDirty();
          updateStats();
        });
      }
      return;
    }
    updateStats();
  })();

  function currentMarkdown() {
    if (editor) return editor.getMarkdown();
    const ta = editorHost.querySelector('textarea');
    return ta ? ta.value : '';
  }
  function setEditorMarkdown(v) {
    if (editor) editor.setMarkdown(v, false);
    else {
      const ta = editorHost.querySelector('textarea');
      if (ta) ta.value = v;
    }
  }

  // ── staged images ──
  const pendingImages = [];
  const chipsEl = el('div', { class: 'a-imgchips', hidden: true });

  function renderChips() {
    chipsEl.replaceChildren(...pendingImages.map((img) =>
      el('span', { class: 'a-imgchip', title: img.path },
        el('span', { class: 'a-imgchip__name' }, img.name),
        el('span', { class: 'a-imgchip__meta' }, fmtSize(img.size)),
        el('button', { class: 'a-mini a-mini--danger', type: 'button', title: 'remove', onclick: () => removeImage(img) }, '✕'),
      ),
    ));
    chipsEl.hidden = pendingImages.length === 0;
  }

  function removeImage(img) {
    const idx = pendingImages.indexOf(img);
    if (idx === -1) return;
    pendingImages.splice(idx, 1);
    // remove the *last* occurrence — matches the most recently inserted copy
    const md = currentMarkdown();
    const at = md.lastIndexOf(img.md);
    if (at !== -1) {
      setEditorMarkdown(md.slice(0, at) + md.slice(at + img.md.length));
    }
    renderChips();
    updateStats();
    markDirty();
  }

  async function stageEditorImage(file) {
    if (actionBusy) {
      toast('wait for the current save to finish first', 'info');
      return null;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast(`${file.name} is over 8 MB — skipped`, 'error');
      return null;
    }
    const b64 = await fileToBase64(file);
    const { filename, path } = imagePathFor(file);
    const url = `${BASE}images/${filename}`;
    const alt = baseName(file.name);
    pendingImages.push({ path, content: b64, encoding: 'base64', name: file.name, size: file.size, md: `![${alt}](${url})` });
    renderChips();
    markDirty();
    return { url, alt };
  }

  // ── stats + schedule ──
  const stats = el('span', { class: 'a-mono' }, '');
  function updateStats() {
    const md = currentMarkdown();
    const w = countWords(md);
    const mins = Math.max(1, Math.ceil(w / 220));
    stats.textContent = `${w} words · ${md.length} chars · ${mins} min read`;
  }

  const scheduleNote = el('div', { class: 'a-schedule-note', hidden: true });
  function updateSchedule() {
    const d = pubDate.value;
    scheduleNote.hidden = !isFutureDate(d);
    if (!scheduleNote.hidden) {
      scheduleNote.textContent = `🗓 scheduled for ${pretty(d)} — hidden until then, then published automatically by the daily rebuild.`;
    }
  }
  pubDate.addEventListener('change', () => {
    markDirty();
    updateSchedule();
  });

  const pathHint = el('p', { class: 'a-hint' }, 'src/content/blog/', el('span', { id: 'f-path-slug', class: 'a-mono' }, ''), '.md');
  function updatePathHint() {
    const s = $('#f-path-slug');
    if (s) s.textContent = slugify($('#f-slug').value || slugify(titleInput.value) || 'post');
  }

  const dirtyDot = el('span', { class: 'a-dirtydot', hidden: true }, 'unsaved');
  function markDirty() {
    if (state.dirty) return;
    state.dirty = true;
    dirtyDot.hidden = false;
  }

  const saveDraftBtn = el('button', { class: 'a-btn', onclick: () => save(true) }, '💾 save draft');
  const previewBtn = el('button', { class: 'a-btn', onclick: preview }, '👁 preview');
  const publishBtn = el('button', { class: 'a-btn a-btn--primary', onclick: () => save(false) }, '🚀 publish');
  const statusBadge = el('span', { class: 'a-badge', hidden: true });
  function updateStatus() {
    if (draftState) {
      statusBadge.textContent = 'draft';
      statusBadge.className = 'a-badge a-badge--draft';
    } else if (isFutureDate(pubDate.value)) {
      statusBadge.textContent = 'scheduled';
      statusBadge.className = 'a-badge a-badge--run';
    } else {
      statusBadge.textContent = 'published';
      statusBadge.className = 'a-badge a-badge--ok';
    }
    statusBadge.hidden = false;
  }

  function setSaveBusy(on) {
    saveDraftBtn.disabled = on;
    publishBtn.disabled = on;
    if (on) previewBtn.disabled = true;
  }

  async function save(forceDraft) {
    if (actionBusy) return;
    if (!editor) {
      toast('editor still loading — wait a second', 'info');
      return;
    }
    const title = titleInput.value.trim();
    let slug = slugInput.value.trim() || slugify(title);
    if (!slug) {
      toast('give it a title (or a slug)', 'error');
      slugInput.focus();
      return;
    }
    slug = slugify(slug);
    // guard BOTH new posts and renames: another post owning this slug would
    // be silently overwritten when the renamed file is written over it
    const collision = state.posts.find((p) => p.id === slug && (!existing || p.id !== existing.id));
    if (collision) {
      if (!window.confirm(`"${slug}" already exists (${collision.data.title || collision.id}) — overwrite it?`)) return;
    }
    const date = pubDate.value || todayStr();
    const tags = tagsInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    const category = categoryInput.value.trim();
    // future-dated posts are NOT force-drafted: the site hides them at build
    // time until their date, and the daily rebuild publishes them then
    const draft = !!forceDraft;
    const scheduled = !draft && isFutureDate(date);

    const content = buildPostMarkdown({
      title,
      description: descInput.value.trim(),
      pubDate: date,
      updatedDate: updatedDate.value || undefined,
      tags,
      category: category || undefined,
      image: hero.url || undefined,
      draft,
      body: currentMarkdown(),
    });
    const newPath = `src/content/blog/${slug}.md`;
    // snapshot BEFORE the await — images staged while the commit is in flight
    // must not be dropped (and won't be part of this commit either)
    const staged = pendingImages.slice();
    const heroFile = hero.file ? { ...hero.file } : null;
    const files = [];
    if (existing && existing.path !== newPath) files.push({ path: existing.path, delete: true });
    files.push({ path: newPath, content });
    for (const img of staged) files.push({ path: img.path, content: img.content, encoding: 'base64' });
    if (heroFile) files.push({ path: heroFile.path, content: heroFile.content, encoding: 'base64' });

    actionBusy = true;
    setSaveBusy(true);
    setBusy(true);
    try {
      await state.gh.commitFiles(
        files,
        existing ? `✏️ update · ${title}` : (draft ? `📝 new draft · ${title}` : `✍️ new post · ${title}`),
      );
      const { data, body } = parseFrontmatter(content);
      const post = { id: slug, path: newPath, data, body };
      const idx = existing ? state.posts.findIndex((p) => p.id === existing.id) : -1;
      if (idx >= 0) state.posts.splice(idx, 1, post);
      else state.posts.push(post);
      state.posts.sort((a, b) => String(b.data.pubDate || '').localeCompare(String(a.data.pubDate || '')));
      state.dirty = false;
      dirtyDot.hidden = true;
      draftState = draft;
      updateStatus();
      // drop only the images this commit actually uploaded
      for (const img of staged) {
        const i = pendingImages.indexOf(img);
        if (i !== -1) pendingImages.splice(i, 1);
      }
      if (heroFile) hero = { url: hero.url, file: null };
      renderChips();
      renderHero();
      state.tree = null;
      const msg = draft
        ? 'draft saved — hidden from the site'
        : (scheduled ? 'post scheduled — hidden until the publish date' : (existing ? 'post updated — deploy running' : 'post published — deploy running'));
      toast(msg, 'success');
      if (!existing) {
        location.hash = `#/edit/${encodeURIComponent(slug)}`;
      } else {
        renderEditor(viewEl, slug);
      }
    } catch (e) {
      toast(e.message || 'save failed', 'error');
    } finally {
      actionBusy = false;
      setSaveBusy(false);
      setBusy(false);
    }
  }

  function fullMarkdown() {
    return buildPostMarkdown({
      title: titleInput.value.trim(),
      description: descInput.value.trim(),
      pubDate: pubDate.value || todayStr(),
      updatedDate: updatedDate.value || undefined,
      tags: tagsInput.value.split(',').map((s) => s.trim()).filter(Boolean),
      category: categoryInput.value.trim() || undefined,
      image: hero.url || undefined,
      draft: draftState,
      body: currentMarkdown(),
    });
  }

  async function copyMd() {
    if (!editor) {
      toast('editor still loading — wait a second', 'info');
      return;
    }
    if (await copyText(fullMarkdown())) toast('markdown copied', 'info');
    else toast('could not copy', 'error');
  }

  function downloadMd() {
    if (!editor) {
      toast('editor still loading — wait a second', 'info');
      return;
    }
    const blob = new Blob([fullMarkdown()], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slugify(slugInput.value || titleInput.value) || 'post'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── post preview (rendered with the same markdown engine the editor uses) ──
  async function preview() {
    let marked;
    try {
      ({ marked } = await loadMarked());
    } catch (err) {
      console.error(err);
      toast('could not load the preview renderer', 'error');
      return;
    }
    const title = titleInput.value.trim() || 'untitled';
    const date = pubDate.value || todayStr();
    const category = categoryInput.value.trim();
    const tags = tagsInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    const heroUrl = hero.file ? hero.file.dataUrl : (hero.url || '');
    const md = currentMarkdown();

    const metaBits = [
      el('time', { datetime: date }, pretty(date)),
      category ? el('span', { class: 'a-preview__cat' }, category) : null,
      ...tags.map((t) => el('span', { class: 'a-tag' }, `#${t}`)),
    ].filter(Boolean);

    const body = el('div', { class: 'prose' });
    body.innerHTML = marked.parse(md, { gfm: true, breaks: false });

    const closeBtn = el('button', { class: 'a-mini', type: 'button', 'aria-label': 'close preview' }, '✕');
    const overlay = el('div', { class: 'a-overlay' });
    overlay.append(
      el('div', { class: 'a-preview' },
        el('div', { class: 'a-preview__head' },
          el('h1', { class: 'a-preview__title' }, title),
          closeBtn,
        ),
        el('div', { class: 'a-preview__meta' }, ...metaBits),
        heroUrl ? el('img', { class: 'post__hero', src: heroUrl, alt: '' }) : null,
        el('div', { class: 'a-preview__body' }, body),
        el('div', { class: 'a-preview__foot' },
          el('span', { class: 'a-mono' }, `${countWords(md)} words · ${Math.max(1, Math.ceil(countWords(md) / 220))} min read`),
          el('button', { class: 'a-btn a-btn--sm', type: 'button' }, 'close'),
        ),
      ),
    );
    document.body.append(overlay);
    document.body.classList.add('a-locked');

    function close() {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('a-locked');
      overlay.remove();
      titleInput.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    closeBtn.addEventListener('click', close);
    overlay.querySelector('.a-preview__foot .a-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    closeBtn.focus();
  }

  viewEl.replaceChildren(
    el('div', {},
      el('div', { class: 'a-editor__head' },
        el('a', { class: 'a-back', href: '#/posts' }, '← all posts'),
        el('div', { class: 'a-btn-row' },
          existing
            ? el('button', { class: 'a-btn a-btn--danger a-btn--sm', onclick: () => deletePost(existing) }, 'delete')
            : null,
          saveDraftBtn,
          previewBtn,
          publishBtn,
        ),
      ),

      titleInput,

      el('div', { class: 'a-meta-grid' },
        el('label', { class: 'a-label' }, 'published', pubDate),
        el('label', { class: 'a-label' }, 'updated', updatedDate),
        el('label', { class: 'a-label' }, 'slug', slugInput),
        el('label', { class: 'a-label' }, 'category', categoryInput, categoryList),
      ),

      el('div', { class: 'a-meta-grid' },
        el('label', { class: 'a-label' }, 'description', descInput),
        el('label', { class: 'a-label' }, 'tags', tagsInput),
      ),

      scheduleNote,
      heroZone,
      heroInput,

      el('div', { class: 'a-toolbar' },
        el('div', { class: 'a-toolbar__left' }, stats, statusBadge, dirtyDot),
        el('div', { class: 'a-toolbar__right' },
          el('button', { class: 'a-mini', onclick: copyMd }, 'copy md'),
          el('button', { class: 'a-mini', onclick: downloadMd }, 'download'),
        ),
      ),

      chipsEl,
      editorHost,

      el('div', { class: 'a-editor__foot' },
        pathHint,
        el('span', {}, 'images: upload button, drag & drop, or paste'),
      ),
    ),
  );

  updateSchedule();
  updatePathHint();
  updateStats();
  updateStatus();
}

// ── analytics ────────────────────────────────
// stats.json is written by the deploy workflow (GoatCounter → repo) and
// served same-origin, so no CORS and no third-party keys in the browser.
async function loadStats() {
  if (state.stats) return state.stats;
  try {
    const res = await fetch(`${BASE}stats.json`, { cache: 'no-store' });
    if (!res.ok) {
      state.stats = null;
      return null;
    }
    state.stats = await res.json();
  } catch {
    state.stats = null;
  }
  return state.stats;
}

/** pageview count for a post slug (from the stats snapshot), or null */
function readsFor(slug) {
  const path = `${BASE}posts/${slug}/`;
  const hit = (state.stats?.hits || []).find((h) => h.path === path);
  return hit ? hit.count : null;
}

function statsWeekTotal() {
  const days = state.stats?.days || [];
  return days.slice(-7).reduce((n, d) => n + (d.daily || 0), 0);
}

function statsMonthTotal() {
  const days = state.stats?.days || [];
  return days.slice(-30).reduce((n, d) => n + (d.daily || 0), 0);
}

// ── media library ────────────────────────────
async function loadTree() {
  if (!state.tree) state.tree = await state.gh.listTree();
  return state.tree;
}

async function renderMedia(viewEl) {
  setBusy(true);
  try {
    const tree = await loadTree();
    const items = tree.filter((f) => f.path.startsWith('public/images/'));
    const total = items.reduce((n, f) => n + (f.size || 0), 0);

    const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    fileInput.addEventListener('change', () => {
      const files = [...(fileInput.files || [])];
      fileInput.value = '';
      if (files.length) uploadMedia(files, viewEl);
    });

    const grid = el('div', { class: 'a-media' }, ...items.map((f) => {
      const url = `${BASE}${f.path.replace('public/', '')}`;
      const md = `![${baseName(f.path.split('/').pop())}](${url})`;
      return el('div', { class: 'a-media-item' },
        el('div', { class: 'a-media-item__thumb' },
          el('img', { src: url, alt: '', loading: 'lazy' }),
        ),
        el('div', { class: 'a-media-item__body' },
          el('div', { class: 'a-media-item__name', title: f.path }, f.path.replace('public/', '')),
          el('div', { class: 'a-media-item__meta' }, fmtSize(f.size || 0)),
          el('div', { class: 'a-btn-row' },
            el('button', { class: 'a-mini', title: 'copy markdown', onclick: async () => {
              if (await copyText(md)) toast('markdown copied', 'info');
            } }, 'copy md'),
            el('button', { class: 'a-mini', title: 'copy URL', onclick: async () => {
              if (await copyText(url)) toast('URL copied', 'info');
            } }, 'url'),
            el('button', { class: 'a-mini a-mini--danger', title: 'delete', onclick: () => deleteMedia(f, viewEl) }, '✕'),
          ),
        ),
      );
    }));

    viewEl.replaceChildren(
      pageHead('media', `${items.length} images · ${fmtSize(total)}`, [
        el('button', { class: 'a-btn', onclick: () => renderMedia(viewEl) }, '↻ refresh'),
        el('button', { class: 'a-btn a-btn--primary', onclick: () => fileInput.click() }, '⬆ upload'),
        fileInput,
      ]),
      items.length === 0
        ? el('div', { class: 'a-card' },
            el('div', { class: 'a-card__head' }, el('h2', {}, 'no images yet')),
            el('p', { class: 'a-note' }, 'Images you add to posts (or upload here) land in public/images and appear here.'),
            el('button', { class: 'a-btn a-btn--primary', onclick: () => fileInput.click() }, '⬆ upload images'),
            fileInput,
          )
        : grid,
    );
  } catch (e) {
    toast(e.message || 'could not load media', 'error');
  } finally {
    setBusy(false);
  }
}

async function uploadMedia(files, viewEl) {
  if (actionBusy) return;
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (imgs.length === 0) return;
  actionBusy = true;
  setBusy(true);
  try {
    const toCommit = [];
    for (const f of imgs) {
      if (f.size > MAX_IMAGE_BYTES) {
        toast(`${f.name} is over 8 MB — skipped`, 'error');
        continue;
      }
      const b64 = await fileToBase64(f);
      const { path } = imagePathFor(f);
      toCommit.push({ path, content: b64, encoding: 'base64' });
    }
    if (toCommit.length) {
      await state.gh.commitFiles(toCommit, `🖼 upload ${toCommit.length} image${toCommit.length > 1 ? 's' : ''}`);
      state.tree = null;
      toast(`${toCommit.length} image${toCommit.length > 1 ? 's' : ''} uploaded — deploy running`, 'success');
    }
    renderMedia(viewEl);
  } catch (e) {
    toast(e.message || 'upload failed', 'error');
  } finally {
    actionBusy = false;
    setBusy(false);
  }
}

async function deleteMedia(item, viewEl) {
  if (actionBusy) return;
  if (!window.confirm(`Delete ${item.path}?`)) return;
  actionBusy = true;
  setBusy(true);
  try {
    await state.gh.commitFiles([{ path: item.path, delete: true }], `🗑 delete image · ${item.path}`);
    state.tree = null;
    toast('image deleted', 'success');
    renderMedia(viewEl);
  } catch (e) {
    toast(e.message || 'delete failed', 'error');
  } finally {
    actionBusy = false;
    setBusy(false);
  }
}

// ── pages & files manager ────────────────────
const TEXT_EXT = /\.(md|mdx|astro|ts|mjs|js|css|json|xml|svg|txt)$/;

async function renderFiles(viewEl) {
  setBusy(true);
  try {
    const tree = await loadTree();
    const files = tree
      .filter((f) => TEXT_EXT.test(f.path) && !f.path.includes('node_modules') && !f.path.startsWith('public/images/'))
      .sort((a, b) => a.path.localeCompare(b.path));

    const quick = [
      'src/pages/about.astro',
      'src/pages/404.astro',
      'src/components/Footer.astro',
      'src/components/Header.astro',
      'src/styles/global.css',
      'src/pages/now.astro',
      'src/content.config.ts',
      'astro.config.mjs',
    ];
    const quickLinks = quick.map((p) =>
      el('a', { class: 'a-chip', href: `#/file/${encodeURIComponent(p)}` }, p.split('/').pop()),
    );

    const groups = new Map();
    for (const f of files) {
      const dir = f.path.includes('/') ? f.path.split('/').slice(0, 2).join('/') : 'root';
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(f);
    }
    const groupEls = [...groups.entries()].map(([dir, list]) =>
      el('div', { class: 'a-tree-group' },
        el('div', { class: 'a-tree-group__title' }, dir),
        el('div', { class: 'a-tree' }, ...list.map((f) =>
          el('div', { class: 'a-tree-row' },
            el('span', { class: 'a-tree-row__path', title: f.path }, f.path),
            el('div', { class: 'a-row__actions' },
              el('span', { class: 'a-mono', style: 'font-size:.7rem;color:var(--a-faint);' }, fmtSize(f.size || 0)),
              el('a', { class: 'a-mini', href: `#/file/${encodeURIComponent(f.path)}` }, 'edit'),
            ),
          ),
        )),
      ),
    );

    viewEl.replaceChildren(
      pageHead('pages & files', 'every text file in the repo, editable', []),
      el('div', { class: 'a-card' },
        el('div', { class: 'a-card__head' }, el('h2', {}, 'quick edits')),
        el('div', { class: 'a-btn-row' }, ...quickLinks),
      ),
      ...groupEls,
    );
  } catch (e) {
    toast(e.message || 'could not load files', 'error');
  } finally {
    setBusy(false);
  }
}

async function renderFile(viewEl, path) {
  setBusy(true);
  let file;
  try {
    file = await state.gh.getTextFile(path);
  } catch (e) {
    toast(e.message || 'could not read file', 'error');
    location.hash = '#/files';
    return;
  } finally {
    setBusy(false);
  }

  state.dirty = false;
  const ta = el('textarea', { class: 'a-code', spellcheck: 'false' }, file.content);
  ta.addEventListener('input', () => {
    state.dirty = true;
    dirtyDot.hidden = false;
  });
  const dirtyDot = el('span', { class: 'a-dirtydot', hidden: true }, 'unsaved');
  const saveBtn = el('button', { class: 'a-btn a-btn--primary', onclick: saveFile }, 'save file');
  const githubLink = `https://github.com/${state.gh.owner}/${state.gh.repo}/blob/${state.gh.branch}/${path}`;

  async function saveFile() {
    if (actionBusy) return;
    actionBusy = true;
    saveBtn.disabled = true;
    setBusy(true);
    try {
      await state.gh.commitFiles([{ path, content: ta.value }], `✏️ edit ${path}`);
      state.tree = null;
      state.dirty = false;
      dirtyDot.hidden = true;
      toast('file saved — deploy running', 'success');
    } catch (e) {
      toast(e.message || 'save failed', 'error');
    } finally {
      actionBusy = false;
      saveBtn.disabled = false;
      setBusy(false);
    }
  }

  const isCode = /\.(ts|mjs|js|astro|css)$/.test(path);
  viewEl.replaceChildren(
    pageHead('edit file',
      el('span', { class: 'a-mono' }, path),
      [
        el('a', { class: 'a-out', href: githubLink, target: '_blank', rel: 'noopener' }, 'view on github ↗'),
        el('button', { class: 'a-btn', onclick: () => (location.hash = '#/files') }, '← all files'),
        saveBtn,
        dirtyDot,
      ],
    ),
    el('div', {},
      isCode
        ? el('p', { class: 'a-note' }, 'This is site code — be careful. A syntax error will break the build until fixed.')
        : null,
      ta,
    ),
  );
}

// ── tags ─────────────────────────────────────
function tagCounts() {
  const counts = {};
  for (const p of state.posts) {
    for (const t of p.data.tags || []) counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

function renderTags(viewEl) {
  const counts = tagCounts();
  const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));

  const rows = names.map((tag) =>
    el('div', { class: 'a-row' },
      el('div', { class: 'a-row__main' },
        el('span', { class: 'a-tag' }, `#${tag}`),
        el('span', { class: 'a-count' }, `${counts[tag]} post${counts[tag] > 1 ? 's' : ''}`),
      ),
      el('div', { class: 'a-row__actions' },
        el('button', { class: 'a-mini', title: 'show posts with this tag', onclick: () => {
          ui.postsFilter = 'all';
          ui.postsQuery = tag;
          location.hash = '#/posts';
        } }, 'filter'),
        el('button', { class: 'a-mini', title: 'rename across all posts', onclick: () => renameTag(tag) }, 'rename'),
        el('button', { class: 'a-mini a-mini--danger', title: 'remove from all posts', onclick: () => removeTag(tag) }, '✕'),
      ),
    ),
  );

  viewEl.replaceChildren(
    pageHead('tags', `${names.length} tags across ${state.posts.length} posts`, [
      el('button', { class: 'a-btn', onclick: () => renderTags(viewEl) }, '↻ refresh'),
    ]),
    names.length === 0
      ? el('div', { class: 'a-card' },
          el('div', { class: 'a-card__head' }, el('h2', {}, 'no tags yet')),
          el('p', { class: 'a-note' }, 'Add comma-separated tags to a post and they will show up here.'),
        )
      : el('div', { class: 'a-list' }, ...rows),
  );
}

async function renameTag(oldTag) {
  const fresh = window.prompt('New tag name', oldTag);
  if (!fresh || fresh.trim() === oldTag) return;
  const name = fresh.trim().toLowerCase().replace(/\s+/g, '-');
  if (!name) return;
  const changed = state.posts
    .filter((p) => (p.data.tags || []).includes(oldTag))
    .map((p) => ({
      p,
      content: buildPostMarkdown({ ...p.data, tags: (p.data.tags || []).map((t) => (t === oldTag ? name : t)), body: p.body }),
    }));
  if (changed.length === 0) return;
  actionBusy = true;
  setBusy(true);
  try {
    await state.gh.commitFiles(
      changed.map(({ p, content }) => ({ path: p.path, content })),
      `🏷 rename tag #${oldTag} → #${name}`,
    );
    for (const { p } of changed) {
      p.data.tags = (p.data.tags || []).map((t) => (t === oldTag ? name : t));
    }
    toast(`renamed #${oldTag} → #${name} (${changed.length} post${changed.length > 1 ? 's' : ''})`, 'success');
    renderRoute();
  } catch (e) {
    toast(e.message || 'rename failed', 'error');
  } finally {
    actionBusy = false;
    setBusy(false);
  }
}

async function removeTag(tag) {
  if (!window.confirm(`Remove #${tag} from all ${tagCounts()[tag]} posts?`)) return;
  const changed = state.posts
    .filter((p) => (p.data.tags || []).includes(tag))
    .map((p) => ({
      p,
      content: buildPostMarkdown({ ...p.data, tags: (p.data.tags || []).filter((t) => t !== tag), body: p.body }),
    }));
  if (changed.length === 0) return;
  actionBusy = true;
  setBusy(true);
  try {
    await state.gh.commitFiles(changed.map(({ p, content }) => ({ path: p.path, content })), `🏷 remove tag #${tag}`);
    for (const { p } of changed) p.data.tags = (p.data.tags || []).filter((t) => t !== tag);
    toast(`removed #${tag} from ${changed.length} post${changed.length > 1 ? 's' : ''}`, 'success');
    renderRoute();
  } catch (e) {
    toast(e.message || 'update failed', 'error');
  } finally {
    actionBusy = false;
    setBusy(false);
  }
}

// ── import / export ──────────────────────────
function renderTools(viewEl) {
  const exportBtn = el('button', { class: 'a-btn a-btn--primary', onclick: exportAll }, '⬇ download all posts (.zip)');

  const importInput = el('input', { type: 'file', accept: '.md,.mdx', multiple: true, hidden: true });
  const importWrap = el('div');

  function renderImportList() {
    if (ui.importItems.length === 0) {
      importWrap.replaceChildren(el('p', { class: 'a-note' }, 'Nothing staged yet.'));
      return;
    }
    const rows = ui.importItems.map((it, i) =>
      el('div', { class: 'a-row' },
        el('div', { class: 'a-row__main' },
          el('span', { class: 'a-row__title' }, it.data.title || it.fileName),
          el('input', {
            class: 'a-input a-mono', style: 'max-width:14rem;', value: it.slug,
            oninput: (e) => { it.slug = slugify(e.target.value); },
          }),
          el('label', { class: 'a-check' },
            el('input', { class: 'a-checkbox', type: 'checkbox', checked: !!it.data.draft,
              onchange: (e) => { it.data.draft = e.target.checked; } }),
            'draft',
          ),
        ),
        el('div', { class: 'a-row__actions' },
          el('button', { class: 'a-mini a-mini--danger', title: 'remove', onclick: () => {
            ui.importItems.splice(i, 1);
            renderImportList();
          } }, '✕'),
        ),
      ),
    );
    importWrap.replaceChildren(
      el('div', { class: 'a-list' }, ...rows),
      el('div', { class: 'a-btn-row', style: 'margin-top:.7rem;' },
        el('button', { class: 'a-btn a-btn--primary', onclick: importAll }, `import ${ui.importItems.length} post${ui.importItems.length > 1 ? 's' : ''}`),
        el('button', { class: 'a-btn', onclick: () => { ui.importItems = []; renderImportList(); } }, 'clear'),
      ),
    );
  }

  function onImportFiles(files) {
    const mds = [...files].filter((f) => /\.mdx?$/i.test(f.name));
    if (mds.length === 0) {
      toast('drop .md files', 'error');
      return;
    }
    for (const f of mds) {
      const reader = new FileReader();
      reader.onload = () => {
        const { data, body } = parseFrontmatter(String(reader.result || ''));
        const slug = slugify(f.name.replace(/\.mdx?$/i, '')) || slugify(data.title || 'post');
        const full = { ...data, pubDate: data.pubDate || todayStr(), tags: data.tags || [], draft: data.draft !== undefined ? data.draft : true };
        ui.importItems.push({ fileName: f.name, slug, data: full, body });
        renderImportList();
      };
      reader.readAsText(f);
    }
  }

  async function importAll() {
    if (ui.importItems.length === 0) return;
    const dups = ui.importItems.filter((it) => state.posts.some((p) => p.id === it.slug));
    if (dups.length) {
      if (!window.confirm(`${dups.length} slug(s) already exist (${dups.map((d) => d.slug).join(', ')}). Overwrite them?`)) return;
    }
    actionBusy = true;
    setBusy(true);
    try {
      const files = ui.importItems.map((it) => ({
        path: `src/content/blog/${it.slug}.md`,
        content: buildPostMarkdown({ ...it.data, body: it.body }),
      }));
      await state.gh.commitFiles(files, `📥 import ${files.length} post${files.length > 1 ? 's' : ''}`);
      for (const it of ui.importItems) {
        const { data, body } = parseFrontmatter(buildPostMarkdown({ ...it.data, body: it.body }));
        const post = { id: it.slug, path: `src/content/blog/${it.slug}.md`, data, body };
        const idx = state.posts.findIndex((p) => p.id === it.slug);
        if (idx >= 0) state.posts.splice(idx, 1, post);
        else state.posts.push(post);
      }
      state.posts.sort((a, b) => String(b.data.pubDate || '').localeCompare(String(a.data.pubDate || '')));
      state.tree = null;
      ui.importItems = [];
      renderImportList();
      toast(`${files.length} post${files.length > 1 ? 's' : ''} imported — deploy running`, 'success');
      renderRoute();
    } catch (e) {
      toast(e.message || 'import failed', 'error');
    } finally {
      actionBusy = false;
      setBusy(false);
    }
  }

  async function exportAll() {
    let zipSync, strToU8;
    try {
      ({ zipSync, strToU8 } = await loadFflate());
    } catch (err) {
      console.error(err);
      toast('could not load the zip library — check your connection', 'error');
      return;
    }
    const files = {};
    for (const p of state.posts) {
      files[`posts/${p.id}.md`] = strToU8(buildPostMarkdown({ ...p.data, body: p.body }));
    }
    if (state.now) files['now.md'] = strToU8(buildNowMarkdown({ ...state.now.data, body: state.now.body }));
    files['README.txt'] = strToU8(
      `Backup of ${state.gh.owner}/${state.gh.repo} — ${state.posts.length} posts, exported ${new Date().toISOString().slice(0, 10)}.\nRe-import with the admin's import tool.\n`,
    );
    const blob = new Blob([zipSync(files)], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `my-corner-posts-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('backup downloaded', 'success');
  }

  // drag & drop for imports
  const dropCard = el('div', { class: 'a-card', style: 'position:relative;' });
  ['dragenter', 'dragover'].forEach((ev) =>
    dropCard.addEventListener(ev, (e) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    }),
  );
  dropCard.addEventListener('drop', (e) => {
    e.preventDefault();
    onImportFiles([...(e.dataTransfer?.files || [])]);
  });

  dropCard.replaceChildren(
    el('div', { class: 'a-card__head' }, el('h2', {}, 'import posts')),
    el('p', { class: 'a-note' }, 'Drop .md files here, or pick them — each becomes a new post you can review before importing.'),
    el('div', { class: 'a-btn-row' },
      el('button', { class: 'a-btn', onclick: () => importInput.click() }, 'choose .md files'),
      importInput,
    ),
    el('div', { style: 'margin-top:.7rem;' }, importWrap),
  );

  viewEl.replaceChildren(
    pageHead('import & export', 'backups and bulk imports', []),
    el('div', { class: 'a-card' },
      el('div', { class: 'a-card__head' }, el('h2', {}, 'export')),
      el('p', { class: 'a-note' }, `Back up all ${state.posts.length} posts (plus the now page) as a single .zip of markdown files.`),
      el('div', { class: 'a-btn-row' }, exportBtn),
    ),
    dropCard,
    renderImportList(),
  );
}

// ── analytics ────────────────────────────────
async function renderAnalytics(viewEl) {
  const stats = await loadStats();
  const siteCode = store.get(KEYS.analyticsSite);
  const dashLink = siteCode
    ? `https://${siteCode}.goatcounter.com/`
    : 'https://www.goatcounter.com/';

  if (!stats) {
    viewEl.replaceChildren(
      pageHead('analytics', 'pageviews & reads', [
        el('button', { class: 'a-btn', onclick: () => renderAnalytics(viewEl) }, '↻ refresh'),
      ]),
      el('div', { class: 'a-card' },
        el('div', { class: 'a-card__head' }, el('h2', {}, 'no stats yet')),
        el('p', { class: 'a-note' },
          'Views are counted by a privacy-friendly GoatCounter beacon (no cookies, no personal data) and snapshotted into the repo on every deploy. To switch it on:',
        ),
        el('ol', { class: 'a-steps' },
          el('li', {}, 'Create a free site at ',
            el('a', { class: 'a-out', href: 'https://www.goatcounter.com/signup', target: '_blank', rel: 'noopener' }, 'goatcounter.com/signup ↗'),
          ),
          el('li', {}, 'Set ',
            el('code', { class: 'a-mono' }, `analytics: 'your-code'`),
            ' in ', el('code', { class: 'a-mono' }, 'src/consts.ts'),
            ' — the counter script loads automatically.',
          ),
          el('li', {}, 'Add two repo secrets (Settings → Secrets → Actions): ',
            el('code', { class: 'a-mono' }, 'GOATCOUNTER_SITE'),
            ' (your code) and ',
            el('code', { class: 'a-mono' }, 'GOATCOUNTER_API_KEY'),
            ' (from GoatCounter → your username → API).',
          ),
          el('li', {}, 'Deploy once (or wait for the daily rebuild) — the numbers appear here and on the dashboard.'),
        ),
        el('div', { class: 'a-btn-row' },
          el('a', { class: 'a-btn', href: dashLink, target: '_blank', rel: 'noopener' }, 'goatcounter ↗'),
        ),
      ),
    );
    return;
  }

  const days = stats.days || [];
  const last14 = days.slice(-14);
  const maxDay = Math.max(1, ...last14.map((d) => d.daily || 0));
  const bars = last14
    .map((d, i) => {
      const h = Math.max(d.daily > 0 ? 1 : 0, Math.round(((d.daily || 0) / maxDay) * 26));
      const x = (i / last14.length) * 100 + 1;
      const w = 100 / last14.length - 2;
      return `<rect x="${x.toFixed(2)}" y="${31 - h}" width="${w.toFixed(2)}" height="${h}" rx="1"/>`;
    })
    .join('');
  const chart = el('svg', {
    class: 'a-chart',
    viewBox: '0 0 100 32',
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
    html: bars,
  });
  const chartWrap = el('div', { class: 'a-chart-wrap' },
    el('div', { class: 'a-chart__axis' },
      el('span', { class: 'a-mono' }, last14[0]?.day ? pretty(last14[0].day) : ''),
      el('span', { class: 'a-mono' }, last14[last14.length - 1]?.day ? pretty(last14[last14.length - 1].day) : ''),
    ),
    chart,
  );

  const hits = stats.hits || [];
  const maxHit = Math.max(1, ...hits.map((h) => h.count || 0));
  const topRows = hits.slice(0, 10).map((h, i) => {
    const slug = h.path.startsWith(`${BASE}posts/`) ? h.path.slice(BASE.length + 6).replace(/\/$/, '') : null;
    const name = h.title || h.path;
    return el('div', { class: 'a-row' },
      el('div', { class: 'a-row__main' },
        el('span', { class: 'a-rank' }, String(i + 1)),
        slug
          ? el('a', { class: 'a-row__title', href: `#/edit/${encodeURIComponent(slug)}` }, name)
          : el('span', { class: 'a-row__title' }, name),
        el('div', { class: 'a-bar' },
          el('div', { class: 'a-bar__fill', style: `width:${Math.max(2, Math.round((h.count / maxHit) * 100))}%;` }),
        ),
      ),
      el('div', { class: 'a-row__reads' }, `${(h.count || 0).toLocaleString()} views`),
      el('div', { class: 'a-row__date' }, el('span', { class: 'a-mono', style: 'font-size:.7rem;color:var(--a-faint);' }, h.path)),
    );
  });

  const miniStat = (label, n) =>
    el('div', { class: 'a-mini-stat' },
      el('span', { class: 'a-mini-stat__num' }, n.toLocaleString()),
      el('span', { class: 'a-mini-stat__label' }, label),
    );

  viewEl.replaceChildren(
    pageHead('analytics', stats.generated_at ? `snapshot from ${relTime(stats.generated_at)} · refreshes with each deploy` : 'pageviews & reads', [
      el('a', { class: 'a-out', href: dashLink, target: '_blank', rel: 'noopener' }, 'goatcounter ↗'),
      el('button', { class: 'a-btn', onclick: renderAnalytics }, '↻ refresh'),
    ]),

    el('div', { class: 'a-stats' },
      miniStat('total views', stats.total || 0),
      miniStat('last 7 days', statsWeekTotal()),
      miniStat('last 30 days', statsMonthTotal()),
      miniStat('top post', hits[0] ? hits[0].count || 0 : 0),
    ),

    el('div', { class: 'a-card' },
      el('div', { class: 'a-card__head' }, el('h2', {}, 'last 14 days')),
      chartWrap,
    ),

    el('div', { class: 'a-card' },
      el('div', { class: 'a-card__head' },
        el('h2', {}, 'top posts'),
        el('span', { class: 'a-note' }, `${hits.length} paths tracked`),
      ),
      hits.length === 0
        ? el('p', { class: 'a-note' }, 'No pageviews recorded yet — share the site and they will show up here.')
        : el('div', { class: 'a-list' }, ...topRows),
    ),
  );
}

// ── deploy ───────────────────────────────────
async function renderDeploy(viewEl) {
  const runsWrap = el('div', { id: 'a-runs' });

  async function refresh() {
    runsWrap.replaceChildren(el('p', { class: 'a-note' }, 'loading…'));
    try {
      const runs = await state.gh.listWorkflowRuns(8);
      if (runs.length === 0) {
        runsWrap.replaceChildren(el('p', { class: 'a-note' }, 'no workflow runs yet — push or save something first.'));
        return;
      }
      runsWrap.replaceChildren(
        el('div', { class: 'a-list' }, ...runs.map((r) => {
          const done = r.status === 'completed';
          const ok = done && r.conclusion === 'success';
          const cls = done ? (ok ? 'a-badge--ok' : 'a-badge--bad') : 'a-badge--run';
          return el('div', { class: 'a-row' },
            el('div', { class: 'a-row__main' },
              el('span', { class: `a-badge ${cls}` }, done ? r.conclusion : r.status),
              el('span', { class: 'a-row__title', style: 'font-weight:500;' }, r.name || 'deploy'),
            ),
            el('div', { class: 'a-row__date' },
              `${relTime(r.created_at)} · ${(r.head_sha || '').slice(0, 7)} · `,
              el('a', { class: 'a-out', href: r.html_url, target: '_blank', rel: 'noopener' }, 'view ↗'),
            ),
          );
        })),
      );
    } catch {
      runsWrap.replaceChildren(el('p', { class: 'a-note' }, 'could not fetch runs (Actions may be off or the token lacks workflow read).'));
    }
  }

  const triggerBtn = el('button', { class: 'a-btn a-btn--primary', onclick: trigger }, '🚀 rebuild & deploy now');
  async function trigger() {
    if (actionBusy) return;
    actionBusy = true;
    triggerBtn.disabled = true;
    try {
      await state.gh.triggerWorkflow();
      toast('deploy started — watch it below', 'success');
      setTimeout(refresh, 2500);
    } catch (e) {
      toast(
        /403|scope|permission/i.test(e.message)
          ? 'Your token cannot trigger workflows — it needs workflow (or Actions: read & write on a fine-grained token) permission.'
          : e.message || 'trigger failed',
        'error',
      );
    } finally {
      actionBusy = false;
      triggerBtn.disabled = false;
    }
  }

  viewEl.replaceChildren(
    pageHead('deploy', 'build & publish status', [
      el('button', { class: 'a-btn', onclick: refresh }, '↻ refresh'),
      triggerBtn,
    ]),
    el('div', { class: 'a-card' },
      el('div', { class: 'a-card__head' }, el('h2', {}, 'recent runs')),
      runsWrap,
    ),
    el('div', { class: 'a-card' },
      el('div', { class: 'a-card__head' }, el('h2', {}, 'how publishing works')),
      el('p', { class: 'a-note' },
        'Every save in this admin is a commit to main. GitHub Actions builds the site and deploys it to Pages — usually in about a minute. ',
        'Future-dated posts stay hidden until their publish date — the daily rebuild workflow publishes them automatically.',
      ),
    ),
  );

  refresh();
}

// ── settings ─────────────────────────────────
function renderSettings(viewEl) {
  if (!state.settings) {
    viewEl.replaceChildren(el('div', { class: 'a-card' }, el('p', { class: 'a-note' }, 'settings not loaded yet.')));
    return;
  }
  const fields = readConsts(state.settings.content);
  const title = el('input', { class: 'a-input', id: 's-title', value: fields.title, oninput: markDirty });
  const author = el('input', { class: 'a-input', id: 's-author', value: fields.author, oninput: markDirty });
  const desc = el('textarea', { class: 'a-textarea', id: 's-desc', rows: 3, oninput: markDirty }, fields.description);
  const dirtyDot = el('span', { class: 'a-dirtydot', hidden: true }, 'unsaved');
  function markDirty() {
    state.dirty = true;
    dirtyDot.hidden = false;
  }

  const saveBtn = el('button', { class: 'a-btn a-btn--primary', onclick: save }, 'save changes');
  const githubLink = `https://github.com/${state.gh.owner}/${state.gh.repo}/blob/${state.gh.branch}/src/consts.ts`;

  async function save() {
    if (actionBusy) return;
    const values = { title: title.value.trim(), author: author.value.trim(), description: desc.value.trim() };
    if (!values.title) {
      toast('title cannot be empty', 'error');
      return;
    }
    actionBusy = true;
    saveBtn.disabled = true;
    setBusy(true);
    try {
      const content = writeConsts(state.settings.content, values);
      await state.gh.commitFiles([{ path: state.settings.path, content }], '⚙️ update site settings');
      state.settings.content = content;
      state.dirty = false;
      dirtyDot.hidden = true;
      toast('settings saved — deploy running', 'success');
    } catch (e) {
      toast(e.message || 'save failed', 'error');
    } finally {
      actionBusy = false;
      saveBtn.disabled = false;
      setBusy(false);
    }
  }

  viewEl.replaceChildren(
    pageHead('settings', 'the SITE object in src/consts.ts', []),
    el('div', { class: 'a-card' },
      el('div', { class: 'a-card__head' },
        el('h2', {}, 'site settings'),
        dirtyDot,
      ),
      el('p', { class: 'a-note' }, 'Used in the header, footer, meta tags and the RSS feed.'),
      el('div', { class: 'a-meta-grid' },
        el('label', { class: 'a-label' }, 'title', title),
        el('label', { class: 'a-label' }, 'author', author),
        el('label', { class: 'a-label' }, 'description', desc),
      ),
      el('div', { class: 'a-btn-row' }, saveBtn),
      el('p', { class: 'a-hint' }, 'file: ',
        el('a', { class: 'a-out a-mono', href: githubLink, target: '_blank', rel: 'noopener' }, 'src/consts.ts ↗'),
      ),
    ),
    el('div', { class: 'a-card' },
      el('div', { class: 'a-card__head' }, el('h2', {}, 'security')),
      el('p', { class: 'a-note' }, 'The token lives only in this browser. Locking clears it; auto-lock does it for you.'),
      el('label', { class: 'a-check' },
        el('input', { class: 'a-checkbox', type: 'checkbox', id: 's-autolock', checked: autoLockEnabled(),
          onchange: (e) => store.set(KEYS.autoLock, e.target.checked ? '1' : '0') }),
        `auto-lock after ${AUTO_LOCK_MIN} minutes of inactivity`,
      ),
    ),
    el('div', { class: 'a-card' },
      el('div', { class: 'a-card__head' }, el('h2', {}, 'analytics')),
      el('p', { class: 'a-note' },
        'Views are counted by GoatCounter and snapshotted into the repo on each deploy (see the analytics view).',
      ),
      el('div', { class: 'a-meta-grid' },
        el('label', { class: 'a-label' },
          'goatcounter site code (for the dashboard link)',
          el('input', {
            class: 'a-input a-mono', id: 's-analytics-site',
            placeholder: 'e.g. ayush',
            value: store.get(KEYS.analyticsSite),
            oninput: (e) => store.set(KEYS.analyticsSite, e.target.value.trim()),
          }),
        ),
      ),
      el('p', { class: 'a-hint' },
        'The API key itself is a repo secret (GOATCOUNTER_API_KEY) — it never touches the browser.',
      ),
    ),
  );
}

// ── now page ─────────────────────────────────
function renderNow(viewEl) {
  disposeEditors();
  const updatedInput = el('input', {
    class: 'a-input', id: 'n-updated', placeholder: 'e.g. august 2026',
    value: state.now?.data.updated || '',
    oninput: markDirty,
  });
  const dirtyDot = el('span', { class: 'a-dirtydot', hidden: true }, 'unsaved');
  function markDirty() {
    state.dirty = true;
    dirtyDot.hidden = false;
  }

  const editorHost = el('div', { class: 'a-editor-host' }, el('p', { class: 'a-note' }, 'loading editor…'));
  let editor = null;
  (async () => {
    try {
      const e = await createEditor({
        container: editorHost,
        value: state.now?.body || '',
        onChange: () => { markDirty(); updateStats(); },
        onImage: stageEditorImage,
      });
      if (!editorHost.isConnected) {
        disposeOneEditor(e);
        return;
      }
      editor = e;
    } catch (err) {
      console.error('editor failed to load — using plain textarea', err);
      if (editorHost.isConnected) {
        editor = fallbackEditor(editorHost, state.now?.body || '', () => { markDirty(); updateStats(); });
      }
      return;
    }
    updateStats();
  })();

  function currentMarkdown() {
    if (editor) return editor.getMarkdown();
    const ta = editorHost.querySelector('textarea');
    return ta ? ta.value : '';
  }
  function setEditorMarkdown(v) {
    if (editor) editor.setMarkdown(v, false);
    else {
      const ta = editorHost.querySelector('textarea');
      if (ta) ta.value = v;
    }
  }

  const stats = el('span', { class: 'a-mono' }, '');
  function updateStats() {
    const md = currentMarkdown();
    const w = countWords(md);
    stats.textContent = `${w} words · ${Math.max(1, Math.ceil(w / 220))} min read`;
  }

  const pendingImages = [];
  const chipsEl = el('div', { class: 'a-imgchips', hidden: true });
  function renderChips() {
    chipsEl.replaceChildren(...pendingImages.map((img) =>
      el('span', { class: 'a-imgchip', title: img.path },
        el('span', { class: 'a-imgchip__name' }, img.name),
        el('span', { class: 'a-imgchip__meta' }, fmtSize(img.size)),
        el('button', { class: 'a-mini a-mini--danger', type: 'button', onclick: () => removeImage(img) }, '✕'),
      ),
    ));
    chipsEl.hidden = pendingImages.length === 0;
  }
  function removeImage(img) {
    const idx = pendingImages.indexOf(img);
    if (idx === -1) return;
    pendingImages.splice(idx, 1);
    const md = currentMarkdown();
    const at = md.lastIndexOf(img.md);
    if (at !== -1) setEditorMarkdown(md.slice(0, at) + md.slice(at + img.md.length));
    renderChips();
    markDirty();
  }
  async function stageEditorImage(file) {
    if (actionBusy) {
      toast('wait for the current save to finish first', 'info');
      return null;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast(`${file.name} is over 8 MB — skipped`, 'error');
      return null;
    }
    const b64 = await fileToBase64(file);
    const { filename, path } = imagePathFor(file);
    const url = `${BASE}images/${filename}`;
    const alt = baseName(file.name);
    pendingImages.push({ path, content: b64, encoding: 'base64', name: file.name, size: file.size, md: `![${alt}](${url})` });
    renderChips();
    markDirty();
    return { url, alt };
  }

  const saveBtn = el('button', { class: 'a-btn a-btn--primary', onclick: save }, 'save changes');
  const githubLink = `https://github.com/${state.gh.owner}/${state.gh.repo}/blob/${state.gh.branch}/src/content/now/now.md`;

  async function save() {
    if (actionBusy) return;
    if (!editor) {
      toast('editor still loading — wait a second', 'info');
      return;
    }
    actionBusy = true;
    saveBtn.disabled = true;
    setBusy(true);
    try {
      const content = buildNowMarkdown({ updated: updatedInput.value.trim(), body: currentMarkdown() });
      const staged = pendingImages.slice(); // snapshot before the await
      const files = [{ path: 'src/content/now/now.md', content }];
      for (const img of staged) files.push({ path: img.path, content: img.content, encoding: 'base64' });
      await state.gh.commitFiles(files, '📌 update now page');
      const { data, body: b } = parseFrontmatter(content);
      state.now = { path: 'src/content/now/now.md', data, body: b };
      state.dirty = false;
      dirtyDot.hidden = true;
      for (const img of staged) {
        const i = pendingImages.indexOf(img);
        if (i !== -1) pendingImages.splice(i, 1);
      }
      renderChips();
      state.tree = null;
      toast('now page updated — deploy running', 'success');
    } catch (e) {
      toast(e.message || 'save failed', 'error');
    } finally {
      actionBusy = false;
      saveBtn.disabled = false;
      setBusy(false);
    }
  }

  async function createNowFile() {
    if (actionBusy) return;
    actionBusy = true;
    setBusy(true);
    try {
      const content = buildNowMarkdown({
        updated: 'fresh start',
        body: "A running list of what I'm currently up to.\n\n## building\n\n- something small\n\n## reading\n\n- something good",
      });
      await state.gh.commitFiles([{ path: 'src/content/now/now.md', content }], '📌 create now page');
      const { data, body: b } = parseFrontmatter(content);
      state.now = { path: 'src/content/now/now.md', data, body: b };
      state.tree = null;
      toast('now page created — deploy running', 'success');
      renderRoute();
    } catch (e) {
      toast(e.message || 'create failed', 'error');
    } finally {
      actionBusy = false;
      setBusy(false);
    }
  }

  if (!state.now) {
    viewEl.replaceChildren(
      pageHead('now page', 'the /now content file', []),
      el('div', { class: 'a-card' },
        el('div', { class: 'a-card__head' }, el('h2', {}, 'not created yet')),
        el('p', { class: 'a-note' }, 'The now page file does not exist in the repo yet.'),
        el('button', { class: 'a-btn a-btn--primary', onclick: createNowFile }, 'create now.md'),
      ),
    );
    return;
  }

  viewEl.replaceChildren(
    pageHead('now page', 'the classic /now page', [
      el('a', { class: 'a-out', href: `${BASE}now`, target: '_blank', rel: 'noopener' }, 'view page ↗'),
      saveBtn,
    ]),
    el('div', { class: 'a-card' },
      el('div', { class: 'a-card__head' },
        el('h2', {}, 'now content'),
        dirtyDot,
      ),
      el('div', { class: 'a-meta-grid' },
        el('label', { class: 'a-label' }, 'last updated', updatedInput),
      ),
      el('div', { class: 'a-toolbar' },
        el('div', {}, stats),
        el('div', { class: 'a-toolbar__right' },
          el('span', {}, 'images: upload, drag & drop, or paste'),
        ),
      ),
      chipsEl,
      editorHost,
      el('p', { class: 'a-hint' }, 'file: ',
        el('a', { class: 'a-out a-mono', href: githubLink, target: '_blank', rel: 'noopener' }, 'src/content/now/now.md ↗'),
      ),
    ),
  );

  updateStats();
}

// ── theme toggle ─────────────────────────────
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('theme', next);
  } catch {}
  syncThemeBtn();
}

function syncThemeBtn() {
  const btn = $('#a-theme');
  if (btn) btn.textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '🌙';
}

// ── lock / bootstrap ─────────────────────────
function showLock() {
  lockVisible(true);
  $('#a-password').value = '';
  $('#a-token').value = store.get(KEYS.token);
  $('#a-owner').value = store.get(KEYS.owner) || defaultOwner();
  $('#a-repo').value = store.get(KEYS.repo) || defaultRepo();
  const btn = $('#a-connect');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'sign in';
  }
}

function defaultOwner() {
  try {
    const host = new URL(SITE.url).hostname.split('.')[0];
    return host && host !== 'localhost' ? host : '';
  } catch {
    return '';
  }
}

function defaultRepo() {
  return BASE.replace(/\//g, '') || '';
}

function forceLock() {
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
  state.gh = null;
  state.posts = [];
  state.settings = null;
  state.now = null;
  state.tree = null;
  state.dirty = false;
  state.scopeWarn = null;
  store.clear();
  closeSession();
  location.hash = '#/dashboard';
  lockVisible(true);
  $('#a-token').value = '';
  $('#a-password').value = '';
  $('#a-view').replaceChildren();
}

function lockUp() {
  if (!window.confirm('Lock the admin and forget the token?')) return;
  forceLock();
}

// ── auto-lock (security) ─────────────────────
const AUTO_LOCK_MIN = 30;
function autoLockEnabled() {
  return store.get(KEYS.autoLock) !== '0';
}
function armAutoLock() {
  if (!autoLockEnabled()) return;
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = setTimeout(autoLockNow, AUTO_LOCK_MIN * 60 * 1000);
}
function autoLockNow() {
  lockTimer = null;
  if (!state.gh || !autoLockEnabled()) return;
  toast('auto-locked after inactivity — token cleared', 'info');
  forceLock();
}

// ── boot ─────────────────────────────────────
export function mount() {
  if (document.body.dataset.adminMounted) return;
  document.body.dataset.adminMounted = '1';
  document.body.classList.add('a-body');

  $('#a-connect').addEventListener('click', () => connect(false));
  $('#a-lock-btn').addEventListener('click', lockUp);
  $('#a-theme').addEventListener('click', toggleTheme);
  syncThemeBtn();

  $('#a-token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connect(false);
  });
  $('#a-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connect(false);
  });

  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty) return;
    e.preventDefault(); // enough to trigger the browser's leave-confirmation
  });

  // safety net: guarantee hash navigation even if another handler swallows
  // anchor clicks (e.g. a view-transitions router). Setting the hash here is
  // idempotent — the native default click and our hashchange router both
  // agree, and no-op when the hash is unchanged.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const t = e.target;
    const a = t && t.closest ? t.closest('a[href^="#/"]') : null;
    if (!a) return;
    const h = a.getAttribute('href');
    if (h && h !== location.hash) location.hash = h;
  });

  // surface failures instead of failing silently — a toast beats a dead view
  window.addEventListener('error', (e) => {
    console.error('admin error:', e.error || e.message);
    toast(`error: ${e.message || 'unknown'}`, 'error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('admin unhandled rejection:', e.reason);
    toast(`error: ${e.reason?.message || 'unknown error'}`, 'error');
  });

  // activity keeps the auto-lock timer topped up
  ['pointerdown', 'keydown', 'scroll'].forEach((ev) =>
    document.addEventListener(ev, () => {
      if (state.gh) armAutoLock();
    }, { passive: true }),
  );

  // keep ToastUI editors in sync with the light/dark theme
  new MutationObserver(() => editors.forEach(syncEditorTheme)).observe(
    document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] },
  );

  // auto-connect only if the password session is open AND a token is stored —
  // a stored token alone is not enough (the session dies with the tab)
  const token = store.get(KEYS.token);
  if (token && isSessionOpen()) {
    $('#a-token').value = token;
    $('#a-owner').value = store.get(KEYS.owner) || defaultOwner();
    $('#a-repo').value = store.get(KEYS.repo) || defaultRepo();
    connect(true);
  } else {
    showLock();
  }
}
