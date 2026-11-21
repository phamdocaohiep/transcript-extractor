import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: path.resolve(__dirname, 'src/playback-observer.ts'),
      formats: ['iife'],
      name: 'PlaybackObserver',
      fileName: () => 'playback-observer.js',
    },
  },
});
