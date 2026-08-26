import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'apps/client');
const destination = path.join(root, 'dist');

fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });

const required = [
  'index.html',
  'styles/game.css',
  'assets/model-data.js',
  'src/three-bridge.js',
  'src/three-offline-bundle.js',
  'src/game-runtime.js',
  'src/online-authoritative.js',
  'src/error-hook.js',
  'spell-icons/icon-map.js',
  'audio/combat/sound-manifest.js',
  '_headers',
  'favicon.png',
];
for (const relative of required) {
  const target = path.join(destination, relative);
  if (!fs.existsSync(target)) throw new Error(`Build is missing ${relative}`);
}

/* Every local asset index.html references must actually ship. This is what would have
   caught the missing THREE bundle instead of publishing a blank page. */
const html = fs.readFileSync(path.join(destination, 'index.html'), 'utf8');
const referenced = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)]
  .map(m => m[1].split('?')[0])
  .filter(rel => !rel.startsWith('http'));
const absent = [...new Set(referenced)].filter(rel => !fs.existsSync(path.join(destination, rel)));
if (absent.length) throw new Error(`index.html references files that are not in the build: ${absent.join(', ')}`);

console.log(`Built ${destination} (${[...new Set(referenced)].length} referenced assets verified)`);
