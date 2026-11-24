import { defineConfig } from 'astro/config';
import permalock from '@permalock/astro';

export default defineConfig({
  site: 'https://example.com',
  trailingSlash: 'always',
  integrations: [permalock()],
});
