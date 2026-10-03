import { defineConfig, normalizePath, type Plugin } from 'vite';
import path from 'node:path';

const root = import.meta.dirname;
// data/ and audio/ live next to src/ (not in public/) so the analysis scripts own them; serve them as-is.
const dirs = ['data', 'audio'];
function promoFiles(): Plugin {
  return {
    name: 'promo-files',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (dirs.some((d) => req.url?.startsWith(`/${d}/`))) req.url = `/@fs/${encodeURI(normalizePath(root))}${req.url}`;
        next();
      });
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [promoFiles()],
  // PROMO_NO_HMR=1: export renders must not reload mid-run when a file changes
  server: { port: 5241, strictPort: true, hmr: process.env.PROMO_NO_HMR ? false : undefined, fs: { allow: [root] } },
  // one three.js instance for the core and the GLTF loader
  optimizeDeps: { include: ['three', 'three/examples/jsm/loaders/GLTFLoader.js'] },
  build: { target: 'esnext', assetsInlineLimit: 0 },
});
