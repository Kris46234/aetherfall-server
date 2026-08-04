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
  'src/game-runtime.js',
  'src/online-authoritative.js',
  'src/error-hook.js',
  'spell-icons/icon-map.js',
  'audio/combat/sound-manifest.js',
  '_headers',
];
for (const relative of required) {
  const target = path.join(destination, relative);
  if (!fs.existsSync(target)) throw new Error(`Build is missing ${relative}`);
}

console.log(`Built ${destination}`);
