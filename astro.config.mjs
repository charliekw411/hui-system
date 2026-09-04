import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
  // Hybrid mode: static by default, opt-in SSR for admin pages via `export const prerender = false`.
  output: 'hybrid',
  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),
  integrations: [tailwind()],
  vite: {
    ssr: {
      external: ['node:buffer'],
    },
  },
});
