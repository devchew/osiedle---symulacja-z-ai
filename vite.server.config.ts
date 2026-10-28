import { defineConfig } from 'vite';

// Bundles the production server (server/prod.ts) into a single file for Node:
// dist-server/prod.js. Everything is inlined, so the runtime image needs no node_modules.
export default defineConfig({
  build: {
    ssr: 'server/prod.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    sourcemap: true,
  },
  ssr: { noExternal: true },
});
