import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extensionManifest } from './build/extensionManifest.ts';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'VITE_');
  const apiUrl = environment.VITE_BRANCHLIGHT_API_URL;
  return {
    plugins: [
      react(),
      {
        name: 'branchlight-extension-manifest',
        async writeBundle(output) {
          const source = JSON.parse(await readFile(resolve('public/manifest.json'), 'utf8'));
          await writeFile(
            resolve(output.dir ?? 'dist', 'manifest.json'),
            JSON.stringify(extensionManifest(source, apiUrl), null, 2),
          );
        },
      },
    ],
    base: './',
    server: {
      host: '127.0.0.1',
      port: 5173,
      watch: { ignored: ['**/.branchlight/**'] },
      fs: { deny: ['.env', '.env.*', '**/*.{crt,pem}', '**/.git/**', '**/.branchlight/**'] },
    },
    build: { target: 'es2022', chunkSizeWarningLimit: 1800 },
  };
});
