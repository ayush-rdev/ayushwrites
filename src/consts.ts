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
  /** Canonical site URL (also used in astro.config.mjs) */
  url: 'https://ayush-rdev.github.io/ayushwrites',
  /** Language of the site, for the <html lang> attribute */
  lang: 'en',
} as const;

/** base path with a trailing slash — '/ayushwrites/' (or '/' at the root) */
export const BASE = import.meta.env.BASE_URL.endsWith('/')
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;
