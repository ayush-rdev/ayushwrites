// ─────────────────────────────────────────────
//  my corner — admin app.
//  A hash-routed SPA that manages the whole blog
//  from the browser via the GitHub API: posts,
//  images, files, tags, site settings, the now
//  page, import/export and deploys. Every save
//  is a commit to the repo, and the deploy
//  workflow runs it.
// ─────────────────────────────────────────────

import Editor from '@toast-ui/editor';
import '@toast-ui/editor/dist/toastui-editor.css';
import '@toast-ui/editor/dist/theme/toastui-editor-dark.css';
import { zipSync, strToU8 } from 'fflate';

import { GitHub } from './github.js';
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
const KEYS = { token: 'mc_admin_token', owner: 'mc_admin_owner', repo: 'mc_admin_repo' };
const store = {
  get(k) { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  clear() { try { Object.values(KEYS).forEach((k) => localStorage.removeItem(k)); } catch {} },
};

// ── state ────────────────────────────────────
const state = {
  gh: null,
  posts: [],
  settings: null, // { path, content }
  now: null, // { path, data, body }
  clone: null, // duplicated-post source for the "new" editor
  tree: null, // cached repo file listing
  dirty: false,
  lastHash: '#/dashboard',
  scopeWarn: null,
};

// true while a commit is in flight — blocks double-submits
let actionBusy = false;

const ui = {
  postsFilter: 'all',
  postsQuery: '',
  importItems: [],
};

// live ToastUI editor instances (for theme syncing)
const editors = new Set();
// editors currently attached to the rendered view — destroyed on re-render
let activeEditors = [];

function disposeEditors() {
  for (const e of activeEditors) {
    try {
      e.destroy();
    } catch {}
    editors.delete(e);
  }
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
    if (!location.hash) location.hash = '#/dashboard';
    await loadAll();
  } catch (e) {
    toast(e.message || 'connection failed', 'error');
    lockVisible(true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'connect';
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

  if (view === 'posts') renderPosts(viewEl);
  else if (view === 'new' || view === 'edit') renderEditor(viewEl, view === 'edit' ? arg : null);
  else if (view === 'media') renderMedia(viewEl);
  else if (view === 'files') renderFiles(viewEl);
  else if (view === 'file') renderFile(viewEl, arg);
  else if (view === 'tags') renderTags(viewEl);
  else if (view === 'tools') renderTools(viewEl);
  else if (view === 'deploy') renderDeploy(viewEl);
  else if (view === 'settings') renderSettings(viewEl);
  else if (view === 'now') renderNow(viewEl);
  else renderDashboard(viewEl);
}

function syncNav() {
  document.querySelectorAll('.a-nav').forEach((a) => {
    a.classList.toggle('a-nav--active', a.dataset.view === ui.tab);
  });
}

// ── ToastUI editor helper ────────────────────
function createEditor({ container, value, onChange, onImage }) {
  const editor = new Editor({
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
function pageHead(title, sub, actions = []) {
  return el('div', { class: 'a-topbar' },
    el('div', {},
      el('h1', {}, title),
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
          (p.data.tags || []).slice(0, 3).map((t) => el('span', { class: 'a-tag' }, `#${t}`)),
          p.data.draft ? el('span', { class: 'a-badge a-badge--draft' }, 'draft') : null,
          isFutureDate(p.data.pubDate) ? el('span', { class: 'a-badge a-badge--run' }, 'scheduled') : null,
        ),
        el('div', { class: 'a-row__date' }, pretty(p.data.pubDate)),
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
  const draftBox = el('input', { class: 'a-checkbox', type: 'checkbox', id: 'f-draft', checked: !!src.data.draft });
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

  const editorHost = el('div', { class: 'a-editor-host' });
  const editor = createEditor({
    container: editorHost,
    value: src.body,
    onChange: () => {
      markDirty();
      updateStats();
    },
    onImage: stageEditorImage,
  });

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
    const md = editor.getMarkdown();
    const at = md.lastIndexOf(img.md);
    if (at !== -1) {
      editor.setMarkdown(md.slice(0, at) + md.slice(at + img.md.length), false);
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
    const md = editor.getMarkdown();
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

  const saveBtn = el('button', { class: 'a-btn a-btn--primary', onclick: save }, 'save & publish');

  async function save() {
    if (actionBusy) return;
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
    // future-dated posts are NOT force-drafted: the site hides them at build
    // time until their date, and the daily rebuild publishes them then
    const draft = draftBox.checked;
    const scheduled = !draft && isFutureDate(date);

    const content = buildPostMarkdown({
      title,
      description: descInput.value.trim(),
      pubDate: date,
      updatedDate: updatedDate.value || undefined,
      tags,
      draft,
      body: editor.getMarkdown(),
    });
    const newPath = `src/content/blog/${slug}.md`;
    // snapshot BEFORE the await — images staged while the commit is in flight
    // must not be dropped (and won't be part of this commit either)
    const staged = pendingImages.slice();
    const files = [];
    if (existing && existing.path !== newPath) files.push({ path: existing.path, delete: true });
    files.push({ path: newPath, content });
    for (const img of staged) files.push({ path: img.path, content: img.content, encoding: 'base64' });

    actionBusy = true;
    saveBtn.disabled = true;
    setBusy(true);
    try {
      await state.gh.commitFiles(files, existing ? `✏️ update · ${title}` : `✍️ new post · ${title}`);
      const { data, body } = parseFrontmatter(content);
      const post = { id: slug, path: newPath, data, body };
      const idx = existing ? state.posts.findIndex((p) => p.id === existing.id) : -1;
      if (idx >= 0) state.posts.splice(idx, 1, post);
      else state.posts.push(post);
      state.posts.sort((a, b) => String(b.data.pubDate || '').localeCompare(String(a.data.pubDate || '')));
      state.dirty = false;
      dirtyDot.hidden = true;
      // drop only the images this commit actually uploaded
      for (const img of staged) {
        const i = pendingImages.indexOf(img);
        if (i !== -1) pendingImages.splice(i, 1);
      }
      renderChips();
      state.tree = null;
      toast(
        existing
          ? (scheduled ? 'post saved — scheduled for the publish date' : 'post updated — deploy running')
          : (scheduled ? 'post scheduled — hidden until the publish date' : 'post published — deploy running'),
        'success',
      );
      if (!existing) {
        location.hash = `#/edit/${encodeURIComponent(slug)}`;
      } else {
        renderEditor(viewEl, slug);
      }
    } catch (e) {
      toast(e.message || 'save failed', 'error');
    } finally {
      actionBusy = false;
      saveBtn.disabled = false;
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
      draft: draftBox.checked,
      body: editor.getMarkdown(),
    });
  }

  async function copyMd() {
    if (await copyText(fullMarkdown())) toast('markdown copied', 'info');
    else toast('could not copy', 'error');
  }

  function downloadMd() {
    const blob = new Blob([fullMarkdown()], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slugify(slugInput.value || titleInput.value) || 'post'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  viewEl.replaceChildren(
    el('div', {},
      el('div', { class: 'a-editor__head' },
        el('a', { class: 'a-back', href: '#/posts' }, '← all posts'),
        el('div', { class: 'a-btn-row' },
          existing
            ? el('button', { class: 'a-btn a-btn--danger a-btn--sm', onclick: () => deletePost(existing) }, 'delete')
            : null,
          saveBtn,
        ),
      ),

      titleInput,

      el('div', { class: 'a-meta-grid' },
        el('label', { class: 'a-label' }, 'published', pubDate),
        el('label', { class: 'a-label' }, 'updated', updatedDate),
        el('label', { class: 'a-label' }, 'slug', slugInput),
        el('label', { class: 'a-label a-check', style: 'justify-content:flex-end;' }, draftBox, 'draft (hidden)'),
      ),

      el('div', { class: 'a-meta-grid' },
        el('label', { class: 'a-label' }, 'description', descInput),
        el('label', { class: 'a-label' }, 'tags', tagsInput),
      ),

      scheduleNote,

      el('div', { class: 'a-toolbar' },
        el('div', {}, stats, dirtyDot),
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

  function exportAll() {
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

  const editorHost = el('div', { class: 'a-editor-host' });
  const editor = createEditor({
    container: editorHost,
    value: state.now?.body || '',
    onChange: () => { markDirty(); updateStats(); },
    onImage: stageEditorImage,
  });

  const stats = el('span', { class: 'a-mono' }, '');
  function updateStats() {
    const md = editor.getMarkdown();
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
    const md = editor.getMarkdown();
    const at = md.lastIndexOf(img.md);
    if (at !== -1) editor.setMarkdown(md.slice(0, at) + md.slice(at + img.md.length), false);
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
    actionBusy = true;
    saveBtn.disabled = true;
    setBusy(true);
    try {
      const content = buildNowMarkdown({ updated: updatedInput.value.trim(), body: editor.getMarkdown() });
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
  $('#a-token').value = store.get(KEYS.token);
  $('#a-owner').value = store.get(KEYS.owner) || defaultOwner();
  $('#a-repo').value = store.get(KEYS.repo) || defaultRepo();
  const btn = $('#a-connect');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'connect';
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

function lockUp() {
  if (!window.confirm('Lock the admin and forget the token?')) return;
  state.gh = null;
  state.posts = [];
  state.settings = null;
  state.now = null;
  state.tree = null;
  state.dirty = false;
  state.scopeWarn = null;
  store.clear();
  location.hash = '#/dashboard';
  lockVisible(true);
  $('#a-token').value = '';
  $('#a-view').replaceChildren();
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

  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) e.preventDefault();
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

  // keep ToastUI editors in sync with the light/dark theme
  new MutationObserver(() => editors.forEach(syncEditorTheme)).observe(
    document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] },
  );

  // auto-connect if a token is stored
  const token = store.get(KEYS.token);
  if (token) {
    $('#a-token').value = token;
    $('#a-owner').value = store.get(KEYS.owner) || defaultOwner();
    $('#a-repo').value = store.get(KEYS.repo) || defaultRepo();
    connect(true);
  } else {
    showLock();
  }
}
