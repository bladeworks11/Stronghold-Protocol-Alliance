// test/match/unite-capacity.test.js — a 联防 round may run several waves in a large room.
// Ported in spirit from LongQianChen/Stronghold-Protocol feat/IncreasePlayerCapacity.
//
// What this pins down:
//   * the wave count is the OPENING card-pool group count (1–5), so a twenty-player room uses up to ten different
//     perfect players instead of two, and a helper never fights twice in one round;
//   * only two helpers fight per wave (a battle field holds two), and the whole-room ranking decides both the pairs
//     and their order;
//   * the enemies still standing after a wave are carried into the next one with their source player, stats and
//     bounty, and a wave that cleared the field ends the round;
//   * settlement keeps every finished wave's rewards (settle.js sums the plan's history) and bills the last wave.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { helperOrder, planUnite, nextUnitePlan, uniteRemainingLeaks, uniteReserveHelpers, plannedUniteSurvivors } from '../../server/match/unite.js';
import { MAX_UNITE_HELPERS } from '../../shared/playerCapacity.js';

const gd = { unite: { maxHelpers: 2 }, enemy: (key) => ({ key }) };

/** A perfect player stub: `units` deployed, one active bond with `layers`, nothing lost. */
const player = (id, seat, units = 3, layers = 1) => ({
  playerId: id, seat, name: id, deployCount: units, alive: true, left: false,
  board: new Map(), pendingLayerGains: null,
  layers: { yanShip: layers },
  bonds: { yanShip: { active: true, layers } },
});
const perfects = (n, units = 3) => Array.from({ length: n }, (_, i) => player(`p_${i}`, i, units));

/** One counted leak row as BattleResult carries it. */
const leak = (sourcePlayerId, enemyKey, mods = null, tag = null) => ({ enemyKey, mods, lpr: 1, sourcePlayerId, tag, counted: true });

/** A 联防 battle result whose counted leaks are `leaks`, attributed to the players listed in `by`. */
const waveResult = (leaks, { unspawned = [], by = 'helper' } = {}) => ({
  reason: 'timeout', time: 60, leaked: leaks, unspawned,
  perPlayer: leaks.length || unspawned.length ? { [by]: { killed: 0, total: leaks.length, leaked: leaks, coins: 0 } } : {},
});

/** A running plan as planUnite builds it, with `reserve` waiting helpers. */
const makePlan = (reserve, over = {}) => ({
  helpers: [player('p_h0', 100), player('p_h1', 101)],
  reserveHelpers: reserve,
  leakers: [player('p_l', 9)],
  leaked: [leak('p_l', 'enemy_1007_slime')],
  notReentered: new Map(),
  round: 1, perRound: 2, roundsMax: 3, history: [], usedHelpers: [],
  ...over,
});

test('a small room keeps the original two helpers: one wave, two fighters', () => {
  assert.equal(helperOrder({ gd }, perfects(10), new Map(), 1).length, 2, 'one wave ⇒ exactly two helpers');
  assert.equal(helperOrder({ gd }, perfects(10), new Map()).length, 2, 'the default is one wave');
});

test('the helper pool grows with the wave count, never above ten, and pairs follow the whole-room ranking', () => {
  const ps = perfects(12);
  assert.equal(helperOrder({ gd }, ps, new Map(), 1).length, 2);
  assert.equal(helperOrder({ gd }, ps, new Map(), 3).length, 6, 'three waves ⇒ three pairs');
  assert.equal(helperOrder({ gd }, ps, new Map(), 5).length, MAX_UNITE_HELPERS, 'five waves ⇒ the ten-helper ceiling');
  assert.equal(helperOrder({ gd }, ps, new Map(), 99).length, MAX_UNITE_HELPERS, 'never above ten');
  // identical players ⇒ pure seat order, pairs and all
  assert.deepEqual(helperOrder({ gd }, ps, new Map(), 5).map((p) => p.playerId),
    ['p_0', 'p_1', 'p_2', 'p_3', 'p_4', 'p_5', 'p_6', 'p_7', 'p_8', 'p_9']);
  // fewer perfect players than slots: the plan uses what is there
  assert.equal(helperOrder({ gd }, perfects(3), new Map(), 5).length, 3);
});

test('the ranking decides the pairs: the strongest fight first, ties fall back to seat order', () => {
  const order = helperOrder({ gd }, [player('p_0', 0, 1), player('p_1', 1, 5), player('p_2', 2, 5), player('p_3', 3, 9)], new Map(), 2);
  assert.deepEqual(order.map((p) => p.playerId), ['p_3', 'p_1', 'p_2', 'p_0'],
    'strongest first; the p_1/p_2 tie resolves by seat inside the pair, then p_0');
});

test('planUnite: waves come from the opening group count; only two helpers fight in the first wave', () => {
  const leaker = player('p_l', 9, 2);
  const results = new Map([['p_l', { leaked: [leak('p_l', 'enemy_1007_slime'), leak('p_l', 'enemy_1007_slime')], perfect: false }]]);
  // ten perfect players: enough for the full ten-helper pool, i.e. the five-wave ceiling
  const ten = perfects(10);
  for (const ps of ten) results.set(ps.playerId, { leaked: [], perfect: true });
  const mk = (groups, alive = ten) => ({
    isSolo: false, gd, alivePlayers: () => [leaker, ...alive],
    poolGroups: Array.from({ length: groups }, (_, i) => ({ id: i + 1, playerIds: [] })),
  });
  const one = planUnite(mk(1), results);
  assert.equal(one.roundsMax, 1, 'a one-group room runs a single wave');
  assert.equal(one.helpers.length, 2);
  assert.equal(one.reserveHelpers.length, 0, 'nobody waits when only one wave may run');
  const five = planUnite(mk(5), results);
  assert.equal(five.roundsMax, 5, 'a five-group (twenty-player) room may run five waves');
  assert.equal(five.helpers.length, 2, 'still two helpers on the field');
  assert.equal(five.reserveHelpers.length, 8, 'the other eight perfect players wait their turn');
  assert.equal(five.leaked.length, 2, 'both leaks enter the first wave');
  assert.equal(five.round, 1);
  assert.deepEqual(five.history, []);
  assert.deepEqual(five.usedHelpers, []);
  // a room with only three perfect players cannot fill five waves: the plan shortens to what is available
  const three = new Map([['p_l', { leaked: [leak('p_l', 'enemy_1007_slime')], perfect: false }]]);
  for (const ps of perfects(3)) three.set(ps.playerId, { leaked: [], perfect: true });
  const small = planUnite(mk(5, perfects(3)), three);
  assert.equal(small.roundsMax, 2, 'three helpers ⇒ two waves at most');
});

test('nextUnitePlan carries the survivors into the next wave with their source, stats and bounty', () => {
  const plan = makePlan([player('p_2', 2), player('p_3', 3), player('p_4', 4)], {
    leaked: [leak('p_l', 'enemy_1007_slime', { hpMul: 1.2 }), leak('p_l', 'enemy_1422_lrsldr', null, 'N')],
  });
  // the wave killed the slime; the lrsldr is still standing
  const res = waveResult([leak('p_l', 'enemy_1422_lrsldr', null, 'N')]);
  const next = nextUnitePlan(plan, res);
  assert.ok(next, 'another wave runs while enemies remain');
  assert.equal(next.round, 2);
  assert.deepEqual(next.helpers.map((p) => p.playerId), ['p_2', 'p_3'], 'the next unused pair fights');
  assert.deepEqual(next.reserveHelpers.map((p) => p.playerId), ['p_4']);
  assert.equal(next.leaked.length, 1, 'only the survivor re-enters');
  assert.equal(next.leaked[0].enemyKey, 'enemy_1422_lrsldr');
  assert.equal(next.leaked[0].sourcePlayerId, 'p_l', 'the source player is kept');
  assert.equal(next.leaked[0].tag, 'N');
  assert.equal(next.history.length, 1, 'the finished wave is remembered for settlement');
  assert.deepEqual(next.usedHelpers.map((p) => p.playerId), ['p_h0', 'p_h1'], 'helpers never repeat');
  // a survivor that lost its mods on the way recovers them from the original spawn
  const bare = nextUnitePlan(plan, waveResult([{ enemyKey: 'enemy_1007_slime', sourcePlayerId: 'p_l', counted: true }]));
  assert.deepEqual(bare.leaked[0].mods, { hpMul: 1.2 }, 'the original stats travel with the enemy');
});

test('the round ends when the field is clear, the helpers run out, or the opening wave limit is reached', () => {
  const base = makePlan([player('p_2', 2), player('p_3', 3)]);
  assert.equal(nextUnitePlan(base, waveResult([])), null, 'nothing left standing ⇒ done');
  assert.equal(nextUnitePlan(base, { ...waveResult([leak('p_l', 'enemy_1007_slime')]), synthetic: true }), null,
    'a synthetic result never starts another wave');
  assert.equal(nextUnitePlan({ ...base, reserveHelpers: [] }, waveResult([leak('p_l', 'enemy_1007_slime')])), null,
    'no unused helper left');
  // the plan allows three waves; `round` is the wave now running, so wave 4 is the last one and wave 5 does not exist
  const fourth = nextUnitePlan({ ...base, round: 3 }, waveResult([leak('p_l', 'enemy_1007_slime')]));
  assert.ok(fourth, 'wave 3 may be followed by wave 4');
  assert.equal(fourth.round, 4);
  assert.equal(nextUnitePlan({ ...base, round: 4 }, waveResult([leak('p_l', 'enemy_1007_slime')])), null,
    'the wave limit is reached');
  // a departed or eliminated helper is skipped
  const gone = { ...base, reserveHelpers: [{ ...player('p_2', 2), left: true }, player('p_3', 3)] };
  assert.deepEqual(uniteReserveHelpers(gone).map((p) => p.playerId), ['p_3']);
  assert.equal(nextUnitePlan(gone, waveResult([leak('p_l', 'enemy_1007_slime')])).helpers[0].playerId, 'p_3');
});

test('unspawned enemies re-enter; leaks of a player that is not a leaker are ignored', () => {
  const plan = makePlan([player('p_2', 2), player('p_3', 3)], {
    leakers: [player('p_l', 9), player('p_m', 8)],
    leaked: [leak('p_l', 'enemy_1007_slime'), leak('p_m', 'enemy_1422_lrsldr')],
    notReentered: new Map([['p_m', 2]]),
  });
  // the wave never spawned p_m's lrsldr
  const next = nextUnitePlan(plan, waveResult([], { unspawned: [{ enemyKey: 'enemy_1422_lrsldr', sourcePlayerId: 'p_m' }] }));
  assert.ok(next);
  assert.deepEqual(next.leaked.map((l) => `${l.sourcePlayerId}:${l.enemyKey}`), ['p_m:enemy_1422_lrsldr']);
  // the planned count includes the leaks that could not re-enter at all
  const planned = plannedUniteSurvivors(plan);
  assert.equal(planned.get('p_m'), 3, 'two un-reentered leaks plus the lrsldr');
  assert.equal(planned.get('p_l'), 1);
  // an unrelated player's leak in the result is never carried
  assert.deepEqual(uniteRemainingLeaks(plan, waveResult([leak('p_other', 'enemy_1007_slime')])), []);
});

test('a round runs wave after wave until the field is clear, and no helper ever fights twice', () => {
  // `roundsMax` is set by planUnite from the opening group count; five waves need the full ten-helper pool
  const reserve = Array.from({ length: 10 }, (_, i) => player(`p_${i + 2}`, i + 2));
  let plan = makePlan(reserve, { roundsMax: 5 });
  const seen = new Set(plan.helpers.map((p) => p.playerId));
  let waves = 0;
  // every wave leaves one enemy behind, so only the wave limit can stop the round
  for (let i = 0; i < 8; i++) {
    const next = nextUnitePlan(plan, waveResult([leak('p_l', 'enemy_1007_slime')]));
    if (!next) break;
    waves++;
    for (const ps of next.helpers) {
      assert.ok(!seen.has(ps.playerId), `${ps.playerId} fought twice`);
      seen.add(ps.playerId);
    }
    plan = next;
  }
  assert.equal(waves, 5, 'roundsMax = 5 runs five waves, not four');
  assert.equal(plan.round, 6, 'the round counter passed the limit');
  assert.equal(plan.history.length, 5, 'every wave is kept for settlement');
  // this plan was built by hand, so it is not limited by planUnite's ten-helper selection (see the test below)
  assert.equal(seen.size, 12, 'two helpers per wave, twelve different fighters across six waves, none repeated');
  assert.equal(plan.reserveHelpers.length, 0, 'the reserve is spent');
  // six waves happened because this hand-built plan supplied twelve helpers; the wave cap stopped the seventh
  assert.equal(nextUnitePlan(plan, waveResult([leak('p_l', 'enemy_1007_slime')])), null, 'the wave limit stops it');
});

test('the helper ceiling caps the planned waves even when more fighters are available', () => {
  const leaker = player('p_l', 9, 2);
  const results = new Map([['p_l', { leaked: [leak('p_l', 'enemy_1007_slime')], perfect: false }]]);
  const many = perfects(20);
  for (const ps of many) results.set(ps.playerId, { leaked: [], perfect: true });
  const plan = planUnite({
    isSolo: false, gd, alivePlayers: () => [leaker, ...many],
    poolGroups: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, playerIds: [] })),
  }, results);
  assert.equal(plan.roundsMax, 5, 'ten helpers / two per wave = five waves');
  assert.equal(plan.helpers.length + plan.reserveHelpers.length, 10, 'the plan never selects more than ten helpers');
});

test('helpers run out before the wave limit when the room has few perfect players', () => {
  // one wave of two plus one spare: the second wave happens, the third cannot
  let plan = makePlan([player('p_2', 2)], { roundsMax: 5 });
  const second = nextUnitePlan(plan, waveResult([leak('p_l', 'enemy_1007_slime')]));
  assert.ok(second, 'a spare helper still forms the next pair');
  assert.equal(second.helpers.length, 1, 'a lone helper fights alone');
  assert.deepEqual(second.reserveHelpers, []);
  assert.equal(nextUnitePlan(second, waveResult([leak('p_l', 'enemy_1007_slime')])), null, 'nobody left to send');
});
