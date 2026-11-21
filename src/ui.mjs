// Serves the dashboard page from public/index.html (read once, cached).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');
let cached = null;

export function dashboardHtml() {
  if (!cached) cached = fs.readFileSync(file, 'utf8');
  return cached;
}
