import type { CollectionEntry } from 'astro:content';

/**
 * Visible on the live site: not a draft, and its publish date has arrived.
 * Combined with the daily rebuild workflow, this is how scheduled posts
 * (a pubDate in the future) go live automatically on their publish date.
 * Evaluated at build time — the date is compared against the build clock
 * (GitHub Actions runs in UTC).
 */
export function isPublished(post: CollectionEntry<'blog'>): boolean {
  return !post.data.draft && post.data.pubDate.getTime() <= Date.now();
}
