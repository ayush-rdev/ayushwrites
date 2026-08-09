import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { BASE, SITE } from '../consts';
import { isPublished } from '../lib/posts';

export async function GET(context) {
  const posts = (await getCollection('blog', isPublished)).sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
  );

  return rss({
    title: SITE.title,
    description: SITE.description,
    // channel link should point at the feed's own subpath
    site: `${context.site}${BASE}`,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `${BASE}posts/${post.id}/`,
    })),
  });
}
