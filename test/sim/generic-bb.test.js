// Generic kit: the blackboard keys a Forge-authored operator can rely on — multi-hit (`hits`), a hit that slows and
// burns (`move_speed` < 0, `dot` + `interval`), a bare `shield`, and `cc_duration` for the skill's own control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec } from '../helpers/battleHarness.js';
import { genericSkillSpec } from '../../server/sim/content/generic.js';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const RANGE3 = [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [1, 1], [1, 2], [1, 3], [-1, 0], [-1, 1], [-1, 2], [-1, 3]];
const dummy = (o = {}) => enemyRec({ key: 'enemy_dummy', hp: 1e7, speed: 0, ...o });
const sniper = (skill, o = {}) => chessRec({
  id: 't_sn', profession: 'SNIPER', subProfessionId: 'closerange', dmgType: 'phys',
  stats: { atk: 100, maxHp: 2000, bat: 1, ...(o.stats || {}) }, rangeGrid: RANGE3, skill, ...o,
});
const buffWith = (u, part) => (u.buffs ?? []).find((b) => String(b.key ?? '').includes(part));

test('generic blackboard: `hits` is a multi-hit count next to `times`', () => {
  const spec = (bb) => genericSkillSpec({ id: 's', skillType: 'MANUAL', durationType: 'NONE', duration: 4, spCost: 0, bb }, bb);
  assert.equal(spec({ hits: 4 }).attack.hits, 4);
  assert.equal(spec({ times: 2, hits: 4 }).attack.hits, 4);
  assert.equal(spec({ times: 5, hits: 2 }).attack.hits, 5, 'the larger of the two spellings wins');
  assert.equal(spec({ hits: 99 }).attack.hits, 10, 'capped like `times`');
  assert.equal(spec({}).attack, undefined);
});

test('generic blackboard: `dot` burns the hit target for dot × ATK every `interval` s of the skill damage type', () => {
  // 白雪 凝武: 移动速度降低28%，并每秒受到相当于攻击力70%的法术伤害
  const h = makeBattle({
    defs: {
      chess: { t_sn: sniper({ skillType: 'MANUAL', durationType: 'NONE', duration: 25, spCost: 0, initSp: 0, description: '攻击变为投掷回旋的大飞镖，短时间内使命中目标的移动速度降低28%，并每秒受到相当于攻击力70%的法术伤害', bb: { move_speed: -0.28, dot: 0.7 } }) },
      enemies: { enemy_dummy: dummy({ speed: 0 }) },
    },
    units: [{ chessId: 't_sn', row: 10, col: 4 }],
    enemies: [{ key: 'enemy_dummy', pos: [10, 6] }], content: 'generic',
  });
  h.run(0.2);
  const e = h.enemy('enemy_dummy');
  const slow = buffWith(e, ':slow:');
  assert.ok(slow, 'the hit slowed the target');
  approx(slow.mods.moveMul, 0.72, 1e-9);
  approx(slow.timeLeft, 5, 0.2, 'no 技能期间 wording and no bb.duration: the effect lasts the 5 s default');
  const dot = buffWith(e, ':dot:');
  assert.ok(dot, 'the hit left damage over time');
  const before = e.hp;
  h.run(1);
  const dealt = before - e.hp;
  assert.ok(dealt > 150 && dealt < 190, `the auto attack (100) plus dot × ATK per second (70), dealt ${dealt.toFixed(1)}`);
  // every further hit refreshes the burn, so it is still on the target while the operator keeps attacking
  h.run(3);
  assert.ok(buffWith(e, ':dot:'), 'the burn is refreshed by each hit');
  assert.equal(buffWith(e, ':dot:').interval, 1, 'a 1 s tick unless the blackboard says otherwise');
});

test('generic blackboard: a bare `shield` key is a self shield (≤ 1 = share of max HP) for shield_max_duration', () => {
  const spec = genericSkillSpec({ id: 's', skillType: 'MANUAL', durationType: 'NONE', duration: 4, spCost: 0, description: '获得相当于生命上限48%的屏障', bb: { shield: 0.48, shield_max_duration: 6 } }, { shield: 0.48, shield_max_duration: 6 });
  assert.ok(spec, 'a spec');
  const h = makeBattle({
    defs: { chess: { t_sn: sniper({ skillType: 'MANUAL', durationType: 'NONE', duration: 4, spCost: 4, initSp: 4, description: '获得相当于生命上限48%的屏障', bb: { shield: 0.48, shield_max_duration: 6 } }) }, enemies: { enemy_dummy: dummy() } },
    units: [{ chessId: 't_sn', row: 10, col: 4 }], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }], content: 'generic',
  });
  h.run(0.3);
  const u = h.unit('t_sn');
  const shield = buffWith(u, ':shield:');
  assert.ok(shield, 'the skill shielded the operator');
  approx(shield.shield, 2000 * 0.48, 1e-6);
  assert.ok(shield.timeLeft > 5.5 && shield.timeLeft <= 6, `shield_max_duration 6 s, got ${shield.timeLeft}`);
  // a flat value above 1 is HP, not a share
  const flat = genericSkillSpec({ id: 'f', skillType: 'MANUAL', durationType: 'NONE', duration: 4, spCost: 0, description: '获得屏障', bb: { shield: 500 } }, {});
  assert.ok(flat, 'a flat shield still yields a spec');
});

test('generic blackboard: `cc_duration` is the length of the skill control it describes', () => {
  const h = makeBattle({
    defs: {
      chess: { t_sn: sniper({ skillType: 'MANUAL', durationType: 'NONE', duration: 4, spCost: 0, initSp: 0, description: '使命中的目标晕眩', bb: { 'attack@stun': 1, cc_duration: 5 } }) },
      enemies: { enemy_dummy: dummy({ speed: 0 }) },
    },
    units: [{ chessId: 't_sn', row: 10, col: 4 }],
    enemies: [{ key: 'enemy_dummy', pos: [10, 6] }], content: 'generic',
  });
  h.run(0.2);
  const stun = h.enemy('enemy_dummy').findBuff('stun');
  assert.ok(stun, 'the hit stunned the enemy');
  assert.ok(stun.timeLeft > 4.4 && stun.timeLeft <= 5, `cc_duration 5 s wins over attack@stun 1, got ${stun.timeLeft}`);
});
