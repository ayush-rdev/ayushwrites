import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    // set draft: true to hide a post from listings and the RSS feed
    draft: z.boolean().default(false),
  }),
});

// the /now page — editable from the admin, just like posts
const now = defineCollection({
  loader: glob({ base: './src/content/now', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    updated: z.string().optional(),
  }),
});

export const collections = { blog, now };
