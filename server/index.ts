/** Dev/prod entry point: serves the API and the Vite-built UI. */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApiApp } from './api';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const distDir = path.join(root, 'dist');
const staticDir = fs.existsSync(path.join(distDir, 'index.html')) ? distDir : undefined;
const port = Number(process.env.PORT ?? 4173);

const { app } = createApiApp({ staticDir });
app.listen(port, () => {
  const mode = staticDir ? 'UI + API' : 'API only (run the Vite dev server for the UI)';
  console.log(`sprite atlas server ready: http://localhost:${port}  [${mode}]`);
  if (!staticDir) {
    console.log('build the UI first with: npm run build');
  }
});
