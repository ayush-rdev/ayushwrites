// ─────────────────────────────────────────────
//  Content helpers for the admin page — a small
//  YAML-subset frontmatter parser/serializer
//  tuned to this blog's schema, plus helpers for
//  editing src/consts.ts.
// ─────────────────────────────────────────────

function parseScalar(raw) {
  const v = String(raw).trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (
    (v.startsWith("'") && v.endsWith("'")) ||
    (v.startsWith('"') && v.endsWith('"'))
  ) {
    const inner = v.slice(1, -1);
    return v.startsWith("'")
      ? inner.replace(/''/g, "'")
      : inner.replace(/\\(.)/g, '$1');
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseScalar(s));
  }
  return v;
}

/**
 * Split a markdown file into { data, body }.
 * Handles inline values, multiline arrays (  - item), and inline arrays.
 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const raw = m ? m[0] : '';
  const data = {};

  if (m) {
    const lines = m[1].split(/\r?\n/);
    let key = null;
    let parts = [];
    let arrayMode = false;

    const flush = () => {
      if (key !== null) {
        data[key] = arrayMode
          ? parts.map((p) => parseScalar(p))
          : parseScalar(parts.join('\n'));
      }
      key = null;
      parts = [];
      arrayMode = false;
    };

    for (const line of lines) {
      const head = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (head) {
        flush();
        key = head[1];
        const rest = head[2].trim();
        arrayMode = false;
        parts = rest === '' ? [] : [rest];
      } else if (key !== null) {
        const item = /^\s*-\s+(.*)$/.exec(line);
        if (item) {
          arrayMode = true;
          parts.push(item[1].trim());
        } else if (/^\s+/.test(line) && line.trim() !== '') {
          parts.push(line.trim());
        } else if (line.trim() === '') {
          // blank line inside a value — keep as-is
          parts.push('');
        } else {
          flush();
        }
      }
    }
    flush();
  }

  return { data, body: m ? text.slice(raw.length) : text, raw };
}

/** quote a string for YAML, escaping apostrophes the YAML way */
function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

export function buildPostMarkdown({
  title,
  description,
  pubDate,
  updatedDate,
  tags,
  draft,
  body,
}) {
  const lines = ['---'];
  lines.push(`title: ${q(title)}`);
  lines.push(`description: ${q(description)}`);
  lines.push(`pubDate: '${pubDate}'`);
  if (updatedDate) lines.push(`updatedDate: '${updatedDate}'`);
  lines.push(`tags: [${(tags || []).map((t) => q(t)).join(', ')}]`);
  lines.push(`draft: ${draft ? 'true' : 'false'}`);
  lines.push('---');
  lines.push('');
  lines.push(String(body).replace(/\s+$/, '') + '\n');
  return lines.join('\n');
}

export function buildNowMarkdown({ updated, body }) {
  const lines = ['---'];
  lines.push(`updated: ${q(updated)}`);
  lines.push('---');
  lines.push('');
  lines.push(String(body).replace(/\s+$/, '') + '\n');
  return lines.join('\n');
}

/** 'Hello, World!' → 'hello-world' */
export function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function countWords(s) {
  return String(s)
    .replace(/[#*`>_\-\[\]()!]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

// ── src/consts.ts editing ────────────────────
// The SITE object uses single-quoted, single-line string values:
//   title: 'my corner',
// Values may contain JS escapes (\', \\), so the matcher below treats
// backslash-escapes as part of the string.

// matches a quoted, single-line JS string value: '...' or "...", with \-escapes allowed
const SITE_RE = (key) =>
  new RegExp(`(${key}:\\s*)(?:'((?:\\\\.|[^'\\\\])*)'|"((?:\\\\.|[^"\\\\])*)")`);

/** escape a value into a single-quoted JS string literal (newlines included) */
function escapeJsString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/** undo the escapes above */
function unescapeJsString(value) {
  return value.replace(/\\(['"\\nrt])/g, (m, c) =>
    ({ "'": "'", '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' })[c] ?? m,
  );
}

/** pull the editable SITE fields out of the current consts.ts text */
export function readConsts(text) {
  const grab = (key) => {
    const m = SITE_RE(key).exec(text);
    if (!m) return '';
    return unescapeJsString(m[2] !== undefined ? m[2] : m[3]);
  };
  return {
    title: grab('title'),
    author: grab('author'),
    description: grab('description'),
  };
}

/** return a new consts.ts text with the given SITE fields replaced */
export function writeConsts(text, { title, author, description }) {
  let out = text;
  const set = (key, value) => {
    const re = SITE_RE(key);
    if (!re.test(out)) {
      throw new Error(`Couldn't find "${key}" in src/consts.ts`);
    }
    out = out.replace(re, (_m, pre) => `${pre}'${escapeJsString(value)}'`);
  };
  set('title', title);
  set('author', author);
  set('description', description);
  return out;
}
