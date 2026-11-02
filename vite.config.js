import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [{
    name: 'allow-vite-development-styles',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("style-src 'self';", "style-src 'self' 'unsafe-inline';");
    },
  }],
  build: { target: 'es2022', sourcemap: false },
});
