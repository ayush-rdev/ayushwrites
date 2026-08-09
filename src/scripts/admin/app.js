// ─────────────────────────────────────────────
//  my corner — admin app.
//  A tiny hash-routed SPA that manages the blog
//  straight from the browser via the GitHub API:
//  create/edit/delete posts, site settings and
//  the now page. Every save is a commit to the
//  repo, and the existing GitHub Actions workflow
//  deploys it.
// ─────────────────────────────────────────────

import { GitHub } from './github.js';
import { setupRichEditor, insertText, fileToBase64, baseName, MAX_IMAGE_BYTES } from './editor-tools.js';
import {
  parseFrontmatter,
  buildPostMarkdown,
  buildNowMarkdown,
  slugify,
  countWords,
  readConsts,
  writeConsts,
} from './content.js';
import { marked } from 'marked';
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
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2), v);
    } else if (v === true) node.setAttribute(k, '');
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
};
const store = {
  get(k) {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  clear() {
    try {
      Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
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
  dirty: false,
  lastHash: '#/dashboard',
  scopeWarn: null, // over-broad classic scopes on the connected token
};

// scopes a token does NOT need for this admin — its presence means the token
// has far more power than a blog editor should
const BROAD_SCOPES = [
  'admin:enterprise', 'admin:gpg_key', 'admin:org', 'admin:org_hook',
  'admin:public_key', 'admin:repo_hook', 'admin:ssh_signing_key',
  'audit_log', 'codespace', 'copilot', 'delete_repo', 'delete:packages',
  'gist', 'notifications', 'project', 'workflow', 'write:discussion',
  'write:network_configurations', 'write:packages',
];

// true while a commit is in flight — blocks double-submits
let actionBusy = false;

// ── fullscreen editor ────────────────────────
let fsCard = null;
function exitFullscreen() {
  if (fsCard) {
    fsCard.classList.remove('a-fs');
    fsCard = null;
  }
  document.body.classList.remove('a-fs-active');
}
function toggleFullscreen(card) {
  if (fsCard && fsCard !== card) return;
  fsCard = fsCard ? null : card;
  document.body.classList.toggle('a-fs-active', !!fsCard);
  card.classList.toggle('a-fs', !!fsCard);
  if (fsCard) fsCard.scrollTop = 0;
}

const ui = {
  postsFilter: 'all',
  postsQuery: '',
  mode: 'write',
  newSlugTouched: false,
  tab: 'dashboard',
};

// ── toasts ───────────────────────────────────
function toast(msg, kind = 'info') {
  const box = $('#a-toasts');
  if (!box) return;
  const t = el('div', { class: `a-toast a-toast--${kind}` }, msg);
  box.append(t);
  setTimeout(() => {
    t.classList.add('a-toast--out');
    setTimeout(() => t.remove(), 380);
  }, 3800);
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

function renderMd(md) {
  try {
    // own content, but harden the preview anyway: drop scripts, iframes,
    // event-handler attributes and javascript: URLs
    return marked
      .parse(md || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(href|src)\s*=\s*(['"])javascript:/gi, '$1=$2about:');
  } catch {
    return '<p><em>could not render preview</em></p>';
  }
}

// ── connect / auth ───────────────────────────
function lockVisible(on) {
  $('#a-lock').hidden = !on;
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

    // warn if a classic token arrives with way more power than this needs
    const scopes = (gh.lastScopes || '').split(',').map((s) => s.trim()).filter(Boolean);
    state.scopeWarn = scopes.filter((s) => BROAD_SCOPES.includes(s));
    if (state.scopeWarn.length === 0) state.scopeWarn = null;
    if (state.scopeWarn) {
      toast('⚠️ This token has very broad scopes — consider a fine-grained token', 'error');
    }

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

    // one unreadable post shouldn't take the whole admin down
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
  if (on && !bar) view.prepend(el('p', { class: 'a-busy' }, 'reading the repo…'));
  else if (!on && bar) bar.remove();
}

// ── routing ──────────────────────────────────
function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, ...rest] = h.split('/');
  return { view: view || 'dashboard', arg: decodeURIComponent(rest.join('/')) };
}

let guardRevert = false;
function onHashChange() {
  if (guardRevert) {
    // this is the hash change from restoring the editor after a cancelled
    // leave — the DOM still holds the editor with its unsaved values, so
    // don't re-render (that would wipe them)
    guardRevert = false;
    return;
  }
  const prevHash = state.lastHash || '#/dashboard';
  state.lastHash = location.hash;
  if (state.dirty) {
    const ok = window.confirm('You have unsaved changes. Discard them?');
    if (!ok) {
      // restore the editor's URL without rebuilding its DOM
      if (prevHash !== location.hash) {
        guardRevert = true;
        location.hash = prevHash;
      }
      return;
    }
    state.dirty = false;
  }
  renderRoute();
}

function renderRoute() {
  const viewEl = $('#a-view');
  if (!state.gh || !viewEl) return;
  const { view, arg } = currentRoute();
  ui.tab = view === 'edit' || view === 'new' ? 'posts' : view;
  syncTabs();

  if (view === 'posts') renderPosts(viewEl);
  else if (view === 'new') renderEditor(viewEl, null);
  else if (view === 'edit') renderEditor(viewEl, arg);
  else if (view === 'settings') renderSettings(viewEl);
  else if (view === 'now') renderNow(viewEl);
  else renderDashboard(viewEl);
}

function syncTabs() {
  document.querySelectorAll('.a-tab').forEach((a) => {
    const active = a.dataset.view === ui.tab;
    a.classList.toggle('a-tab--active', active);
  });
}

// ── dashboard ────────────────────────────────
function renderDashboard(viewEl) {
  const posts = state.posts;
  const published = posts.filter((p) => !p.data.draft);
  const drafts = posts.filter((p) => p.data.draft);
  const words = posts.reduce((n, p) => n + countWords(p.body), 0);
  const latest = posts[0]?.data.pubDate;

  const stat = (label, n, sub) =>
    el(
      'div',
      { class: 'a-stat' },
      el('span', { class: 'a-stat__num' }, String(n)),
      el('span', { class: 'a-stat__label' }, label),
      sub ? el('span', { class: 'a-stat__sub' }, sub) : null,
    );

  const recent = posts.slice(0, 3).map((p) =>
    el(
      'a',
      { class: 'a-row a-row--link', href: `#/edit/${encodeURIComponent(p.id)}` },
      el('div', { class: 'a-row__main' },
        el('span', { class: 'a-row__title' }, p.data.title || p.id),
        p.data.draft ? el('span', { class: 'a-badge a-badge--draft' }, 'draft') : null),
      el('div', { class: 'a-row__date' }, pretty(p.data.pubDate)),
    ),
  );

  viewEl.replaceChildren(
    state.scopeWarn
      ? el('div', { class: 'a-warn' },
          el('strong', {}, '⚠️ This token has far more power than the admin needs'),
          el('p', { class: 'a-note' },
            `It carries scopes like ${state.scopeWarn.join(', ')}. If it has ever been pasted into a chat, a config file, or anywhere else, revoke it now at github.com/settings/tokens. The admin only needs a `,
            el('strong', {}, 'fine-grained token'),
            ' with Contents: read & write on this one repo — that also keeps it useless if it ever leaks.',
          ),
        )
      : null,

    el('div', { class: 'a-stats' },
      stat('writings', posts.length, 'in the repo'),
      stat('published', published.length),
      stat('drafts', drafts.length),
      stat('words', words.toLocaleString(), latest ? `latest ${pretty(latest)}` : ''),
    ),

    el('div', { class: 'a-grid-2' },
      el('div', { class: 'a-card' },
        el('h2', { class: 'a-h2' }, 'quick actions'),
        el('div', { class: 'a-btn-row' },
          el('button', { class: 'a-btn a-btn--accent', onclick: () => (location.hash = '#/new') }, '✍ new post'),
          el('button', { class: 'a-btn', onclick: () => (location.hash = '#/settings') }, 'site settings'),
          el('button', { class: 'a-btn', onclick: () => (location.hash = '#/now') }, 'now page'),
        ),
        el('p', { class: 'a-note' },
          'Every save is one commit to ',
          el('strong', {}, `${state.gh.owner}/${state.gh.repo}`),
          ' on ', el('strong', {}, state.gh.branch),
          ' — the GitHub Actions workflow then builds and deploys (usually under a minute).',
        ),
      ),

      el('div', { class: 'a-card' },
        el('div', { class: 'a-card__head' },
          el('h2', { class: 'a-h2' }, 'deploy'),
          el('button', { class: 'a-mini', title: 'refresh', onclick: refreshDeploy }, '↻'),
        ),
        el('div', { class: 'a-deploy-body', id: 'a-deploy' }, el('p', { class: 'a-note' }, '…')),
      ),
    ),

    posts.length > 0
      ? el('div', { class: 'a-card' },
          el('div', { class: 'a-card__head' },
            el('h2', { class: 'a-h2' }, 'recent writings'),
            el('a', { class: 'a-out', href: '#/posts' }, 'all posts →'),
          ),
          ...recent,
        )
      : el('div', { class: 'a-card' },
          el('h2', { class: 'a-h2' }, 'no posts yet'),
          el('p', { class: 'a-note' }, 'Write your first one — the corner is waiting.'),
          el('button', { class: 'a-btn a-btn--accent', onclick: () => (location.hash = '#/new') }, '✍ new post'),
        ),
  );

  refreshDeploy();
}

async function refreshDeploy() {
  const box = $('#a-deploy');
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
    const icon = done ? (ok ? '✓' : '✗') : '…';
    const cls = done ? (ok ? 'a-status--ok' : 'a-status--bad') : 'a-status--run';
    const line = done ? run.conclusion : run.status;
    box.replaceChildren(
      el('div', { class: 'a-status-row' },
        el('span', { class: `a-status ${cls}` }, icon),
        el('div', {},
          el('div', {}, el('strong', {}, line), done ? '' : ' — building & deploying'),
          el('div', { class: 'a-note' }, `${relTime(run.created_at)} · `,
            el('a', { class: 'a-out', href: run.html_url, target: '_blank', rel: 'noopener' }, 'view run ↗')),
        ),
      ),
    );
  } catch {
    box.replaceChildren(el('p', { class: 'a-note' }, 'could not fetch deploy status (Actions may be off).'));
  }
}

// ── posts list ───────────────────────────────
function renderPosts(viewEl) {
  const chipWrap = el('div', { class: 'a-chip-row' });
  const listWrap = el('div');

  // re-renders ONLY the list, so the search input keeps focus while typing
  function renderPostList() {
    let posts = state.posts;
    if (ui.postsFilter === 'published') posts = posts.filter((p) => !p.data.draft);
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
        ),
        el('div', { class: 'a-row__date' }, pretty(p.data.pubDate)),
        el('div', { class: 'a-row__actions' },
          el('button', { class: 'a-mini', title: 'duplicate', onclick: () => duplicatePost(p) }, '⧉'),
          el('button', {
            class: 'a-mini',
            title: p.data.draft ? 'publish' : 'move to drafts',
            onclick: () => toggleDraft(p),
          }, p.data.draft ? '🚀' : '🙈'),
          el('button', { class: 'a-mini a-mini--danger', title: 'delete', onclick: () => deletePost(p) }, '✕'),
        ),
      ),
    );

    listWrap.replaceChildren(
      posts.length === 0
        ? el('div', { class: 'a-card' },
            el('p', { class: 'a-note' }, q ? 'nothing matches your search.' : 'nothing here yet — write something.'),
          )
        : el('div', { class: 'a-list' }, ...rows),
    );
  }

  // re-renders just the filter chips (keeps their active state honest)
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
    chipWrap.replaceChildren(chip('all', 'all'), chip('published', 'published'), chip('drafts', 'drafts'));
  }

  viewEl.replaceChildren(
    el('div', { class: 'a-pagehead' },
      el('h2', { class: 'a-h2' }, 'posts'),
      el('span', { class: 'a-count' }, `${state.posts.length} total`),
      el('button', { class: 'a-btn a-btn--accent a-pagehead__new', onclick: () => (location.hash = '#/new') }, '✍ new post'),
    ),

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
  state.clone = {
    data: { ...p.data, title: p.data.title, draft: true },
    body: p.body,
    slug: `${slugify(p.id)}-copy`,
  };
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
  const existing = id ? state.posts.find((p) => p.id === id) : null;
  if (id && !existing) {
    toast('post not found', 'error');
    location.hash = '#/posts';
    return;
  }
  const src = existing || state.clone || { data: {} };
  if (!existing) state.clone = null; // the clone is consumed by this editor
  state.dirty = false;
  ui.mode = 'write';
  ui.newSlugTouched = false;
  const wasFs = !!fsCard;
  if (wasFs) exitFullscreen();

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

  const pubDate = el('input', { class: 'a-input', type: 'date', id: 'f-pubdate', value: src.data.pubDate || '' });
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
  const bodyTextarea = el('textarea', {
    class: 'a-body-input', id: 'f-body', placeholder: 'write in markdown…',
    spellcheck: 'true',
    oninput: () => {
      markDirty();
      updateStats();
      schedulePreview();
    },
  }, src.body || '');

  function updateStats() {
    const w = countWords(bodyTextarea.value);
    const mins = Math.max(1, Math.ceil(w / 220));
    const s = $('#f-stats');
    if (s) s.textContent = `${w} words · ${bodyTextarea.value.length} chars · ${mins} min read`;
  }

  const pathHint = el('p', { class: 'a-path' }, 'src/content/blog/', el('span', { id: 'f-path-slug', class: 'a-mono' }, ''), '.md');
  function updatePathHint() {
    const s = $('#f-path-slug');
    if (s) s.textContent = slugify($('#f-slug').value || slugify(titleInput.value) || 'post');
  }

  const stats = el('span', { id: 'f-stats', class: 'a-mono' }, `${countWords(bodyTextarea.value)} words`);
  const dirtyDot = el('span', { class: 'a-dirtydot', hidden: true }, 'unsaved');

  // ── images staged with this post (committed together on save) ──
  const pendingImages = [];
  const chipsEl = el('div', { class: 'a-imgchips', hidden: true });
  const rtoolbarEl = el('div', { class: 'a-rtoolbar' });

  function renderChips() {
    chipsEl.replaceChildren(...pendingImages.map((img) =>
      el('span', { class: 'a-imgchip', title: img.path },
        el('span', { class: 'a-imgchip__name' }, img.name),
        el('span', { class: 'a-imgchip__meta' }, `${Math.max(1, Math.round(img.size / 1024))} KB`),
        el('button', {
          class: 'a-mini a-mini--danger', type: 'button',
          title: 'remove from this post', onclick: () => removeImage(img),
        }, '✕'),
      ),
    ));
    chipsEl.hidden = pendingImages.length === 0;
  }

  function removeImage(img) {
    const idx = pendingImages.indexOf(img);
    if (idx === -1) return;
    pendingImages.splice(idx, 1);
    // prefer the recorded insertion point (handles the same image twice),
    // falling back to a search if the text moved around
    let at =
      img.at != null && bodyTextarea.value.slice(img.at, img.at + img.md.length) === img.md
        ? img.at
        : bodyTextarea.value.indexOf(img.md);
    if (at !== -1) {
      bodyTextarea.value = bodyTextarea.value.slice(0, at) + bodyTextarea.value.slice(at + img.md.length);
    }
    renderChips();
    updateStats();
    if (ui.mode !== 'write') renderPreview();
    markDirty();
  }

  async function stageFiles(files) {
    if (actionBusy) {
      toast('wait for the current save to finish first', 'info');
      return;
    }
    const imgs = [...files].filter((f) => f.type.startsWith('image/'));
    if (imgs.length === 0) return;
    for (const f of imgs) {
      if (f.size > MAX_IMAGE_BYTES) {
        toast(`${f.name} is over 8 MB — skipped`, 'error');
        continue;
      }
      try {
        const b64 = await fileToBase64(f);
        const ext = (f.name.split('.').pop() || 'png').toLowerCase();
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const filename = `${stamp}-${Date.now().toString(36)}-${baseName(f.name)}.${ext}`;
        const path = `public/images/${filename}`;
        const md = `![${baseName(f.name)}](${BASE}images/${filename})`;
        const img = { path, content: b64, encoding: 'base64', name: f.name, size: f.size, md };
        insertText(bodyTextarea, md);
        img.at = Math.max(0, bodyTextarea.selectionStart - md.length);
        pendingImages.push(img);
      } catch (err) {
        toast(err.message || `could not read ${f.name}`, 'error');
      }
    }
    renderChips();
    updateStats();
    if (ui.mode !== 'write') renderPreview();
    markDirty();
  }

  const preview = el('div', { class: 'a-preview prose', hidden: true });

  function schedulePreview() {
    clearTimeout(schedulePreview._t);
    schedulePreview._t = setTimeout(renderPreview, 200);
  }
  function renderPreview() {
    const t = el('div', { class: 'a-preview__meta' },
      el('strong', {}, titleInput.value || 'untitled'),
      el('span', {}, `${pretty(pubDate.value)}${updatedDate.value ? ` · updated ${pretty(updatedDate.value)}` : ''}`),
      tagsInput.value.split(',').map((s) => s.trim()).filter(Boolean)
        .map((t) => el('span', { class: 'a-tag' }, `#${t}`)),
      draftBox.checked ? el('span', { class: 'a-badge a-badge--draft' }, 'draft') : null,
    );
    preview.replaceChildren(t, el('div', { class: 'a-preview__body', html: renderMd(bodyTextarea.value) }));
  }

  function applyMode() {
    bodyTextarea.hidden = ui.mode === 'preview';
    preview.hidden = ui.mode === 'write';
    const grid = $('.a-body');
    grid.classList.toggle('a-body--split', ui.mode === 'split');
    if (ui.mode !== 'write') renderPreview();
    if (ui.mode === 'write') bodyTextarea.focus();
  }

  const modeBtn = (label, m) =>
    el('button', {
      class: `a-mini a-mini--mode${ui.mode === m ? ' a-mini--active' : ''}`,
      onclick: () => {
        ui.mode = m;
        [...viewEl.querySelectorAll('.a-mini--mode')].forEach((b) => b.classList.toggle('a-mini--active', b.textContent === label));
        applyMode();
      },
    }, label);

  function markDirty() {
    if (state.dirty) return;
    state.dirty = true;
    dirtyDot.hidden = false;
  }

  const saveBtn = el('button', { class: 'a-btn a-btn--accent', onclick: save }, 'save & publish');

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
    if (!existing && state.posts.some((p) => p.id === slug)) {
      if (!window.confirm(`"${slug}" already exists — overwrite that post?`)) return;
    }
    const date = pubDate.value || new Date().toISOString().slice(0, 10);
    const tags = tagsInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    const content = buildPostMarkdown({
      title,
      description: descInput.value.trim(),
      pubDate: date,
      updatedDate: updatedDate.value || undefined,
      tags,
      draft: draftBox.checked,
      body: bodyTextarea.value,
    });
    const newPath = `src/content/blog/${slug}.md`;
    const files = [];
    if (existing && existing.path !== newPath) files.push({ path: existing.path, delete: true });
    files.push({ path: newPath, content });
    for (const img of pendingImages) files.push({ path: img.path, content: img.content, encoding: 'base64' });

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
      pendingImages.length = 0;
      renderChips();
      toast(existing ? 'post updated — deploy running' : 'post published — deploy running', 'success');
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

  async function copyMd() {
    try {
      await navigator.clipboard.writeText(fullMarkdown());
      toast('markdown copied to clipboard', 'info');
    } catch {
      toast('could not copy', 'error');
    }
  }
  function fullMarkdown() {
    return buildPostMarkdown({
      title: titleInput.value.trim(),
      description: descInput.value.trim(),
      pubDate: pubDate.value,
      updatedDate: updatedDate.value || undefined,
      tags: tagsInput.value.split(',').map((s) => s.trim()).filter(Boolean),
      draft: draftBox.checked,
      body: bodyTextarea.value,
    });
  }
  function downloadMd() {
    const blob = new Blob([fullMarkdown()], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slugify(slugInput.value || titleInput.value) || 'post'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const editorCard = el('div', { class: 'a-editor' },
    el('div', { class: 'a-editor__head' },
      el('a', { class: 'a-back', href: '#/posts' }, '← all posts'),
      el('div', { class: 'a-editor__head-actions' },
        existing
          ? el('button', { class: 'a-btn a-btn--ghost-danger', onclick: () => deletePost(existing) }, 'delete')
          : null,
        saveBtn,
      ),
    ),

    titleInput,

    el('div', { class: 'a-meta-grid' },
      el('label', { class: 'a-field' }, 'published', pubDate),
      el('label', { class: 'a-field' }, 'updated', updatedDate),
      el('label', { class: 'a-field' }, 'slug', slugInput),
      el('label', { class: 'a-field a-field--check' }, draftBox, 'draft (hidden from listings)'),
    ),

    el('label', { class: 'a-field' }, 'description', descInput),
    el('label', { class: 'a-field' }, 'tags', tagsInput),

    rtoolbarEl,
    chipsEl,

    el('div', { class: 'a-toolbar' },
      el('div', { class: 'a-mode-row' }, modeBtn('write', 'write'), modeBtn('preview', 'preview'), modeBtn('split', 'split')),
      el('div', { class: 'a-toolbar__right' },
        stats,
        el('button', { class: 'a-mini', onclick: copyMd }, 'copy md'),
        el('button', { class: 'a-mini', onclick: downloadMd }, 'download'),
      ),
    ),

    el('div', { class: 'a-body' }, bodyTextarea, preview),

    el('div', { class: 'a-editor__foot' },
      pathHint,
      el('span', { class: 'a-foot-hint' }, 'drag & drop images · paste screenshots'),
      dirtyDot,
    ),
  );

  viewEl.replaceChildren(editorCard);

  setupRichEditor({
    textarea: bodyTextarea,
    toolbarEl: rtoolbarEl,
    onFiles: stageFiles,
    onSave: save,
    onFullscreen: () => toggleFullscreen(editorCard),
  });

  if (wasFs) toggleFullscreen(editorCard);
  updatePathHint();
  applyMode();
  updateStats();
  bodyTextarea.focus();
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

  const githubLink = `https://github.com/${state.gh.owner}/${state.gh.repo}/blob/${state.gh.branch}/src/consts.ts`;

  const saveBtn = el('button', { class: 'a-btn a-btn--accent', onclick: save }, 'save changes');

  async function save() {
    if (actionBusy) return;
    const values = {
      title: title.value.trim(),
      author: author.value.trim(),
      description: desc.value.trim(),
    };
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
    el('div', { class: 'a-card' },
      el('div', { class: 'a-card__head' },
        el('h2', { class: 'a-h2' }, 'site settings'),
        dirtyDot,
      ),
      el('p', { class: 'a-note' },
        'These map to the SITE object in src/consts.ts — used in the header, footer, meta tags and the RSS feed.',
      ),
      el('label', { class: 'a-field' }, 'title', title),
      el('label', { class: 'a-field' }, 'author', author),
      el('label', { class: 'a-field' }, 'description', desc),
      el('div', { class: 'a-btn-row' }, saveBtn),
      el('p', { class: 'a-path' }, 'file: ',
        el('a', { class: 'a-out a-mono', href: githubLink, target: '_blank', rel: 'noopener' }, 'src/consts.ts ↗'),
      ),
    ),
  );
}

// ── now page ─────────────────────────────────
function renderNow(viewEl) {
  const updatedInput = el('input', {
    class: 'a-input', id: 'n-updated', placeholder: 'e.g. august 2026',
    value: state.now?.data.updated || '',
    oninput: markDirty,
  });
  const body = el('textarea', {
    class: 'a-textarea a-body-input', id: 'n-body', rows: 14,
    placeholder: 'markdown for the now page…',
    oninput: () => {
      markDirty();
      updateStats();
      schedulePreview();
    },
  }, state.now?.body || '');

  function updateStats() {
    const w = countWords(body.value);
    const mins = Math.max(1, Math.ceil(w / 220));
    const s = $('#n-stats');
    if (s) s.textContent = `${w} words · ${body.value.length} chars · ${mins} min read`;
  }

  const stats = el('span', { id: 'n-stats', class: 'a-mono' }, `${countWords(body.value)} words`);
  const preview = el('div', { class: 'a-preview prose', hidden: true });
  function schedulePreview() {
    clearTimeout(schedulePreview._t);
    schedulePreview._t = setTimeout(renderPreview, 200);
  }
  function renderPreview() {
    preview.replaceChildren(el('div', { class: 'a-preview__body', html: renderMd(body.value) }));
  }
  const dirtyDot = el('span', { class: 'a-dirtydot', hidden: true }, 'unsaved');
  function markDirty() {
    state.dirty = true;
    dirtyDot.hidden = false;
  }

  // ── images staged with the now page ──
  const pendingImages = [];
  const chipsEl = el('div', { class: 'a-imgchips', hidden: true });
  const rtoolbarEl = el('div', { class: 'a-rtoolbar' });

  function renderChips() {
    chipsEl.replaceChildren(...pendingImages.map((img) =>
      el('span', { class: 'a-imgchip', title: img.path },
        el('span', { class: 'a-imgchip__name' }, img.name),
        el('span', { class: 'a-imgchip__meta' }, `${Math.max(1, Math.round(img.size / 1024))} KB`),
        el('button', {
          class: 'a-mini a-mini--danger', type: 'button',
          title: 'remove from this page', onclick: () => removeImage(img),
        }, '✕'),
      ),
    ));
    chipsEl.hidden = pendingImages.length === 0;
  }

  function removeImage(img) {
    const idx = pendingImages.indexOf(img);
    if (idx === -1) return;
    pendingImages.splice(idx, 1);
    let at =
      img.at != null && body.value.slice(img.at, img.at + img.md.length) === img.md
        ? img.at
        : body.value.indexOf(img.md);
    if (at !== -1) body.value = body.value.slice(0, at) + body.value.slice(at + img.md.length);
    renderChips();
    updateStats();
    if (!preview.hidden) renderPreview();
    markDirty();
  }

  async function stageFiles(files) {
    if (actionBusy) {
      toast('wait for the current save to finish first', 'info');
      return;
    }
    const imgs = [...files].filter((f) => f.type.startsWith('image/'));
    if (imgs.length === 0) return;
    for (const f of imgs) {
      if (f.size > MAX_IMAGE_BYTES) {
        toast(`${f.name} is over 8 MB — skipped`, 'error');
        continue;
      }
      try {
        const b64 = await fileToBase64(f);
        const ext = (f.name.split('.').pop() || 'png').toLowerCase();
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const filename = `${stamp}-${Date.now().toString(36)}-${baseName(f.name)}.${ext}`;
        const path = `public/images/${filename}`;
        const md = `![${baseName(f.name)}](${BASE}images/${filename})`;
        const img = { path, content: b64, encoding: 'base64', name: f.name, size: f.size, md };
        insertText(body, md);
        img.at = Math.max(0, body.selectionStart - md.length);
        pendingImages.push(img);
      } catch (err) {
        toast(err.message || `could not read ${f.name}`, 'error');
      }
    }
    renderChips();
    updateStats();
    if (!preview.hidden) renderPreview();
    markDirty();
  }

  const githubLink = `https://github.com/${state.gh.owner}/${state.gh.repo}/blob/${state.gh.branch}/src/content/now/now.md`;

  const saveBtn = el('button', { class: 'a-btn a-btn--accent', onclick: save }, 'save changes');

  async function save() {
    if (actionBusy) return;
    actionBusy = true;
    saveBtn.disabled = true;
    setBusy(true);
    try {
      const content = buildNowMarkdown({ updated: updatedInput.value.trim(), body: body.value });
      const files = [{ path: 'src/content/now/now.md', content }];
      for (const img of pendingImages) files.push({ path: img.path, content: img.content, encoding: 'base64' });
      await state.gh.commitFiles(files, '📌 update now page');
      const { data, body: b } = parseFrontmatter(content);
      state.now = { path: 'src/content/now/now.md', data, body: b };
      state.dirty = false;
      dirtyDot.hidden = true;
      pendingImages.length = 0;
      renderChips();
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
        body: 'A running list of what I\'m currently up to.\n\n## building\n\n- something small\n\n## reading\n\n- something good',
      });
      await state.gh.commitFiles([{ path: 'src/content/now/now.md', content }], '📌 create now page');
      const { data, body: b } = parseFrontmatter(content);
      state.now = { path: 'src/content/now/now.md', data, body: b };
      toast('now page created — deploy running', 'success');
      renderRoute();
    } catch (e) {
      toast(e.message || 'create failed', 'error');
    } finally {
      actionBusy = false;
      setBusy(false);
    }
  }

  const toggle = el('button', {
    class: 'a-mini',
    onclick: () => {
      preview.hidden = !preview.hidden;
      toggle.textContent = preview.hidden ? 'show preview' : 'hide preview';
      if (!preview.hidden) renderPreview();
    },
  }, 'show preview');

  const wasFs = !!fsCard;
  if (wasFs) exitFullscreen();

  const card = el('div', { class: 'a-card' },
    el('div', { class: 'a-card__head' },
      el('h2', { class: 'a-h2' }, 'now page'),
      dirtyDot,
    ),
    state.now
      ? [
          el('p', { class: 'a-note' }, 'The /now page — a running list of what you\'re up to.'),
          el('label', { class: 'a-field' }, 'last updated', updatedInput),
          rtoolbarEl,
          chipsEl,
          el('div', { class: 'a-toolbar' },
            el('div', { class: 'a-toolbar__right' }, stats, toggle),
          ),
          el('div', { class: 'a-body' }, body, preview),
          el('div', { class: 'a-btn-row' }, saveBtn),
          el('p', { class: 'a-path' }, 'file: ',
            el('a', { class: 'a-out a-mono', href: githubLink, target: '_blank', rel: 'noopener' }, 'src/content/now/now.md ↗'),
          ),
        ]
      : [
          el('p', { class: 'a-note' }, 'The now page file does not exist in the repo yet.'),
          el('button', { class: 'a-btn a-btn--accent', onclick: createNowFile }, 'create now.md'),
        ],
  );

  viewEl.replaceChildren(card);

  if (state.now) {
    setupRichEditor({
      textarea: body,
      toolbarEl: rtoolbarEl,
      onFiles: stageFiles,
      onSave: save,
      onFullscreen: () => toggleFullscreen(card),
    });
    if (wasFs) toggleFullscreen(card);
    updateStats();
  }
}

// ── lock / bootstrap ─────────────────────────
function showLock(msg) {
  lockVisible(true);
  $('#a-token').value = store.get(KEYS.token);
  const owner = store.get(KEYS.owner) || defaultOwner();
  const repo = store.get(KEYS.repo) || defaultRepo();
  $('#a-owner').value = owner;
  $('#a-repo').value = repo;
  const btn = $('#a-connect');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'connect';
  }
  if (msg) toast(msg, 'error');
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

  $('#a-connect').addEventListener('click', () => connect(false));
  $('#a-lock-btn').addEventListener('click', lockUp);

  $('#a-token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connect(false);
  });

  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fsCard) exitFullscreen();
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) e.preventDefault();
  });

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
