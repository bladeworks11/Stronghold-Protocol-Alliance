// Authored (plugin) bonds: the declarative half of their `env_gbuff_new` blackboard (docs/PLUGINS.md §bonds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setGameData } from '../../server/sim/content/support/index.js';
import { bondMods, unreadKeys, install } from '../../server/sim/content/bonds/plugin.js';

const BOND = 'bond_x_demo_lit';
const REC = {
  bondId: BOND,
  buffs: [{
    key: 'env_gbuff_new',
    bb: {
      base_atk: 0.1, atk_per_stack: 0.05,
      base_max_hp: 0.2, max_hp_per_stack: 0,
      base_def: 0, def_per_stack: 0.1,
      base_attack_speed: 10, attack_speed_per_stack: 5,
      base_damage_scale: 0.25, damage_scale_per_stack: 0.05,
      damage_resistance: 0.2,
      power_bond_char_cnt: 3,
      base_prob: 0.5,
    },
  }],
};

const op = (id, bonds) => ({ uid: id, kind: 'op', id, ownerId: 'p1', def: { bonds }, items: [], alive: true, deployed: true });

function battle(ops, bonds) {
  const handlers = new Map();
  const logs = [];
  return {
    players: [{ id: 'p1' }],
    allyUnits: ops,
    logs,
    getPlayer: (pid) => (pid === 'p1' ? { bonds } : null),
    on: (ev, fn) => { const list = handlers.get(ev) ?? []; list.push(fn); handlers.set(ev, list); },
    fire: (ev, arg) => { for (const fn of handlers.get(ev) ?? []) fn(arg); },
    addBuff: (u, buff) => { (u.buffs ??= []).push(buff); },
    log: (m) => logs.push(m),
  };
}

test('bondMods: the stat fields of the blackboard become engine mods, per live layer', () => {
  setGameData({ bonds: { [BOND]: REC } });
  const m0 = bondMods(REC, 0);
  assert.equal(m0.atkPct, 0.1);
  assert.equal(m0.hpPct, 0.2);
  assert.equal(m0.aspd, 10);
  assert.equal(m0.dmgDealtMul, 1.25);
  assert.equal(m0.physTakenMul, 0.8);
  assert.equal(m0.artsTakenMul, 0.8);
  assert.equal(m0.defPct, undefined, 'a zero part is left out');
  const m3 = bondMods(REC, 3);
  assert.ok(Math.abs(m3.atkPct - 0.25) < 1e-9, '+0.05 per layer');
  assert.ok(Math.abs(m3.defPct - 0.3) < 1e-9);
  assert.equal(m3.aspd, 25);
  assert.ok(Math.abs(m3.dmgDealtMul - 1.4) < 1e-9);
});

test('bondMods: a blackboard with no stat field yields null (nothing to apply)', () => {
  const rec = { bondId: 'bond_x_demo_proc', buffs: [{ key: 'env_gbuff_new', bb: { base_prob: 0.5, prob_per_stack: 0.1 } }] };
  assert.equal(bondMods(rec, 2), null);
  assert.equal(bondMods({ bondId: 'bond_x_demo_none' }, 0), null);
});

test('unreadKeys: the behavioural half is reported, not silently dropped', () => {
  const keys = unreadKeys(REC).sort();
  assert.deepEqual(keys, ['base_prob', 'power_bond_char_cnt']);
});

test('install: members get one persistent buff per authored bond, refreshed on deploy and layer gain', () => {
  setGameData({ bonds: { [BOND]: REC } });
  const a = op(1, [BOND]);
  const b = op(2, ['yanShip']);
  const st = { [BOND]: { active: true, tier: 1, layers: 0 } };
  const bt = battle([a, b], st);
  install(bt);
  bt.fire('battleStart', {});
  assert.equal(a.buffs?.length, 1, 'member buffed');
  assert.equal(b.buffs?.length ?? 0, 0, 'non-member untouched');
  assert.equal(a.buffs[0].key, `bond:x:${BOND}`);
  assert.equal(a.buffs[0].persist, true);
  assert.equal(a.buffs[0].mods.atkPct, 0.1);

  st[BOND].layers = 2;
  bt.fire('layerGain', { pid: 'p1' });
  assert.equal(a.buffs.length, 2, 're-applied on layer gain');
  assert.ok(Math.abs(a.buffs[1].mods.atkPct - 0.2) < 1e-9);

  st[BOND].active = false;
  const c = op(3, [BOND]);
  bt.allyUnits.push(c);
  bt.fire('deploy', { unit: c });
  assert.equal(c.buffs?.length ?? 0, 0, 'inactive bond applies nothing');
});

test('install: official bonds are left to bonds/core.js and bonds/addon.js', () => {
  setGameData({ bonds: { yanShip: { bondId: 'yanShip', buffs: [{ key: 'env_gbuff_new', bb: { base_atk: 0.3 } }] } } });
  const a = op(1, ['yanShip']);
  const bt = battle([a], { yanShip: { active: true, tier: 3, layers: 5 } });
  install(bt);
  bt.fire('battleStart', {});
  assert.equal(a.buffs?.length ?? 0, 0);
});

test('install: authoring keys it cannot run are logged once, with the bond id', () => {
  setGameData({ bonds: { [BOND]: REC } });
  const bt = battle([op(1, [BOND])], { [BOND]: { active: true, tier: 1, layers: 0 } });
  install(bt);
  bt.fire('battleStart', {});
  const hits = bt.logs.filter((m) => m.includes(BOND));
  assert.equal(hits.length, 1, 'one line, not one per refresh');
  assert.match(hits[0], /base_prob/);
});
