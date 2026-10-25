// Forge 包自带的 IN_BATTLE 特质（COL_* / custom_* / AVEMUJICA_* / act_gar_*）：战斗内「为已激活的【X】加层、按事件触发」。
// 合成棋子 + 合成 garrison 记录（默认数据源上只替换 chess/garrisons 两张表），直接触发战斗事件，
// 断言战斗内层数落到 ps.bonds.layers。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, checkInvariants } from '../helpers/battleHarness.js';
import { getDefaultSource, DataSource } from '../../server/sim/simdata.js';

const BOND = 'bond_x_demo_demoship';
const GID = 'garrison_x_demo_trait_a';

/** 一名带 IN_BATTLE 特质的合成干员，所属盟约已激活。 */
function make(trait, { layers = 0, count = 3 } = {}) {
  const base = getDefaultSource();
  const data = new DataSource({
    chess: { op: { ...chessRec({ id: 'op', bonds: [BOND] }), garrisonIds: [GID] } },
    garrisons: {
      [GID]: { garrisonId: GID, effectKey: trait.key, eventType: 'IN_BATTLE', name: GID, desc: '测试特质', bb: trait.bb ?? {}, bbStr: trait.bbStr ?? {} },
    },
  }, base);
  const h = makeBattle({
    data,
    units: [{ chessId: 'op', row: 10, col: 4 }],
    bonds: { [BOND]: { count, active: count >= 3, tier: 1, layers } },
    autoFinish: false,
    timeLimit: 300,
  });
  h.step(1);
  return h;
}

const layersOf = (h) => h.b.getPlayer('p1').bonds[BOND].layers ?? 0;

test('custom_gain_on_skill: 每次技能 +gain 层', () => {
  const h = make({ key: 'custom_gain_on_skill', bb: { gain: 2 } });
  const op = h.unit('op');
  assert.equal(layersOf(h), 0);
  h.b.emit('skillStart', { unit: op });
  assert.equal(layersOf(h), 2);
  h.b.emit('skillStart', { unit: op });
  assert.equal(layersOf(h), 4);
  checkInvariants(h.b);
});

test('custom_gain_first_skill: 只有第一次技能加层', () => {
  const h = make({ key: 'custom_gain_first_skill', bb: { gain: 5 } });
  const op = h.unit('op');
  h.b.emit('skillStart', { unit: op });
  h.b.emit('skillStart', { unit: op });
  assert.equal(layersOf(h), 5);
  checkInvariants(h.b);
});

test('custom_gain_on_kills: 每 per_kills 次击杀 +gain 层', () => {
  const h = make({ key: 'custom_gain_on_kills', bb: { per_kills: 2, gain: 3 } });
  const op = h.unit('op');
  const victim = { side: 'enemy', kind: 'enemy', id: 999 };
  h.b.emit('kill', { killer: op, victim });
  assert.equal(layersOf(h), 0);
  h.b.emit('kill', { killer: op, victim });
  assert.equal(layersOf(h), 3);
  checkInvariants(h.b);
});

test('act_gar_event_onhurt_add_bond_layer: 受击加层，且 max_count 封顶', () => {
  const h = make({ key: 'act_gar_event_onhurt_add_bond_layer', bb: { bond_add_count: 5, max_count: 2 }, bbStr: { bond_type: 'bond_self', bond_add_type: 'by_count' } });
  const op = h.unit('op');
  h.b.emit('damaged', { target: op });
  assert.equal(layersOf(h), 2);
  h.b.emit('damaged', { target: op });
  assert.equal(layersOf(h), 2);
  checkInvariants(h.b);
});

test('COL_START_OWN_BOND_NOACT: 开战时给已激活的己方盟约加 count 层', () => {
  const h = make({ key: 'COL_START_OWN_BOND_NOACT', bb: { count: 2 } }, { layers: 0 });
  assert.equal(layersOf(h), 2);
  checkInvariants(h.b);
});

test('没有写明盟约 id 的包特质打在携带者自己的盟约上（而不是什么都不加）', () => {
  const h = make({ key: 'custom_gain_on_heal', bb: { gain: 1 } });
  const op = h.unit('op');
  h.b.emit('heal', { source: op, target: op, amount: 10 });
  assert.equal(layersOf(h), 1);
  checkInvariants(h.b);
});
