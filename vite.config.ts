import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Copies staticwebapp.config.json (Azure Static Web Apps routing + headers) from the project root into dist/. */
function copyStaticWebAppConfig(): Plugin {
  let outDir = 'dist';
  let root = process.cwd();
  return {
    name: 'copy-staticwebapp-config',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
      root = c.root;
    },
    closeBundle() {
      const src = resolve(root, 'staticwebapp.config.json');
      if (existsSync(src)) copyFileSync(src, resolve(root, outDir, 'staticwebapp.config.json'));
    },
  };
}

export default defineConfig({
  plugins: [copyStaticWebAppConfig()],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { include: ['tests/**/*.test.ts'] },
});
