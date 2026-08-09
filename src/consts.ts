// ─────────────────────────────────────────────
//  ✏️  Site-wide settings — edit everything here
// ─────────────────────────────────────────────

export const SITE = {
  /** Shown in the header wordmark and browser tab */
  title: 'my corner',
  /** Your name — used in the hero and footer */
  author: 'Ayush',
  /** Short line used in meta descriptions + RSS feed */
  description: 'Personal blog of Ayush(me)(⁠ ⁠◜⁠‿⁠◝⁠ ⁠)⁠♡',
  /** Canonical site URL — the root domain, WITHOUT the base path (the base
      path is appended automatically via BASE, e.g. og:url = this + base) */
  url: 'https://ayush-rdev.github.io',
  /** Language of the site, for the <html lang> attribute */
  lang: 'en',
} as const;

/** base path with a trailing slash — '/ayushwrites/' (or '/' at the root) */
export const BASE = import.meta.env.BASE_URL.endsWith('/')
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;
