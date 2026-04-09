import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'path';
import manifest from './public/manifest.json';

export default defineConfig({
  plugins: [crx({ manifest })],
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
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV === 'development',
    minify: process.env.NODE_ENV === 'production' ? 'esbuild' : false,
  },
});
