import { defineConfig } from 'vite';

// GitHub Pages serves project sites from a /<repo>/ subpath; keep dev at
// root so the local Browser-pane workflow and `npm run dev` are unaffected.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/fareview/' : '/',
}));
