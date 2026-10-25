import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaRegistry } from '../../server/match/effectsMeta.js';
import { reportUnimplementedTraits, unimplementedTraitKeys } from '../../server/match/pluginTraits.js';

const gd = (garrisons) => ({ garrisons });

test('pluginTraits: engine keys are not reported, pack-private keys are', () => {
  const registry = new MetaRegistry();
  registry.garrison('SERVER_ADD_BOND_METHOD', { run() {} });
  const data = gd({
    garrison_x_demo_a: { effectKey: 'SERVER_ADD_BOND_METHOD' },
    garrison_x_demo_b: { effectKey: 'COL_GAIN_RANDOM_EQUIP' },
    garrison_x_demo_c: { effectKey: 'custom_gain_on_kills' },
    garrison_12_a: { effectKey: 'neitherKey' },
  });
  // `custom_gain_on_kills` is one of the battle-side keys the engine now runs (BATTLE_TRAIT_KEYS), so only the
  // pack-private key with no implementation is reported.
  assert.deepEqual(unimplementedTraitKeys(registry, data).sort(), ['COL_GAIN_RANDOM_EQUIP']);
});

test('pluginTraits: the match log gets one line naming the first keys', () => {
  const registry = new MetaRegistry();
  const data = gd({
    garrison_x_demo_a: { effectKey: 'COL_A' },
    garrison_x_demo_b: { effectKey: 'COL_B' },
  });
  const lines = [];
  const keys = reportUnimplementedTraits({ registry, gd: data, log: { info: (m) => lines.push(m) } });
  assert.equal(keys.length, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2 plugin trait effect key\(s\) have no engine implementation: COL_A, COL_B/u);
});

test('pluginTraits: nothing to say on a vanilla match, and a bare log function works', () => {
  const registry = new MetaRegistry();
  const lines = [];
  assert.deepEqual(reportUnimplementedTraits({ registry, gd: gd({ garrison_12_a: { effectKey: 'x' } }), log: (m) => lines.push(m) }), []);
  assert.deepEqual(lines, []);
  const keys = reportUnimplementedTraits({ registry, gd: gd({ garrison_x_demo_a: { effectKey: 'COL_A' } }), log: (m) => lines.push(m) });
  assert.deepEqual(keys, ['COL_A']);
  assert.equal(lines.length, 1);
});
