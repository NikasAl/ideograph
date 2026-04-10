import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'path';
import { copyFileSync } from 'fs';
import manifest from './manifest.json';

/** Vite plugin: copy index.html to dist after build (needed without chrome_url_overrides) */
function copyIndexHtml() {
  return {
    name: 'copy-index-html',
    closeBundle() {
      const src = resolve(__dirname, 'index.html');
      const dest = resolve(__dirname, 'dist/index.html');
      copyFileSync(src, dest);
    },
  };
}

export default defineConfig({
  plugins: [crx({ manifest }), copyIndexHtml()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@bg': resolve(__dirname, 'src/background'),
      '@db': resolve(__dirname, 'src/db'),
      '@ui': resolve(__dirname, 'src/ui'),
      '@ext': resolve(__dirname, 'src/extraction'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV === 'development',
    minify: process.env.NODE_ENV === 'production' ? 'esbuild' : false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
