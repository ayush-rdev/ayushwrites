// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Deployed as a GitHub Pages project page:
//   site = account root, base = repository name (no leading slash)
const site = 'https://ayush-rdev.github.io';
const base = '/ayushwrites';

// https://astro.build/config
export default defineConfig({
  site,
  base,
  integrations: [sitemap()],
});
