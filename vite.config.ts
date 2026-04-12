import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'path';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@bg': resolve(__dirname, 'src/background'),
      '@db': resolve(__dirname, 'src/db'),
      '@ui': resolve(__dirname, 'src/ui'),
      '@ext': resolve(__dirname, 'src/extraction'),
      // djvujs-dist has no main/exports — point directly to library source
      'djvujs-dist/library/src/index.js': resolve(__dirname, 'node_modules/djvujs-dist/library/src/index.js'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV === 'development',
    minify: process.env.NODE_ENV === 'production' ? 'esbuild' : false,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
