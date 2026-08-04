import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { catalogue } from '../packages/content/src/catalogue.js';

const source = fs.readFileSync(new URL('../apps/client/src/online-authoritative.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../apps/client/index.html', import.meta.url), 'utf8');

const slug = value => String(value)
  .normalize('NFKD')
  .replace(/[’']/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .toLowerCase();

test('authoritative browser client maps every base and talent button to its server ID', () => {
  const match = source.match(/var TALENT_ABILITY_IDS=(\{[^;]+\});/);
  assert.ok(match);
  const talentIds = JSON.parse(match[1]);
  for (const entry of catalogue.classes) {
    for (const ability of entry.baseAbilities) assert.equal(`${entry.id}.${slug(ability.name)}`, ability.id);
    for (const ability of entry.talentAbilities) assert.equal(talentIds[`${entry.id}|${ability.name}`], ability.id);
  }
  assert.equal(Object.keys(talentIds).length, catalogue.totals.talentAbilities);
});

test('new online path has no peer-host authority, WebRTC or public TURN dependency', () => {
  new vm.Script(source, { filename: 'online-authoritative.js' });
  for (const forbidden of ['RTCPeerConnection', 'PeerTransport', 'openrelay.metered.ca', 'hostFrame', 'installHostRelays']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.ok(source.includes('var PROTOCOL=20'));
  assert.ok(source.includes("type:'action'"));
  assert.ok(source.includes("type:'input'"));
  assert.ok(source.includes("event.type==='castStarted'"));
  assert.ok(source.includes('vfxFistsChannel'));
  assert.ok(source.includes('g.projectile(unit,target'));
  assert.ok(source.includes('vfxDisciplineStarBolt'));
  assert.ok(source.includes("event.type==='presentation'"));
  assert.ok(source.includes('vfxMeteorfall'));
  assert.ok(source.includes("event.cue==='meteorfallImpact'"));
  assert.ok(source.includes("event.cue==='whirlingDragonPunch'"));
  assert.ok(source.includes("event.cue==='volcanicEruption'"));
  assert.ok(source.includes("event.cue==='volcanicLavaBurst'"));
  assert.ok(source.includes("event.cue==='alterTimeSaved'"));
  assert.ok(source.includes("event.cue==='alterTimeReturn'"));
  assert.ok(source.includes("event.cue==='avengingWings'"));
  assert.ok(source.includes('vfxTouchOfDeathMark'));
  assert.ok(source.includes('function abilityForId'));
  assert.ok(source.includes('BOT_ABILITY_DEFS'));
  assert.ok(source.includes("type:'resync'"));
  assert.ok(html.includes('./src/online-authoritative.js'));
  assert.equal(html.includes('<script src="./src/online-v210.js"></script>'), false);
});
