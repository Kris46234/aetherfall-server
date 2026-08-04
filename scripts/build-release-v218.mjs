import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'apps/client');
const dist = path.join(root, 'dist');
const releaseRoot = path.join(root, 'release');
const release = path.join(releaseRoot, 'Aetherfall_Online_v225_Complete');
const offline = path.join(release, 'OFFLINE_GAME');
const netlify = path.join(release, 'NETLIFY_CLIENT');
const render = path.join(release, 'RENDER_SERVER');
const assetManifests = path.join(root, 'release/Aetherfall_Arena_v216_Lifesage_Audio_Focus');

const archives = {
  complete: path.join(releaseRoot, 'Aetherfall_Online_v225_Complete.zip'),
  offline: path.join(releaseRoot, 'Aetherfall_Arena_v225_Offline.zip'),
  netlify: path.join(releaseRoot, 'Aetherfall_Netlify_Client_v225.zip'),
  render: path.join(releaseRoot, 'Aetherfall_Render_Server_v225.zip')
};

fs.rmSync(release, { recursive: true, force: true });
for (const archive of Object.values(archives)) fs.rmSync(archive, { force: true });
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

function zipDirectory(source, destination, childName = '.') {
  execFileSync('zip', ['-qr', destination, childName], { cwd: source });
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
  path.join(offline, 'Aetherfall_Arena_v225_Atonement_AI.html'),
  html
);
for (const directory of ['spell-icons', 'audio']) {
  fs.cpSync(path.join(client, directory), path.join(offline, directory), { recursive: true });
}
for (const name of ['COMBAT_AUDIO_MANIFEST.txt', 'FOOTSTEP_ASSET_MANIFEST.txt', 'THIRD_PARTY_ASSETS.txt']) {
  fs.copyFileSync(path.join(assetManifests, name), path.join(offline, name));
}

fs.cpSync(dist, netlify, { recursive: true });

for (const directory of ['apps/server', 'packages']) {
  fs.cpSync(path.join(root, directory), path.join(render, directory), { recursive: true });
}
for (const name of ['package.json', 'package-lock.json', 'render.yaml', 'RENDER_DEPLOY.md']) {
  fs.copyFileSync(path.join(root, name), path.join(render, name));
}

const changelog = `AETHERFALL ARENA v225 — ATONEMENT DISCIPLINE

DISCIPLINE AI
- Discipline establishes and refreshes Atonement, then uses offensive Penance,
  Solace and Smite as its normal healing rotation.
- Shadow Mend is reserved for critical health, dangerous incoming burst,
  Holy-school lockouts or situations with no reachable offensive target.
- Healers hold a triage target briefly unless another ally becomes substantially
  more urgent, reducing indecisive target changes during split pressure.

BALANCE
- Shadow Mend healing is increased by 20%, from 238 to 286 before talents,
  equipment and dampening.

ONLINE
- Protocol 20 keeps the new Shadow Mend value and catalogue synchronized between
  both clients and the authoritative Render server.

VERIFICATION
- The deterministic combat, protocol, adapter, reconnect and soak suite passes.

PREVIOUS v224 HIGHLIGHTS

TEAM POSITIONING
- Healers and endangered teammates share a short-lived pillar regroup point,
  preventing opposite-side retreats and preserving healing line of sight.
- Split-pressure triage evaluates missing health, active attackers, incoming
  burst and crowd control instead of tunnelling only the lowest health bar.
- Non-Soulweaver DPS can peel a pressured healer with class-appropriate control
  before regrouping. Soulweaver's successful v223 rotation is unchanged.

HEALING AND UTILITY
- Lifesage spreads Rejuvenate and Blooming Echo, Discipline spreads Atonement
  shields, and Paladin spreads Bestow Faith when multiple allies are injured.
- Power Shield, Penance, Psychic Scream and Shadow Mend cost 6, 8, 4 and 6 mana.
- Fae Retreat travels 9m, up from 7m.
- Static Snare uses a distinct supplied dark-binding sound.

ONLINE
- Protocol 19 keeps the coordinated AI, mana values, movement and presentation
  synchronized between both players and the authoritative Render server.

VERIFICATION
- The deterministic combat, protocol, adapter, reconnect and soak suite passes.

PREVIOUS v223 HIGHLIGHTS

RATED AI
- Bot reaction cadence, interrupt accuracy and kiting now scale through five
  rating tiers from learning opponents to 2700+ arena behaviour.
- Talent cooldowns are evaluated only after coordinated target, range and line-
  of-sight planning, preventing expanded toolkits from firing randomly on pull.
- Stormwarden builds Totem Mastery -> Stormkeeper -> Skybreaker Pulse ->
  Volcanic Eruption -> instant Arc Spark pressure and only heals outside a kill.

COMBAT AND PRESENTATION
- Cauterize is passive again, with the intended cheat-death and movement burst.
- Blinding Light lasts 5 seconds on a 45-second cooldown. Ordinary melee attacks
  gain a small forgiveness range while Stormbolt remains unchanged.
- Alter Time has a large twelve-mark countdown clock. Shield Wall displays four
  rotating shield panels, and Warbreaker correctly empowers Mortal Swing by 30%.
- Restored distinct supplied audio for the expanded Stormwarden kit and
  Tigereye Brew, including the dedicated Volcanic Eruption sample.

INTERFACE
- Ability cooldown badges use an unambiguous “Cooldown: 16s” format.
- A setting can hide live Details damage/healing meters during combat while the
  normal post-match encounter report remains available.

ONLINE
- Protocol 18 keeps clients and the authoritative server on the same defensive
  presentation cues, balance data and Volcanic Eruption rules.

VERIFICATION
- The complete deterministic combat, AI, reconnect, adapter and soak suite passes.

PREVIOUS v222 HIGHLIGHTS

BALANCE
- Warbreaker empowers the next Mortal Swing by 30%.
- Touch of Death detonates for 30% of damage recorded during its five-second mark.
- Volcanic Eruption damage is increased by 20% and Spirit Blossom healing by 10%.
- Totem Mastery grants 5% damage, healing, shielding and proc chance, plus 10%
  Flame Shock damage, and costs no mana.
- Mortal Horror always heals 20% maximum health before dampening modifies it.

COMBAT RULES
- Phoenix Guard is replaced by Alter Time. It saves the Flame Duelist's current
  position and health for five seconds, then restores them on expiry or recast.
  Its 60-second cooldown begins when the return occurs.
- Training Grounds is exclusive to the Training queue. Ranked and Skirmish
  automatically return to the random arena pool.

PRESENTATION AND UI
- Avatar enlarges and greys the Warrior model without orbiting rocks.
- Volcanic Eruption uses a dedicated impact from the supplied combat audio pack.
- Six Windwalker utility abilities use distinct supplied audio samples.
- Ability dragging chooses the nearest slot, Armoury class selectors use class
  artwork, and in-game release notes show the icons of changed abilities.

PERFORMANCE AND ONLINE
- Protocol 17 makes the authoritative server own Volcanic Eruption follow-ups,
  Alter Time, all balance values, cooldowns and presentation cues.
- Render simulates at 30Hz and sends 20 authoritative snapshots per second.
`;

const offlineReadme = `AETHERFALL ARENA v225 — OFFLINE GAME

1. Extract this ZIP.
2. Keep the spell-icons and audio folders beside the HTML file.
3. Double-click Aetherfall_Arena_v225_Atonement_AI.html.

The renderer imports Three.js from its CDN, so internet access is needed when the
page first loads. Offline matches and progression then run locally in the browser.

For two-player co-op, deploy the matching v225 NETLIFY_CLIENT and RENDER_SERVER
packages together. Both use protocol 20.
`;

const deployment = `AETHERFALL ONLINE v225 — DEPLOYMENT STEPS

IMPORTANT
The v225 browser client and authoritative server both use protocol 20. Deploy the
Render server first, confirm protocol 20, then deploy the Netlify client.

RENDER
1. Replace the server files in your GitHub repository with the contents of the
   RENDER_SERVER package. package.json and render.yaml belong at repository root.
2. Commit the changes to main.
3. Let Render sync, or choose Manual Deploy -> Deploy latest commit.
4. Open https://aetherfall-authoritative-coop.onrender.com
5. Continue only when the JSON response reports:
   "service":"Aetherfall authoritative co-op" and "protocol":20

NETLIFY
1. Open your existing Netlify site.
2. Manually deploy the contents of the NETLIFY_CLIENT package.
3. Do not upload the Render package to Netlify.
4. Open the game and hard-refresh with Ctrl+Shift+R.
5. Both players must use the newly deployed Netlify version.

PLAYING CO-OP
1. Open the Render health URL first and wait for the JSON response.
2. One player creates a co-op lobby and copies the invite.
3. The second player joins; wait for both class selections to appear.
4. The host starts co-op.

FREE-TIER NOTE
Render's free service can sleep after inactivity, so the first request may take
roughly 50 seconds or more. Once awake, both players connect to the Frankfurt
authority; neither player's browser hosts the match.
`;

fs.writeFileSync(path.join(offline, 'README.txt'), offlineReadme);
fs.writeFileSync(path.join(release, 'CHANGELOG_v225.txt'), changelog);
fs.writeFileSync(path.join(release, 'DEPLOYMENT_STEPS.txt'), deployment);
fs.writeFileSync(path.join(render, 'README_v225.txt'), deployment);

zipDirectory(releaseRoot, archives.complete, path.basename(release));
zipDirectory(offline, archives.offline);
zipDirectory(netlify, archives.netlify);
zipDirectory(render, archives.render);

console.log(JSON.stringify({
  release,
  archives: Object.fromEntries(
    Object.entries(archives).map(([name, file]) => [name, {
      file,
      bytes: fs.statSync(file).size
    }])
  )
}, null, 2));
