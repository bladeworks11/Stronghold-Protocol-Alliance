// Forge 包自带的特质（garrison）效果键：COL_* / custom_* / 工作坊风格 SERVER_*，引擎侧实现的几条。
// 每个 handler 都是纯函数式的 ctx 读取，这里用最小假 ctx 直接调用，断言“加了几层、发了几件、加了哪些 bond”。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDLERS } from '../../server/sim/content/garrisons/meta.js';

const BOND = 'bond_x_demo_demoship';
const OTHER = 'bond_x_demo_others';

/** 记录 addLayers / grantItem 的假 prep ctx。pieces: 棋盘视图，按 id 区分的棋子记录 → bond 列表。 */
function fakeCtx({ items = 0, board = [], chess = {}, count = 1, gain = 1, bbStr = {}, shopLevel = 6 } = {}) {
  const layers = [], granted = [], rolled = [];
  const self = { uid: 1, kind: 'chess', id: 'chess_self', area: 'board', row: 2, col: 2, tier: 3, items: Array.from({ length: items }, (_, i) => ({ id: `it${i}` })) };
  const ctx = {
    source: { piece: self, garrisonId: 'g', garrison: { desc: '使已激活的【示例】层数+N' }, bb: { count, gain }, bbStr },
    gd: { bondIds: [BOND, OTHER], tierOf: () => 1 },
    board: () => [self, ...board],
    hand: () => [],
    piece: (uid) => (uid === 1 ? self : null),
    chessRecord: (id) => ({ bonds: chess[id] ?? [] }),
    pieceBonds: undefined,
    bondActive: () => true,
    layers: () => 0,
    addLayers: (bond, n, opts) => { layers.push([bond, n, opts]); return n; },
    shopLevel: () => shopLevel,
    rollItem: (o) => { rolled.push(o); return 'chess_item_x'; },
    grantItem: (id) => { granted.push(id); },
    rng: () => 0.5,
    roundStats: () => ({ refreshes: 0, buys: 0, sells: 0, spent: 0 }),
    data: { bonds: {}, choices: { pools: {} } },
  };
  return { ctx, layers, granted, rolled, self };
}

test('COL_ADD_BOND_BY_EQUIP_COUNT: 每携带1件装备加 N 层，只加记录里点名的盟约', () => {
  const { ctx, layers } = fakeCtx({ items: 3, count: 3, bbStr: { bond: BOND } });
  HANDLERS.COL_ADD_BOND_BY_EQUIP_COUNT.run(ctx);
  assert.deepEqual(layers, [[BOND, 9, { requireActive: true }]]);

  const none = fakeCtx({ items: 0, count: 3, bbStr: { bond: BOND } });
  HANDLERS.COL_ADD_BOND_BY_EQUIP_COUNT.run(none.ctx);
  assert.deepEqual(none.layers, []);
});

test('SERVER_ADD_ACT_BOND_LAYER_BY_BOARD_BOND_CHAR: 场上不同干员数 × N，同一干员只算一次', () => {
  const board = [
    { uid: 2, kind: 'chess', id: 'chess_b' },
    { uid: 3, kind: 'chess', id: 'chess_b' },
    { uid: 4, kind: 'chess', id: 'chess_c' },
    { uid: 5, kind: 'chess', id: 'chess_other' },
  ];
  const { ctx, layers } = fakeCtx({
    board, count: 2, bbStr: { bond_id: BOND },
    chess: { chess_b: [BOND], chess_c: [BOND], chess_other: [OTHER] },
  });
  HANDLERS.SERVER_ADD_ACT_BOND_LAYER_BY_BOARD_BOND_CHAR.run(ctx);
  assert.deepEqual(layers, [[BOND, 4, { requireActive: true }]]);
});

test('custom_gain_layers_prep_end_by_tiers: 不同阶数 × gain，同阶多名只算一次', () => {
  const board = [
    { uid: 2, kind: 'chess', id: 'chess_t1', tier: 1 },
    { uid: 3, kind: 'chess', id: 'chess_t2', tier: 2 },
    { uid: 4, kind: 'chess', id: 'chess_t2b', tier: 2 },
  ];
  const { ctx, layers } = fakeCtx({
    board, gain: 2, bbStr: { bond: BOND },
    chess: { chess_t1: [BOND], chess_t2: [BOND], chess_t2b: [BOND] },
  });
  HANDLERS.custom_gain_layers_prep_end_by_tiers.run(ctx);
  assert.deepEqual(layers, [[BOND, 4, { requireActive: true }]]);
});

test('COL_GAIN_RANDOM_EQUIP: 按调度中心阶级发 count 件，item 记录不存在时不发/不多发', () => {
  const { ctx, granted, rolled } = fakeCtx({ count: 2 });
  HANDLERS.COL_GAIN_RANDOM_EQUIP.run(ctx);
  assert.deepEqual(granted, ['chess_item_x', 'chess_item_x']);
  assert.deepEqual(rolled, [{ maxTier: 6 }, { maxTier: 6 }]);
});

test('记录没有写明盟约时不做任何猜测（no-op）', () => {
  const eq = fakeCtx({ items: 3, count: 3, bbStr: {} });
  HANDLERS.COL_ADD_BOND_BY_EQUIP_COUNT.run(eq.ctx);
  assert.deepEqual(eq.layers, []);

  const prep = fakeCtx({ gain: 2, bbStr: {} });
  HANDLERS.custom_gain_layers_prep_end_by_tiers.run(prep.ctx);
  assert.deepEqual(prep.layers, []);

  const chars = fakeCtx({ count: 2, bbStr: {} });
  HANDLERS.SERVER_ADD_ACT_BOND_LAYER_BY_BOARD_BOND_CHAR.run(chars.ctx);
  assert.deepEqual(chars.layers, []);
});
