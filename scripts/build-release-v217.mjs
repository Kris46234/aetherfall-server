import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'apps/client');
const dist = path.join(root, 'dist');
const release = path.join(root, 'release/Aetherfall_Online_v217_Complete');
const offline = path.join(release, 'OFFLINE_GAME');
const netlify = path.join(release, 'NETLIFY_CLIENT');
const render = path.join(release, 'RENDER_SERVER');
const previous = path.join(root, 'release/Aetherfall_Arena_v216_Lifesage_Audio_Focus');

fs.rmSync(release, { recursive: true, force: true });
fs.mkdirSync(offline, { recursive: true });
fs.mkdirSync(render, { recursive: true });

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function replaceExact(source, needle, replacement) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`Expected one occurrence, found ${count}: ${needle}`);
  return source.replace(needle, replacement);
}

let html = read('apps/client/index.html');
html = replaceExact(
  html,
  '<link rel="stylesheet" href="./styles/game.css">',
  `<style>\n${read('apps/client/styles/game.css')}\n</style>`
);
html = replaceExact(
  html,
  '<script id="aether-model-data" src="./assets/model-data.js"></script>',
  `<script id="aether-model-data">\n${read('apps/client/assets/model-data.js')}\n</script>`
);
html = replaceExact(
  html,
  '<script type="module" src="./src/three-bridge.js"></script>',
  `<script type="module">\n${read('apps/client/src/three-bridge.js')}\n</script>`
);
for (const name of ['game-runtime', 'online-authoritative', 'error-hook']) {
  html = replaceExact(
    html,
    `<script src="./src/${name}.js"></script>`,
    `<script>\n${read(`apps/client/src/${name}.js`)}\n</script>`
  );
}

fs.writeFileSync(
  path.join(offline, 'Aetherfall_Arena_v217_Combat_Cup_Update.html'),
  html
);
for (const directory of ['spell-icons', 'audio']) {
  fs.cpSync(path.join(client, directory), path.join(offline, directory), { recursive: true });
}
for (const name of ['COMBAT_AUDIO_MANIFEST.txt', 'FOOTSTEP_ASSET_MANIFEST.txt', 'THIRD_PARTY_ASSETS.txt']) {
  fs.copyFileSync(path.join(previous, name), path.join(offline, name));
}

fs.cpSync(dist, netlify, { recursive: true });

for (const directory of ['apps/server', 'packages']) {
  fs.cpSync(path.join(root, directory), path.join(render, directory), { recursive: true });
}
for (const name of ['package.json', 'package-lock.json', 'render.yaml', 'RENDER_DEPLOY.md']) {
  fs.copyFileSync(path.join(root, name), path.join(render, name));
}

const changelog = `AETHERFALL ARENA v217 — COMBAT RULES & CUP PROGRESSION

GAMEPLAY
- Blooming Echo and Rejuvenate are separate Lifesage effects and heal together.
- Stormbolt replaces Execute Strike: 22m violet missile, 3 sec stun, 25 sec cooldown.
- Touch of Death replaces Cyclone Barrage: a 5 sec mark that records damaging-spell
  damage by its caster and explodes for 40% of the recorded amount.
- Tiger's Lust grants 60% movement speed.
- Essence Siphon refreshes Unstable Affliction on its target.
- Chain Spark damage increased by 50%.
- Pummel locks the interrupted school for 3 sec and readies one Mortal Swing
  dealing 30% more damage. Avatar and Warbreaker multiply with that strike.
- Vendetta and Vendetta-accelerated damage-over-time ticks no longer produce
  repetitive sword audio.

AI AND ONLINE
- Offline and authoritative bots understand Stormbolt, Touch of Death, revised
  Pummel windows, refreshed Unstable Affliction, and the updated burst rules.
- Bot choices account for health, range, line of sight, current casts, crowd
  control, defensive states, kill pressure and healer danger.
- Online protocol 12 owns all damage, healing, cooldown, control and bot decisions.
- The 30Hz server simulation sends 20 authoritative snapshots per second.

PROGRESSION AND UI
- Aether Cup Champion progress is tracked per class.
- The first Cup clear on each class grants 22,000 Valor Shards, title eligibility
  for that class and its Chronocrown Proto-Drake colour scheme.
- Existing Chronocrown class colours migrate into Cup-clear progress.
- Achievement UI shows class-clear progress.
- Chronocrown's ninth colour now fits in a scrollable three-column grid.
- Added an in-game Change Log.

PERFORMANCE AND PRESENTATION
- 3v3 lowers renderer pixel density and uses a bounded visual-effect budget.
- Short cosmetic effects are capped and oldest disposable effects are reclaimed.
- Action-bar and focus-binding artwork, class emblems, footsteps, Lifesage samples
  and the 5-to-12-metre spatial combat mix are retained from v216.
`;

const offlineReadme = `AETHERFALL ARENA v217 — OFFLINE GAME

1. Extract the complete ZIP.
2. Open OFFLINE_GAME.
3. Double-click Aetherfall_Arena_v217_Combat_Cup_Update.html.
4. Keep the spell-icons and audio folders beside the HTML file.

The renderer imports Three.js from its CDN, so internet access is needed when the
page first loads. Offline matches and progression run locally in the browser.

For two-player co-op, deploy NETLIFY_CLIENT and RENDER_SERVER together by following
DEPLOYMENT_STEPS.txt in the parent folder.
`;

const deployment = `AETHERFALL ONLINE v217 — DEPLOYMENT STEPS

IMPORTANT
The v217 browser client uses protocol 12. Deploy the Render server first, confirm
its health response says "protocol":12, then deploy the Netlify client.

RENDER
1. Replace the server files in your GitHub repository with the contents of
   RENDER_SERVER. package.json and render.yaml must be at the repository root.
2. Commit the changes to main.
3. Render should sync automatically. Otherwise use Manual Deploy -> Deploy latest commit.
4. Open https://aetherfall-authoritative-coop.onrender.com
5. Continue only when the JSON response reports:
   "service":"Aetherfall authoritative co-op" and "protocol":12

NETLIFY
1. Open your existing Netlify site.
2. Deploy the contents of NETLIFY_CLIENT, or drag the NETLIFY_CLIENT folder into
   Netlify's manual deploy area.
3. Do not upload RENDER_SERVER to Netlify.
4. Open the Netlify game URL and hard-refresh with Ctrl+Shift+R.
5. Both players must use the same newly deployed Netlify URL.

PLAYING CO-OP
1. One player opens Play Online and creates a lobby.
2. The server field defaults to the Render URL above.
3. Copy the invite to the second player.
4. Wait for both class selections to appear, then start co-op.

RENDER FREE-TIER NOTE
The free service can sleep after inactivity, so the first request may take roughly
50 seconds or more. Open the health URL before a play session and wait for its JSON
response. Once awake, both players connect to the Frankfurt authority; neither
player's browser hosts the simulation.
`;

fs.writeFileSync(path.join(offline, 'README.txt'), offlineReadme);
fs.writeFileSync(path.join(release, 'CHANGELOG_v217.txt'), changelog);
fs.writeFileSync(path.join(release, 'DEPLOYMENT_STEPS.txt'), deployment);
fs.writeFileSync(path.join(render, 'README_v217.txt'), deployment);

console.log(`Built ${release}`);
