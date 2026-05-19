import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://stevenwolfe.github.io',
  base: '/obsidian-qmd-search',
  output: 'static',
  trailingSlash: 'ignore',
});
