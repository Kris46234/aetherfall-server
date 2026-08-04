import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'apps/client');
const referencePath = path.join(root, 'reference/Aetherfall_Arena_v210_reference.html');
const htmlPath = path.join(client, 'index.html');
const reference = fs.readFileSync(referencePath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

const styles = [...reference.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/gi)];
const scripts = [...reference.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
if (styles.length !== 1 || scripts.length !== 6) throw new Error('Reference layout changed');

const parity = [
  ['assets/model-data.js', scripts[1][2]],
  ['src/three-bridge.js', scripts[2][2]],
  ['src/error-hook.js', scripts[5][2]],
];
for (const [relative, original] of parity) {
  const extracted = fs.readFileSync(path.join(client, relative), 'utf8');
  if (extracted.trim() !== original.trim()) throw new Error(`${relative} differs from v210 reference`);
  if (!html.includes(`./${relative}`)) throw new Error(`index.html does not load ${relative}`);
}

const legacyOnline = fs.readFileSync(path.join(client, 'src/online-v210.js'), 'utf8');
if (legacyOnline.trim() !== scripts[4][2].trim()) throw new Error('Archived v210 online client changed');

for (const relative of ['assets/model-data.js', 'src/game-runtime.js', 'src/online-v210.js', 'src/online-authoritative.js', 'src/error-hook.js']) {
  new vm.Script(fs.readFileSync(path.join(client, relative), 'utf8'), { filename: relative });
}
await import(pathToFileURL(path.join(client, 'src/three-bridge.js')).href).catch(error => {
  if (!String(error).includes('Cannot find package')) throw error;
});

for (const relative of ['styles/game.css', 'src/game-runtime.js']) {
  if (!html.includes(`./${relative}`)) throw new Error(`index.html does not load ${relative}`);
}
for (const relative of ['spell-icons/icon-map.js', 'audio/combat/sound-manifest.js']) {
  if (!fs.existsSync(path.join(client, relative))) throw new Error(`${relative} is missing`);
  if (!html.includes(`./${relative}`)) throw new Error(`index.html does not load ${relative}`);
}
if (!html.includes('Aetherfall Arena v225')) throw new Error('Client version title is missing');
if (!html.includes('./src/online-authoritative.js')) throw new Error('Authoritative online client is not loaded');
if (!fs.readFileSync(path.join(client, 'src/online-authoritative.js'), 'utf8').includes('var PROTOCOL=20')) {
  throw new Error('Authoritative online protocol version is not 20');
}
const runtime = fs.readFileSync(path.join(client, 'src/game-runtime.js'), 'utf8');
for (const marker of ['teamRegroupPlan(allies,enemies)', 'tryTeamPeel(allies,enemies,d)', 'spreadPreventiveHealing(allies,enemies,d)', "case'healerEscape':this.dash(c,9,true)", 'SHADOW MEND · LAST RESORT', 'const atonementTime=']) {
  if (!runtime.includes(marker)) throw new Error(`v225 healer AI marker is missing: ${marker}`);
}

console.log('Immutable assets, v225 renderer and authoritative JavaScript checks passed');
