// Forge 包自带的第二类 IN_BATTLE 特质：「每叠加N层」的属性读取器（COL_EQUIP_BASE_BY_BOND_LAYER /
// custom_scale_bonds_layers / act_gar_eff_takenReduceByBond）、护盾+技能加层（COL_SHIELD_AND_SKILL_LAYER）、
// 战斗开始复制身前干员特质（SERVER_COPY_FRONT_EFFECT_BATTLE）与额外触发（SERVER_EXTRA_TRIGGER_BATTLE_EFFECT /
// AVEMUJICA_EXTRA_TRIGGER）。全部用合成棋子 + 合成 garrison 记录，在默认数据源上只替换 chess / garrisons 两张表。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, checkInvariants } from '../helpers/battleHarness.js';
import { getDefaultSource, DataSource } from '../../server/sim/simdata.js';
import { frontOf } from '../../server/sim/dir.js';

const BOND = 'bond_x_demo_demoship';
const AVE_BOND = 'bond_x_ave_mujica_demo';

/** 合成一场战斗：units = [{ id, row, col, bonds?, garrisons?, charId?, items? }]。 */
function build({ units, bonds = {}, layerCount = 3 }) {
  const base = getDefaultSource();
  const chess = {};
  const garrisons = {};
  for (const u of units) {
    chess[u.id] = { ...chessRec({ id: u.id, bonds: u.bonds ?? [BOND], charId: u.charId ?? u.id }), garrisonIds: u.garrisons ?? [] };
    for (const g of u.recs ?? []) {
      garrisons[g.garrisonId] = { eventType: 'IN_BATTLE', name: g.garrisonId, desc: '测试特质', bb: {}, bbStr: {}, ...g };
    }
  }
  const data = new DataSource({ chess, garrisons }, base);
  const all = { ...bonds };
  for (const b of new Set(Object.values(chess).flatMap((c) => c.bonds ?? []))) {
    all[b] ??= { count: layerCount, active: layerCount >= 3, tier: 1, layers: 0 };
  }
  const h = makeBattle({
    data,
    units: units.map((u) => ({ chessId: u.id, row: u.row, col: u.col, ...(u.items ? { items: u.items } : {}) })),
    bonds: all,
    autoFinish: false,
    timeLimit: 300,
  });
  h.step(1);
  return h;
}

const rec = (garrisonId, key, bb = {}, bbStr = {}) => ({ garrisonId, effectKey: key, bb, bbStr });
const layersOf = (h, id = BOND) => h.b.getPlayer('p1').bonds[id]?.layers ?? 0;
const buffOf = (h, unitId, gid) => h.unit(unitId).findBuff(`gar:${gid}`);

test('custom_scale_bonds_layers: 每 per_layers 层 +atk%', () => {
  const h = build({
    units: [{
      id: 'op', row: 10, col: 4, garrisons: ['g1'],
      recs: [rec('g1', 'custom_scale_bonds_layers', { per_layers: 3, atk: 0.02 }, { bonds: BOND })],
    }],
    bonds: { [BOND]: { count: 9, active: true, tier: 1, layers: 9 } },
  });
  const b = buffOf(h, 'op', 'g1');
  assert.ok(b, 'the reader installed a passive buff');
  assert.ok(Math.abs(b.mods.atkPct - 0.06) < 1e-9, `atkPct ${b.mods.atkPct} == 3 steps × 2 %`);
  checkInvariants(h.b);
});

test('act_gar_eff_takenReduceByBond: 每 divide_num 层 受到的伤害降低', () => {
  const h = build({
    units: [{
      id: 'op', row: 10, col: 4, garrisons: ['g1'],
      recs: [rec('g1', 'act_gar_eff_takenReduceByBond', { divide_num: 1, taken_reduce: 0.001 }, { bond_id: BOND })],
    }],
    bonds: { [BOND]: { count: 10, active: true, tier: 1, layers: 10 } },
  });
  const b = buffOf(h, 'op', 'g1');
  assert.ok(b, 'the reader installed a passive buff');
  assert.ok(Math.abs(b.mods.dmgTakenMul - 0.99) < 1e-9, `dmgTakenMul ${b.mods.dmgTakenMul} == 1 − 10 × 0.1 %`);
  checkInvariants(h.b);
});

test('COL_EQUIP_BASE_BY_BOND_LAYER: 每 divide_num 层装备基础数值 +add，攻击速度 +装备数×%', () => {
  const itemId = Object.keys(getDefaultSource().raw.items ?? {}).find((id) => !id.endsWith('_b') && !id.includes('_e_'));
  const h = build({
    units: [{
      id: 'op', row: 10, col: 4, garrisons: ['g1'], items: [itemId],
      recs: [rec('g1', 'COL_EQUIP_BASE_BY_BOND_LAYER', { divide_num: 10, add: 0.001, aspd_per_item: 0.05 })],
    }],
    bonds: { [BOND]: { count: 20, active: true, tier: 1, layers: 20 } },
  });
  const b = buffOf(h, 'op', 'g1');
  assert.ok(b, 'the reader installed a passive buff');
  assert.ok(Math.abs(b.mods.atkPct - 0.002) < 1e-9, `atkPct ${b.mods.atkPct} == 2 steps × 0.1 %`);
  const baseAspd = h.unit('op').base.aspd;
  assert.equal(b.mods.aspd, Math.round(baseAspd * 0.05), 'ASPD +5 % for one carried item');
  checkInvariants(h.b);
});

test('COL_SHIELD_AND_SKILL_LAYER: 开战给自身与周围八格护盾，开技能给周围八格加层（至多 max 次）', () => {
  const h = build({
    units: [
      {
        id: 'op', row: 10, col: 4, garrisons: ['g1'],
        recs: [rec('g1', 'COL_SHIELD_AND_SKILL_LAYER', { shield: 1, shield_div: 20, layer: 4, max: 2 })],
      },
      { id: 'mate', row: 10, col: 5, garrisons: [] },
    ],
    bonds: { [BOND]: { count: 40, active: true, tier: 1, layers: 40 } },
  });
  const shieldOf = (id) => h.unit(id).findBuff('gar:g1:shield');
  assert.equal(shieldOf('op')?.shieldHits, 3, '1 layer + floor(40 / 20)');
  assert.equal(shieldOf('mate')?.shieldHits, 3, 'the neighbour standing next to it');
  const before = layersOf(h);
  for (let i = 0; i < 3; i++) h.b.emit('skillStart', { unit: h.unit('op') });
  assert.equal(layersOf(h), before + 8, 'two casts of +4 for the neighbour, the third is over `max`');
  checkInvariants(h.b);
});

test('SERVER_COPY_FRONT_EFFECT_BATTLE: 复制身前干员的战斗中特质', () => {
  const holder = { id: 'op', row: 10, col: 4, garrisons: ['g1'], recs: [rec('g1', 'SERVER_COPY_FRONT_EFFECT_BATTLE', { front_count: 1 })] };
  const probe = build({ units: [holder] });
  const [fr, fc] = frontOf(probe.unit('op').homeR, probe.unit('op').homeC, probe.unit('op').dir, 1);
  const h = build({
    units: [
      holder,
      {
        id: 'mate', row: fr, col: fc, garrisons: ['g2'],
        recs: [rec('g2', 'custom_gain_on_skill', { gain: 5 })],
      },
    ],
  });
  assert.equal(layersOf(h), 0);
  h.b.emit('skillStart', { unit: h.unit('op') });
  assert.equal(layersOf(h), 5, 'the holder now runs the trait of the operator in front of it');
  checkInvariants(h.b);
});

test('SERVER_EXTRA_TRIGGER_BATTLE_EFFECT: 其他干员触发特质时额外触发，每名干员至多 max_count 次', () => {
  const h = build({
    units: [
      { id: 'op', row: 10, col: 4, garrisons: ['g1'], recs: [rec('g1', 'SERVER_EXTRA_TRIGGER_BATTLE_EFFECT', { extra_trigger: 1, max_count: 1 })] },
      { id: 'mate', row: 11, col: 4, garrisons: ['g2'], recs: [rec('g2', 'custom_gain_on_skill', { gain: 1 })] },
    ],
  });
  h.b.emit('skillStart', { unit: h.unit('mate') });
  assert.equal(layersOf(h), 2, 'the mate\'s own +1 fires once more');
  h.b.emit('skillStart', { unit: h.unit('mate') });
  assert.equal(layersOf(h), 3, 'the allowance is spent after one extra trigger');
  checkInvariants(h.b);
});

test('AVEMUJICA_EXTRA_TRIGGER: 颂乐人偶触发特质额外触发，丰川祥子触发时全队加层', () => {
  const h = build({
    units: [
      {
        id: 'op', row: 10, col: 4, bonds: [AVE_BOND], garrisons: ['g1'],
        recs: [rec('g1', 'AVEMUJICA_EXTRA_TRIGGER', { extra_trigger: 1, partner_layers: 1 }, { partner: 'oblivionis' })],
      },
      {
        id: 'mate', row: 11, col: 4, bonds: [AVE_BOND], charId: 'oblivionis', garrisons: ['g2'],
        recs: [rec('g2', 'custom_gain_on_skill', { gain: 1 })],
      },
    ],
    bonds: { [AVE_BOND]: { count: 3, active: true, tier: 1, layers: 0 } },
  });
  h.b.emit('skillStart', { unit: h.unit('mate') });
  // 丰川祥子's trigger: +1 (own) +1 (extra trigger) on the mate, then +1 for every 颂乐人偶 operator (both of them)
  assert.equal(layersOf(h, AVE_BOND), 4, 'own 1 + extra 1 + partner 1 for each of the two operators');
  checkInvariants(h.b);
});
