// test/content/op_oblvns.test.js — the 自选 operator kit of 丰川祥子 (char_4182_oblvns, 6★ 领主; kit
// server/sim/content/kits/ops/op-oblvns.js), fielded the production way (a DIY slot + its `diy` pick) in every form:
// tiers 5 / 6, normal (E2 Lv1, skill rank 4, no module) and elite (E2 Lv60, rank 7) with no module or LOR-Y
// “无言的约定” at stage 1 (tier 5) / 3 (tier 6). Every number is read back from data/backups.json; the notes' movement
// parameters exist only on PRTS 丰川祥子 (its 备注 — cited in the kit, and the reason the tests below check the
// behaviour they give: a note flies out of her attack range, seeks an enemy near ITSELF and homes onto it).
// Run: node --test test/content/op_oblvns.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8'));
const BACKUPS = load('backups');
const OBLVNS = 'char_4182_oblvns';
const FORMS = BACKUPS.units[OBLVNS].forms;
const OPS = BACKUPS.diy.operators;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const LORY = 'uniequip_002_oblvns';
const S1 = 'skchr_oblvns_1', S2 = 'skchr_oblvns_2', S3 = 'skchr_oblvns_3';
const NOTE_TAG = 'oblvns:note';
/** The unit form of a slot (tier, normal / elite). */
const formOf = (tier, elite) => FORMS[elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0'];
const skillOf = (tier, elite, id) => formOf(tier, elite).skills.find((s) => s.skillId === id);
const modOf = (tier) => formOf(tier, true).modules.find((m) => m.uniEquipId === LORY);
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, ...o });
// the two markers of S3's picks differ by 1 point only: enough to make 防御力最高 / 法术抗性最高 unambiguous, and small
// enough that the damage they take is the note's raw amount (the talent's penetration can only lower the mitigation)
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'),
  enemy_tough: dummy('enemy_tough', { def: 1 }),
  enemy_magic: dummy('enemy_magic', { res: 1 }),
  enemy_walk: dummy('enemy_walk', { speed: 1 }),   // a foe that keeps walking (追踪移动's own test)
  enemy_fast: dummy('enemy_fast', { speed: 2.5 }), // the fastest moveSpeed in data/enemies.json (1.25 tiles/s)
};
/** Every 自选 form: [tier, elite, module]. */
const FORMS_ALL = [[5, false, null], [6, false, null], [5, true, null], [6, true, null], [5, true, LORY], [6, true, LORY]];

/** A battle with her as uid 1 at (row, col) facing RIGHT, plus `others`. `routes` overrides the flat stage's. */
function field({ tier = 6, elite = true, mod = null, skill = 2, row = 10, col = 5, others = [], seed = 5, routes = null } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed,
    flags: { dpPerSec: 0, dpMax: 999 }, hooks: ['damaged', 'attack', 'skillStart', 'spGain'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: OBLVNS, skillIndex: skill, uniEquipId: mod }, elite, row, col }, ...others],
    routes,
  });
  h.step();
  return { h, u: h.unit(1) };
}
/** Every damage instance she dealt that came from one of her notes. */
const noteHits = (h, u) => h.hooksOf('damaged').filter((c) => c.source === u && c.dmg && (c.dmg.tags ?? []).includes(NOTE_TAG));
const done = (h) => {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
};
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;

test('丰川祥子 in every 自选 form: her kit (all three skills authored), the form\'s stats + module, 3-12, 领主 ranged, 【Ave Mujica】', () => {
  assert.equal(OPERATOR_KITS[OBLVNS], KITS[OBLVNS]);
  for (const f of FORMS_ALL) {
    const [tier, elite, mod] = f;
    for (const skill of [0, 1, 2]) {
      const { h, u } = field({ tier, elite, mod, skill });
      const form = formOf(tier, elite), m = elite && mod ? modOf(tier) : null;
      assert.deepEqual([u.def.charId, u.def.diyFor, u.skill.id, !!u.kit.generic, u.kit.skillSource],
        [OBLVNS, SLOT[tier], form.skills[skill].skillId, false, 'skills'], label(f));
      assert.deepEqual([u.base.maxHp, u.base.atk, u.base.def],
        [form.stats.maxHp + (m?.attr.maxHp ?? 0), form.stats.atk + (m?.attr.atk ?? 0), form.stats.def + (m?.attr.def ?? 0)], `${label(f)}: stats`);
      assert.deepEqual([...u.liveRangeGrid].map(String).sort(), form.rangeGrid.map(String).sort(), `${label(f)}: 3-12`);
      assert.deepEqual([u.s.blockCnt, u.profile.attack, u.profile.canHitFly, u.profile.rangedScale], [2, 'ranged', true, 0.8], `${label(f)}: 领主`);
      done(h);
    }
  }
  // the numbers of the forms (zh_CN, full potential): E2 Lv1 1624 / 613 / 10, E2 Lv60 1910 / 704 / 10; LOR-Y stage 1
  // +180 / +38 / +5, stage 3 +300 / +63 / +7
  assert.deepEqual([FORMS['2/1/4/0'].stats.maxHp, FORMS['2/1/4/0'].stats.atk, FORMS['2/60/7/1'].stats.maxHp, FORMS['2/60/7/1'].stats.atk], [1624, 613, 1910, 704]);
  assert.deepEqual([modOf(5).attr, modOf(6).attr], [{ maxHp: 180, atk: 38, aspd: 5 }, { maxHp: 300, atk: 63, aspd: 7 }]);
  assert.deepEqual(OPS[OBLVNS].powers, ['mujica'], 'the data names her team (T1 buffs its members)');
});

test('持续攻击: with nothing in her attack range a note still flies out and hits an enemy OUTSIDE it (PRTS 天赋 备注)', () => {
  for (const col of [9, 10]) {
    const { h, u } = field({ skill: 2 });
    const foe = h.spawn('enemy_dummy', { pos: [10, col] });
    assert.equal(u.rangeKeySet.has(10 * 21 + col), false, `col ${col} is outside her 3-12 range`);
    assert.equal(h.hooksOf('attack').length, 0, 'nothing is in her range, so the attack loop never fires');
    assert.ok(h.runUntil(() => noteHits(h, u).some((c) => c.target === foe), 25), `a free note reached the enemy at col ${col}`);
    const c = noteHits(h, u).find((x) => x.target === foe);
    approx(c.amount, u.s.atk * 0.8, 'the note deals the cached ATK × the 领主 ranged scale (0.8)');
    assert.deepEqual([c.type, c.dmg.isAttack], ['phys', true], 'her attack, physical');
    assert.ok(h.eventsOf('fx').some((e) => e[1] === 'oblvnsNote'), 'the note is drawn for the client');
    done(h);
  }
});

test('the note IS her attack: one damage instance per attack, the engine\'s own hit cancelled, damage on the note\'s arrival', () => {
  const { h, u } = field({ skill: 2 });
  const foe = h.spawn('enemy_dummy', { pos: [10, 7] });
  h.run(8);
  const attacks = h.hooksOf('attack').filter((c) => c.attacker === u);
  const mine = h.hooksOf('damaged').filter((c) => c.source === u);
  assert.ok(attacks.length >= 4, `she attacked (${attacks.length})`);
  // every attack whose note has had the time to arrive (a note flies the 2 tiles in about a second) dealt exactly one
  const settled = attacks.filter((a) => a.t <= h.b.time - 1.5);
  assert.equal(mine.length, settled.length, 'exactly one damage instance per attack (the engine\'s hit is cancelled)');
  assert.ok(mine.length > 0);
  for (const c of mine) {
    assert.ok((c.dmg.tags ?? []).includes(NOTE_TAG), 'every instance is one of her notes');
    assert.equal(c.target, foe, 'the note landed on the attacked enemy');
    approx(c.amount, u.s.atk * 0.8, 'cached ATK × 0.8');
  }
  // the note leaves her tile with the attack and lands a flight later (the damage is not the attack's own hit)
  assert.ok(mine[0].t > attacks[0].t, `the note landed after the attack (${mine[0].t.toFixed(2)} > ${attacks[0].t.toFixed(2)})`);
  done(h);
});

test('追踪移动: every note lands on a foe that keeps walking (a turn-lagged note used to circle it for ever)', () => {
  // The foe walks along her own row into her 3-12 range, where she blocks it, so she attacks it for the whole run.
  // Before the fix every note settled into a 0.13–0.75 tile orbit around it: the 转向速度 lag cannot point a note that
  // is inside its own turning circle (track·dt / turn = 0.4 tiles for NOTE.aimed) at the foe, and the one-step arrival
  // test needs 0.067 tiles — 9 of the 16 notes were still in the air after 20 s and only 7 had landed.
  const walk = (key, seed = 5) => {
    const { h, u } = field({ seed, routes: [{ motion: 'WALK', start: [10, 10], end: [10, 2], checkpoints: [] }] });
    const foe = h.spawn(key, { pos: [10, 10] });
    return { h, u, foe };
  };
  const flights = (h, u, secs) => {
    const first = new Map(), last = new Map();
    for (let i = 0; i < 30 * secs; i++) {
      h.step();
      for (const n of u.mem['oblvns:notes'] ?? []) {
        if (!first.has(n.id)) first.set(n.id, h.b.time);
        last.set(n.id, h.b.time);
      }
    }
    const maxLife = Math.max(...[...first].map(([id, t0]) => last.get(id) - t0));
    return { first, maxLife };
  };
  // a 1.0 and a 2.5 moveSpeed foe: the orbit was not the foe's speed, it was the missing terminal turn
  for (const key of ['enemy_walk', 'enemy_fast']) {
    const { h, u, foe } = walk(key);
    const { first, maxLife } = flights(h, u, 12);
    const hits = noteHits(h, u);
    const alive = (u.mem['oblvns:notes'] ?? []).length;
    assert.ok(hits.length >= 8, `${key}: her notes landed (${hits.length})`);
    for (const c of hits) assert.equal(c.target, foe, `${key}: every note landed on the walking foe`);
    assert.ok(alive <= 2, `${key}: no note is left orbiting it (${alive} in the air)`);
    // `first` counts a note once even when it is a 已命中 one that hurts several foes, so compare as a lower bound: a
    // note that vanished without ever landing would leave the hits short of the flights counted.
    assert.ok(hits.length >= first.size - 1, `${key}: every note played landed or is still in the air (${hits.length} hits, ${first.size} flights)`);
    assert.ok(maxLife < 5, `${key}: the longest flight is ${maxLife.toFixed(2)} s`);
    done(h);
  }
  // deterministic: the same seed replays the same flights
  const a = walk('enemy_walk'), b = walk('enemy_walk');
  a.h.run(12);
  b.h.run(12);
  assert.deepEqual(noteHits(a.h, a.u).map((c) => [c.t, c.amount]), noteHits(b.h, b.u).map((c) => [c.t, c.amount]), 'the same seed replays the same flights');
  done(a.h);
});

test('T1 颂乐音符: the notes in the air give 【Ave Mujica】 members penetration (direct add, max_cnt layers)', () => {
  for (const [tier, elite, mod, penDef, penRes, maxCnt] of [[5, false, null, 0.03, 0.02, 10], [6, true, LORY, 0.05, 0.025, 12]]) {
    const { h, u } = field({ tier, elite, mod, skill: 2 });
    assert.equal(u.findBuff('oblvns:notes'), null, 'no note in the air yet');
    h.run(2.7);   // 持续攻击 plays a note every attack interval; nothing is on the field to track
    const live = (u.mem['oblvns:notes'] ?? []).length;
    const b = u.findBuff('oblvns:notes');
    assert.ok(b && live > 0, `a note is in the air (${live}) and the penetration is on`);
    const n = Math.round(b.mods.defIgnorePct / penDef);
    assert.ok(n >= 1 && n <= maxCnt, `layers ${n} ∈ [1, max_cnt ${maxCnt}]`);
    approx(b.mods.defIgnorePct, penDef * n, 'def_penetrate_ratio × notes');
    approx(b.mods.resIgnorePct, penRes * n, 'magic_resist_penetrate_ratio × notes');
    assert.ok(Math.abs(n - live) <= 1, `the layers follow the notes in the air (${n} vs ${live})`);
    done(h);
  }
});

test('S1 新月的苏醒 (攻击回复, 2 charges): eight arts notes, each at its own share of ATK', () => {
  const { h, u } = field({ skill: 0 });
  const foe = h.spawn('enemy_dummy', { pos: [10, 7] });
  const bb = skillOf(6, true, S1).bb;
  const shares = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => bb[i === 0 ? 'atk_scale' : `atk_scale_${i + 1}`]);
  u.skill.gainSp(999);
  assert.ok(h.runUntil(() => u.skill.activations === 1, 40), 'the skill cast');
  const n0 = noteHits(h, u).length;
  h.run(4);
  const cast = noteHits(h, u).slice(n0).filter((c) => c.type === 'arts');
  assert.equal(cast.length, shares.length, 'eight notes');
  for (const s of shares) {
    const want = u.s.atk * 0.8 * s;
    assert.ok(cast.some((c) => Math.abs(c.amount - want) <= 1e-6 * Math.max(1, want)), `a note at ${(s * 100).toFixed(0)} % ATK landed`);
  }
  for (const c of cast) assert.equal(c.target, foe, 'every note homed onto the enemy she played the fan at');
  done(h);
});

test('S2 满月的舞会: 钢琴 (the opening timbre) passes through its target onto the next enemy; a cast switches to 风琴 (arts + ASPD)', () => {
  const { h, u } = field({ skill: 1 });
  assert.equal(u.skill.id, S2);
  const first = h.spawn('enemy_dummy', { pos: [10, 7] });
  const second = h.spawn('enemy_dummy', { pos: [10, 8] });
  h.run(5);
  const before = noteHits(h, u);
  assert.ok(before.some((c) => c.target === first), 'the first enemy was hit');
  assert.ok(before.some((c) => c.target === second), '命中目标后穿过敌人: the note passed through onto the second');
  for (const c of before) assert.equal(c.type, 'phys', '钢琴 notes are physical');
  const aspd0 = u.s.aspd;
  u.skill.gainSp(999);
  assert.ok(h.runUntil(() => u.skill.activations === 1, 40), 'the skill cast');
  assert.equal(u.mem['oblvns:s2'].piano, false, 'the cast switched the timbre to 风琴');
  assert.ok(u.s.aspd > aspd0, `风琴 gives attack speed (${aspd0} → ${u.s.aspd})`);
  const n0 = noteHits(h, u).length;
  h.run(4);
  const after = noteHits(h, u).slice(n0);
  assert.ok(after.length > 0, 'notes keep playing');
  for (const c of after) assert.equal(c.type, 'arts', '风琴 notes are arts');
  done(h);
});

test('S3 残月的余响 (25 s): the range grows to the skill\'s 3-21 and every attack plays 2 physical notes at the highest-DEF enemy and 2 arts at the highest-RES one', () => {
  const { h, u } = field({ skill: 2, mod: LORY });
  const tough = h.spawn('enemy_tough', { pos: [10, 7] });
  const magic = h.spawn('enemy_magic', { pos: [9, 7] });
  const bb = skillOf(6, true, S3).bb;
  u.skill.gainSp(999);
  assert.ok(h.runUntil(() => u.skill.active, 60), 'the skill cast');
  const grid = skillOf(5, false, S3).rangeGrid;
  assert.deepEqual([...u.liveRangeGrid].map(String).sort(), grid.map(String).sort(), 'the range is the skill\'s 3-21');
  const n0 = noteHits(h, u).length;
  h.run(3);
  const cast = noteHits(h, u).slice(n0);
  const phys = cast.filter((c) => c.type === 'phys'), arts = cast.filter((c) => c.type === 'arts');
  assert.ok(phys.length >= 2 && arts.length >= 2, `both timbres played (${phys.length} phys, ${arts.length} arts)`);
  for (const c of phys) assert.equal(c.target, tough, 'the physical notes track 防御力最高的敌人');
  for (const c of arts) assert.equal(c.target, magic, 'the arts notes track 法术抗性最高的敌人');
  // the module's stage-2+ clause: 技能期间远程攻击不再降低攻击力 — the note keeps the full ATK × atk_scale (the 1 point of
  // DEF it stands on, less the talent's penetration, is the whole mitigation: see ENEMIES)
  approx(phys[0].amount, u.s.atk * bb['attack@atk_scale'] * u.s.atkScaleMul, '180 % ATK (no 0.8 in a skill with LOR-Y)', 0.01);
  done(h);
});

test('T2 毋畏遗忘: +16 attack speed for the operators in her range, and LOR-Y gives her own +12 with 2 enemies inside it', () => {
  const { h, u } = field({ skill: 2, mod: LORY, others: [{ uid: 2, chessId: 'chess_char_1_02_a', row: 10, col: 7 }] });
  const ally = h.unit(2);
  h.run(1);
  assert.equal(u.s.aspd, u.base.aspd, 'no enemy in her range: her own attack speed is the base one');
  approx(ally.s.aspd, ally.base.aspd + 16, '攻击范围内干员攻击速度+16');
  const a = h.spawn('enemy_dummy', { pos: [9, 6] });
  h.run(0.3);
  assert.equal(u.s.aspd, u.base.aspd, 'one enemy: the module\'s line is not on');
  const b = h.spawn('enemy_dummy', { pos: [10, 8] });
  h.run(0.3);
  approx(u.s.aspd, u.base.aspd + 12, '初始攻击范围内存在2名及以上敌人时攻击速度+12 (her own)');
  b.hp = 0; b.alive = false; b.removed = true;
  h.run(0.3);
  assert.equal(u.s.aspd, u.base.aspd, 'back to one enemy: the stat is off again');
  void a;
  done(h);
});

test('T2 Fever: her notes\' damage fills the counter (3 an instance); at 450 the 20 s window opens', () => {
  const { h, u } = field({ skill: 1 });
  h.spawn('enemy_dummy', { pos: [10, 7] });
  assert.equal(h.eventsOf('fx').filter((e) => e[1] === 'fever').length, 0, 'not armed at the start');
  assert.ok(h.runUntil(() => h.eventsOf('fx').some((e) => e[1] === 'fever'), 400), 'Fever opened');
  const hits = noteHits(h, u).length;
  assert.ok(hits >= 450 / 3, `150 damage instances armed it (${hits})`);
  done(h);
});
