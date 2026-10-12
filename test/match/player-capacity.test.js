// test/match/player-capacity.test.js — fixed card-pool groups for larger co-op rooms.
// Ported in spirit from LongQianChen/Stronghold-Protocol feat/IncreasePlayerCapacity.
//
// What this pins down:
//   * up to five players share ONE pool, i.e. exactly the original 1–4 player game (a 5-player room gets the slightly
//     larger five-player pool); six or more split into fixed groups of three, four or five in seat order;
//   * every group has its own shared chess pool and its own shared equipment stock, and a seat always resolves to the
//     group it started in (elimination and departure never reshuffle it);
//   * a three- or four-player group keeps the complete original copies; only a five-player group expands by 1.25,
//     with tier III floored (the measured 「5人 III 阶 = 45」 value);
//   * two seats of DIFFERENT groups cannot take each other's copies, while two seats of the SAME group still share.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { poolGroupSizes, poolCopyScale, uniteRoundLimit, coopHiddenLayerThreshold, GROUPED_POOL_MIN_PLAYERS } from '../../shared/playerCapacity.js';
import { createPoolGroups } from '../../server/match/pool.js';
import { GameData } from '../../server/match/gamedata.js';
import { DATA, makeMatch, checkInvariants } from './harness.js';

const seatsOf = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: false, connected: true }));
const gdFor = () => new GameData(DATA, 'mode_multi_normal');

test('group layout: one pool up to five players, fixed three/four/five groups from six on', () => {
  for (let n = 1; n <= 5; n++) assert.deepEqual(poolGroupSizes(n), [n], `${n} players share one pool`);
  assert.equal(GROUPED_POOL_MIN_PLAYERS, 6);
  const expected = {
    6: [3, 3], 7: [4, 3], 8: [4, 4], 9: [4, 5], 10: [4, 3, 3], 11: [4, 4, 3], 12: [4, 4, 4],
    13: [5, 4, 4], 14: [4, 4, 3, 3], 15: [4, 4, 4, 3], 16: [4, 4, 4, 4], 17: [5, 4, 4, 4],
    18: [4, 4, 4, 3, 3], 19: [4, 4, 4, 4, 3], 20: [4, 4, 4, 4, 4],
  };
  for (const [n, layout] of Object.entries(expected)) {
    const got = poolGroupSizes(Number(n));
    assert.deepEqual(got, layout, `${n} players`);
    assert.equal(got.reduce((a, b) => a + b, 0), Number(n), `${n} players: the groups cover every seat`);
    for (const size of got) assert.ok(size >= 3 && size <= 5, `${n} players: group size ${size} is 3–5`);
  }
  assert.throws(() => poolGroupSizes(0), RangeError);
  assert.throws(() => poolGroupSizes(21), RangeError);
  assert.throws(() => poolGroupSizes(2.5), RangeError);
  // a caller cannot mutate later matches through the returned array
  const a = poolGroupSizes(10);
  a[0] = 99;
  assert.deepEqual(poolGroupSizes(10), [4, 3, 3]);
});

test('copy scale: three- and four-player groups keep the original pool, only a five-player group expands', () => {
  assert.equal(poolCopyScale(3), 1);
  assert.equal(poolCopyScale(4), 1);
  assert.equal(poolCopyScale(5), 1.25);
});

test('createPoolGroups: one group for a small room, seat-ordered groups for a large one, each with its own pools', () => {
  const gd = gdFor();
  const small = createPoolGroups(gd, seatsOf(4), { banned: [] });
  assert.equal(small.length, 1);
  assert.deepEqual(small[0].playerIds, ['p_0', 'p_1', 'p_2', 'p_3']);
  assert.equal(small[0].scale, 1);
  assert.ok(small[0].pool instanceof Object && small[0].itemPool);

  const five = createPoolGroups(gd, seatsOf(5), { banned: [] });
  assert.equal(five.length, 1);
  assert.equal(five[0].scale, 1.25, 'a five-player room gets the expanded pool');

  const twenty = createPoolGroups(gd, seatsOf(20), { banned: [] });
  assert.equal(twenty.length, 5);
  assert.deepEqual(twenty.map((g) => g.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(twenty.map((g) => g.playerIds.length), [4, 4, 4, 4, 4]);
  assert.deepEqual(twenty.map((g) => g.scale), [1, 1, 1, 1, 1]);
  // seat order, not array order: a shuffled `order` still groups by seat
  const shuffled = createPoolGroups(gd, [seatsOf(6)[5], seatsOf(6)[0], seatsOf(6)[3], seatsOf(6)[1], seatsOf(6)[4], seatsOf(6)[2]], { banned: [] });
  assert.deepEqual(shuffled.map((g) => g.playerIds), [['p_0', 'p_1', 'p_2'], ['p_3', 'p_4', 'p_5']]);
  // nine players: the five-player group is the expanded one
  const nine = createPoolGroups(gd, seatsOf(9), { banned: [] });
  assert.deepEqual(nine.map((g) => g.playerIds.length), [4, 5]);
  assert.deepEqual(nine.map((g) => g.scale), [1, 1.25]);
});

test('copies: a group keeps the full original pool; the five-player group is 1.25× with tier III floored', () => {
  const gd = gdFor();
  const [g4] = createPoolGroups(gd, seatsOf(4), { banned: [] });
  const [g5] = createPoolGroups(gd, seatsOf(5), { banned: [] });
  // find one chess of each tier to compare against the unscaled gd.poolCopies
  const byTier = new Map();
  for (const id of gd.visibleChess) {
    const t = gd.tierOf(id);
    if (!byTier.has(t)) byTier.set(t, id);
  }
  for (const [tier, id] of byTier) {
    const base = gd.poolCopies(id);
    assert.equal(g4.pool.cap(id), base, `tier ${tier}: a four-player group keeps the original ${base}`);
    const scaled = base * 1.25;
    const want = tier === 3 ? Math.floor(scaled) : Math.ceil(scaled);
    assert.equal(g5.pool.cap(id), want, `tier ${tier}: the five-player group is ${want}`);
  }
  const tier3 = byTier.get(3);
  assert.equal(g5.pool.cap(tier3), 45, 'the measured 5人 III 阶 value');
  // equipment stock scales the same way
  const eq = Object.values(DATA.items || {}).find((it) => it && it.tier === 1 && !it.isGolden);
  if (eq) {
    const id = Object.keys(DATA.items).find((k) => DATA.items[k] === eq);
    assert.equal(g4.itemPool.cap(id), gd.itemPoolCopies(id), 'four-player group: the original equipment stock');
    assert.equal(g5.itemPool.cap(id), Math.ceil(gd.itemPoolCopies(id) * 1.25), 'five-player group: expanded stock');
  }
});

test('groups do not compete: different groups have separate pools, one group shares its own', () => {
  const gd = gdFor();
  const groups = createPoolGroups(gd, seatsOf(8), { banned: [] });
  assert.equal(groups.length, 2);
  const id = gd.visibleChess[0];
  const capA = groups[0].pool.cap(id);
  // take one copy in group 1
  assert.equal(groups[0].pool.take(id, 1), 1);
  assert.equal(groups[0].pool.left(id), capA - 1, 'group 1 lost a copy');
  assert.equal(groups[1].pool.left(id), groups[1].pool.cap(id), 'group 2 is untouched');
  // the same group shares: a second member of group 1 sees the deficit through the same pool object
  assert.equal(groups[0].pool.left(id), capA - 1);
  // returning goes back to the owner's group only
  assert.equal(groups[0].pool.give(id, 1), 1);
  assert.equal(groups[0].pool.left(id), capA);
});

test('a real eight-player match is two independent groups; seats keep their group and invariants hold', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: seatsOf(8), seed: 11, fake: true });
  h.start();
  h.runToPhase('PREP');
  const m = h.m;
  assert.equal(m.poolGroups.length, 2, 'eight players ⇒ two groups');
  assert.deepEqual(m.poolGroups.map((g) => g.playerIds), [['p_0', 'p_1', 'p_2', 'p_3'], ['p_4', 'p_5', 'p_6', 'p_7']]);
  for (const ps of m.order) {
    const g = m.poolGroupFor(ps);
    assert.equal(ps.pool, g.pool, `${ps.playerId} rolls in its own group's pool`);
    assert.equal(ps.itemPool, g.itemPool, `${ps.playerId} buys from its own group's stock`);
    assert.ok(g.playerIds.includes(ps.playerId));
  }
  // the two pools are distinct objects with the same (unscaled) capacity
  assert.notEqual(m.poolGroups[0].pool, m.poolGroups[1].pool);
  const id = m.gd.visibleChess[0];
  assert.equal(m.poolGroups[0].pool.cap(id), m.poolGroups[1].pool.cap(id));
  // a seat keeps the group it started in: the resolution depends on the OPENING seat order only, never on who is
  // still alive, so an eliminated or departed seat still finds its own pool (and its copies go back there)
  h.invariants();
  const target = m.order[7];
  const group = m.poolGroupFor(target);
  assert.equal(group.id, 2);
  for (const ps of m.order) {
    assert.equal(m.poolFor(ps.playerId), m.poolGroupFor(ps).pool, `${ps.playerId}: string and object resolve alike`);
  }
  assert.equal(m.poolFor(target.playerId), group.pool);
  assert.ok(group.playerIds.includes(target.playerId));
  assert.equal(m.poolGroupFor('p_unknown').id, 1, 'an unknown id falls back to the first group');
});

test('a real twenty-player match is five groups and every seat resolves to exactly one of them', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', seats: seatsOf(20), seed: 5, fake: true });
  h.start();
  h.runToPhase('PREP');
  const m = h.m;
  assert.equal(m.poolGroups.length, 5);
  const memberCount = new Map();
  for (const ps of m.order) {
    const g = m.poolGroupFor(ps);
    assert.ok(g.playerIds.includes(ps.playerId), `${ps.playerId} resolves to a group that contains it`);
    memberCount.set(g.id, (memberCount.get(g.id) || 0) + 1);
  }
  assert.equal(memberCount.size, 5, 'every group holds at least one seat');
  for (const [id, n] of memberCount) assert.equal(n, 4, `group ${id} has four members`);
  // the groups partition the seats: no seat appears in two groups
  const all = m.poolGroups.flatMap((g) => g.playerIds);
  assert.equal(all.length, 20);
  assert.equal(new Set(all).size, 20, 'no seat is in two groups');
  assert.equal(m.pool, m.poolGroups[0].pool, 'the compatibility handle points at the first group');
  h.invariants();
});

test('phase helpers grow with the opening group count', () => {
  assert.equal(uniteRoundLimit(1), 1);
  assert.equal(uniteRoundLimit(2), 2);
  assert.equal(uniteRoundLimit(5), 5);
  assert.equal(uniteRoundLimit(9), 5, 'never above the five-wave ceiling');
  assert.equal(uniteRoundLimit(0), 1);
  assert.equal(uniteRoundLimit(undefined), 1);
  // hidden-core layers keep the original <=4 requirement, proportionally more beyond
  assert.equal(coopHiddenLayerThreshold(12, 4), 12);
  assert.equal(coopHiddenLayerThreshold(12, 8), 24);
  assert.equal(coopHiddenLayerThreshold(12, 20), 60);
});
