// ─────────────────────────────────────────────
//  Rich markdown editor toolkit for the admin.
//  Cursor-aware formatting (bold, italic, links,
//  headings, lists, quotes, code, tables…), the
//  usual keyboard shortcuts, and image helpers
//  (file → base64, paste, drag-and-drop).
// ─────────────────────────────────────────────

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB — plenty for a blog

// ── textarea insert helpers ──────────────────

function execInsert(text) {
  try {
    // deprecated, but the only way to insert text into a textarea with a
    // working undo stack — it's supported in every browser we care about.
    // accessed through `any` to sidestep the deprecation diagnostic.
    return /** @type {any} */ (document).execCommand('insertText', false, text);
  } catch {
    return false;
  }
}

/**
 * Replace the current selection with `text`. If `sub` ([from, to]) is given,
 * select that sub-range of the inserted text. Falls back to manual editing
 * where execCommand is unavailable.
 */
export function insertText(t, text, sub) {
  t.focus();
  const s = t.selectionStart;
  const e = t.selectionEnd;
  const ok = execInsert(text);
  if (!ok) {
    try {
      t.setRangeText(text, s, e, 'end');
    } catch {
      t.value = t.value.slice(0, s) + text + t.value.slice(e);
      t.setSelectionRange(s + text.length, s + text.length);
    }
  }
  if (sub) {
    const end = t.selectionStart;
    const start = end - text.length;
    t.setSelectionRange(start + sub[0], start + sub[1]);
  }
}

/** wrap the selection in before/after; toggles off if already wrapped */
function wrap(t, before, after, placeholder) {
  const s = t.selectionStart;
  const e = t.selectionEnd;
  let inner = t.value.slice(s, e);
  if (inner.length >= before.length + after.length &&
      inner.startsWith(before) && inner.endsWith(after)) {
    inner = inner.slice(before.length, -after.length);
    insertText(t, inner);
    const end = t.selectionStart;
    t.setSelectionRange(end - inner.length, end);
    return;
  }
  if (!inner) inner = placeholder || 'text';
  insertText(t, before + inner + after, [before.length, before.length + inner.length]);
}

/** prefix/un-prefix the lines of the selection ('ul' | 'ol' | 'quote') */
function prefixLines(t, mode) {
  const s = t.selectionStart;
  const e = t.selectionEnd;
  const v = t.value;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', e);
  if (le === -1) le = v.length;
  const block = v.slice(ls, le);
  const lines = block.split('\n');
  const pat =
    mode === 'ol' ? /^\s*\d+\.\s+/ :
    mode === 'ul' ? /^\s*[-*+]\s+/ :
    /^\s*>\s?/;
  const all = lines.length > 0 && lines.every((l) => pat.test(l));
  let out;
  if (all) {
    out = lines.map((l) => l.replace(pat, '')).join('\n');
  } else if (mode === 'ol') {
    out = lines.map((l, i) => `${i + 1}. ${l.replace(/^\s*/, '')}`).join('\n');
  } else {
    const pre = mode === 'quote' ? '> ' : '- ';
    out = lines.map((l) => pre + l).join('\n');
  }
  t.setSelectionRange(ls, le);
  insertText(t, out);
  t.setSelectionRange(ls + out.length, ls + out.length);
}

/** set/change/clear a heading on the current line */
function heading(t, level) {
  const s = t.selectionStart;
  const v = t.value;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', s);
  if (le === -1) le = v.length;
  const line = v.slice(ls, le);
  const hashes = '#'.repeat(level);
  const m = /^(#{1,6})\s*(.*)$/.exec(line);
  let out;
  if (m) out = m[1] === hashes ? m[2] : `${hashes} ${m[2]}`;
  else out = `${hashes} ${line}`;
  t.setSelectionRange(ls, le);
  insertText(t, out);
  t.setSelectionRange(ls + out.length, ls + out.length);
}

function insertLink(t) {
  const s = t.selectionStart;
  const e = t.selectionEnd;
  const sel = t.value.slice(s, e);
  const url = window.prompt('Link URL', 'https://');
  if (url === null) return;
  const text = sel || url;
  insertText(t, `[${text}](${url})`, [1, 1 + text.length]);
}

function insertCodeBlock(t) {
  const s = t.selectionStart;
  const e = t.selectionEnd;
  const sel = t.value.slice(s, e) || 'code here';
  const out = `\n\`\`\`\n${sel}\n\`\`\`\n`;
  insertText(t, out);
}

function insertHR(t) {
  insertText(t, '\n\n---\n\n');
}

function insertTable(t) {
  const out = '\n| column 1 | column 2 |\n| --- | --- |\n| cell | cell |\n';
  // select the first cell ("column 1") so it can be typed over immediately
  insertText(t, out, ['\n| '.length, '\n| '.length + 'column 1'.length]);
}

// ── image helpers ────────────────────────────

/** File → base64 data string (no prefix), promise-wrapped */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = String(r.result || '');
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

/** 'My Photo (2).PNG' → 'my-photo-2' */
export function baseName(name) {
  return String(name).replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

/** wire paste + drag-and-drop of images onto a textarea's container */
export function attachImageDrop({ textarea, onFiles }) {
  const wrap = textarea.parentElement;
  if (!wrap) return;

  // paste: screenshots / copied images land in the post
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      onFiles(files);
    }
  });

  // drag-and-drop overlay
  const overlay = document.createElement('div');
  overlay.className = 'a-drop';
  overlay.textContent = 'drop images here ✳';
  overlay.hidden = true;
  wrap.appendChild(overlay);

  let depth = 0;
  const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
  wrap.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  wrap.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    overlay.hidden = false;
  });
  wrap.addEventListener('dragleave', (e) => {
    // leaving the container entirely (not just a child) — reset for good
    if (e.relatedTarget && !wrap.contains(e.relatedTarget)) {
      depth = 0;
      overlay.hidden = true;
      return;
    }
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  wrap.addEventListener('dragend', () => {
    depth = 0;
    overlay.hidden = true;
  });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) onFiles(files);
  });
}

// ── toolbar ──────────────────────────────────

function btn(label, title, action, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `a-tb${cls ? ' ' + cls : ''}`;
  b.title = title;
  b.setAttribute('aria-label', title);
  if (action) b.addEventListener('click', action);
  b.innerHTML = label;
  return b;
}

/**
 * Build the rich toolbar into `toolbarEl`.
 * options: {
 *   textarea,                    // the markdown textarea
 *   toolbarEl,                   // container to fill with buttons
 *   onFiles(files),              // image button / paste / drop → here
 *   onSave(),                    // Ctrl+Enter
 *   onFullscreen(),              // fullscreen toggle button
 *   showImages = true,
 * }
 */
export function setupRichEditor({ textarea, toolbarEl, onFiles, onSave, onFullscreen, showImages = true }) {
  const a = {
    bold: () => wrap(textarea, '**', '**', 'bold text'),
    italic: () => wrap(textarea, '*', '*', 'italic text'),
    strike: () => wrap(textarea, '~~', '~~', 'strikethrough'),
    code: () => wrap(textarea, '`', '`', 'code'),
    codeblock: () => insertCodeBlock(textarea),
    link: () => insertLink(textarea),
    quote: () => prefixLines(textarea, 'quote'),
    ul: () => prefixLines(textarea, 'ul'),
    ol: () => prefixLines(textarea, 'ol'),
    h1: () => heading(textarea, 1),
    h2: () => heading(textarea, 2),
    h3: () => heading(textarea, 3),
    hr: () => insertHR(textarea),
    table: () => insertTable(textarea),
  };

  const defs = [
    { label: 'H1', title: 'Heading 1 · Ctrl+Shift+1', act: a.h1, cls: 'a-tb--head' },
    { label: 'H2', title: 'Heading 2 · Ctrl+Shift+2', act: a.h2, cls: 'a-tb--head' },
    { label: 'H3', title: 'Heading 3 · Ctrl+Shift+3', act: a.h3, cls: 'a-tb--head' },
    { label: '<b>B</b>', title: 'Bold · Ctrl+B', act: a.bold },
    { label: '<i>I</i>', title: 'Italic · Ctrl+I', act: a.italic },
    { label: '<s>S</s>', title: 'Strikethrough · Ctrl+Shift+X', act: a.strike },
    { label: '&lt;/&gt;', title: 'Inline code · Ctrl+E', act: a.code, cls: 'a-tb--mono' },
    { label: '```', title: 'Code block', act: a.codeblock, cls: 'a-tb--mono' },
    { label: '🔗', title: 'Link · Ctrl+Shift+L', act: a.link },
    { label: '❝', title: 'Blockquote', act: a.quote },
    { label: '•', title: 'Bulleted list', act: a.ul },
    { label: '1.', title: 'Numbered list', act: a.ol, cls: 'a-tb--mono' },
    { label: '—', title: 'Horizontal rule', act: a.hr },
    { label: '▦', title: 'Table', act: a.table },
  ];

  for (const d of defs) toolbarEl.appendChild(btn(d.label, d.title, d.act, d.cls));

  // image upload button + hidden file input
  let fileInput = null;
  if (showImages && onFiles) {
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      const files = [...(fileInput.files || [])];
      fileInput.value = '';
      if (files.length) onFiles(files);
    });
    toolbarEl.appendChild(fileInput);
    toolbarEl.appendChild(
      btn('🖼', 'Add image (upload, drag & drop, or paste)', () => fileInput.click(), 'a-tb--img'),
    );
    attachImageDrop({ textarea, onFiles });
  }

  if (onFullscreen) {
    toolbarEl.appendChild(btn('⛶', 'Toggle fullscreen', onFullscreen, 'a-tb--fs'));
  }

  // keyboard shortcuts (browser-reserved combos like Ctrl+K / Ctrl+1..3 are
  // deliberately avoided — they can't be intercepted)
  textarea.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (e.shiftKey) {
      if (k === 'x') {
        e.preventDefault();
        a.strike();
        return;
      }
      if (k === 'l') {
        e.preventDefault();
        a.link();
        return;
      }
      if (k === '1' || k === '2' || k === '3') {
        e.preventDefault();
        a[`h${k}`]();
        return;
      }
    }
    if (k === 'enter' && onSave) {
      e.preventDefault();
      onSave();
      return;
    }
    const map = { b: a.bold, i: a.italic, e: a.code };
    if (map[k]) {
      e.preventDefault();
      map[k]();
    }
  });
}

export { MAX_IMAGE_BYTES };
