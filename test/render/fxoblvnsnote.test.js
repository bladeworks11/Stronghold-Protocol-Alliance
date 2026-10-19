// test/render/fxoblvnsnote.test.js — 丰川祥子 (本机自用, ops/op-oblvns.js) 的音符会被画出来.
//
// A note is a kit-managed probe in the sim: it flies out of her attack range with no target, seeks the nearest enemy
// within its 追踪范围半径 and homes onto it (PRTS 天赋 备注), so it is not in the snapshot's projectile list. The client
// can only draw it from `fx` events — the sim sends `fx('oblvnsNote', { x, y, fromX, fromY, dr, dc, id })` every 0.12 s
// (its position, the previous point and its heading) and render/fx.js draws the 'qi' archetype, the road 陈 S3's
// 龙剑气 takes (test/render/fxchen3wave.test.js). Against the headless fake PIXI, like fxflame.test.js.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';

let fake, FX;
before(async () => {
  fake = installFakePixi();
  FX = await import('../../public/js/render/fx.js');
});
after(() => fake.restore());

const DT = 1 / 120;
const cam = presetCamera('normal', { width: 1600, height: 900 });
const unit = (id, x, y, o = {}) => ({ id, x, y, z: 0, hover: 0, _headTiles: 1.2, alive: true, destroyed: false, info: { defId: 'x' }, onHit() {}, ...o });

function makeFx(views) {
  const P = fake.P;
  const ctx = fakeViewCtx(P);
  const map = new Map(views.map((v) => [v.id, v]));
  const fx = new FX.FxSystem({
    P, layers: ctx.layers, cam: () => cam, heightAt: () => 0, settings: { quality: 'high', damageNumbers: true },
    timeScale: () => 1, loadLevel: () => 0, subProfOf: () => null, view: (id) => map.get(id) || null,
    screenSize: () => ({ width: 1600, height: 900 }), fieldTop: () => 120,
  });
  return { fx, map };
}
const run = (fx, seconds) => { for (let t = 0; t < seconds - 1e-9; t += DT) fx.update(DT); };
/** One sim event of a note: where it is, where it was and which way it flies (`dc` cols, `dr` rows). */
const note = (fx, id, x, y, fromX, fromY, dc = 1, dr = 0) => fx.simFx('oblvnsNote', x, y, { x, y, fromX, fromY, dr, dc, id });
/** Screen box of the drawn trail/head: min/max of every live particle position. */
const drawn = (fx) => {
  const list = fx.parts.filter((p) => p.sp && p.sp.visible !== false);
  if (!list.length) return null;
  const xs = list.map((p) => p.sp.position.x), ys = list.map((p) => p.sp.position.y);
  return { n: list.length, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

describe('丰川祥子 的音符: 音符自己会被画出来 (本机自用)', () => {
  test('its own archetype — the official note look, drawn at the note and never anchored to her', () => {
    assert.equal(FX.FX_KINDS.oblvnsNote.a, 'note');
    assert.equal(FX.fxSpec('oblvnsNote').a, 'note');
    assert.equal(FX.fxSpec('oblvnsNote').pt, true);
  });

  // the art itself (public/assets/local/oblvns/, extracted from the local client) only exists on a machine that ran the
  // extractor and only loads in a browser: here the procedural flare / glow / streak must carry the note
  test('without the official textures the head is the procedural flare at the note, away from her tile', () => {
    const her = unit(1, 5, 10);
    const { fx } = makeFx([her]);
    assert.equal(drawn(fx), null, 'nothing before the event');
    note(fx, her.id, 8, 10, 7.8, 10);
    run(fx, 1 / 60);
    const box = drawn(fx);
    assert.ok(box && box.n >= 2, `a head and its glow are drawn (${box && box.n} pieces)`);
    const heads = fx.parts.filter((p) => p.sp.visible !== false && p.sp.texture === fx.tex.flare);
    assert.equal(heads.length, 1, 'the flownote head is the flare stand-in');
    const at = cam.project(8, 10, 0.35, { x: 0, y: 0, s: 0, depth: 0 });
    assert.ok(Math.abs(heads[0].x - at.x) < 90, 'drawn at the note');
    const hers = cam.project(her.x, her.y, 0.5, { x: 0, y: 0, s: 0, depth: 0 });
    assert.ok(Math.abs(box.x1 - hers.x) > 60, 'not at her tile (the anchor snap must not pull it back)');
  });

  test('the tone picks the art: a 风琴 (arts) note is drawn violet, a 钢琴 one in the kind\'s own purple', () => {
    const her = unit(1, 5, 10);
    const { fx } = makeFx([her]);
    fx.simFx('oblvnsNote', 8, 10, { x: 8, y: 10, fromX: 7.9, fromY: 10, dr: 0, dc: 1, id: her.id, tone: 'arts' });
    run(fx, 1 / 60);
    const glowArts = fx.parts.filter((p) => p.sp.visible !== false && p.sp.texture === fx.tex.glow);
    assert.ok(glowArts.length >= 1 && glowArts[0].sp.tint === 0xc9a2ff, '风琴: violet glow');
    run(fx, 1);
    fx.simFx('oblvnsNote', 8, 10, { x: 8, y: 10, fromX: 7.9, fromY: 10, dr: 0, dc: 1, id: her.id, tone: 'phys' });
    run(fx, 1 / 60);
    const glowPhys = fx.parts.filter((p) => p.sp.visible !== false && p.sp.texture === fx.tex.glow);
    assert.equal(glowPhys[0].sp.tint, 0xd76ad0, '钢琴: the kind\'s purple');
  });

  test('the events of a flight join into one trail walking the way the note goes', () => {
    const her = unit(1, 5, 10);
    const { fx } = makeFx([her]);
    let prev = 5;
    const fronts = [];
    for (let i = 0; i < 8; i++) {              // 0.12 s apart at 1.3 tiles/s ⇒ ~0.16 tile a step
      const x = 5 + 0.16 * (i + 1);
      note(fx, her.id, x, 10, prev, 10);
      prev = x;
      run(fx, 0.12);
      fronts.push(drawn(fx).x1);
    }
    for (let i = 1; i < fronts.length; i++) {
      assert.ok(fronts[i] > fronts[i - 1] - 1, `step ${i}: the front moved on (${Math.round(fronts[i - 1])} → ${Math.round(fronts[i])})`);
    }
    assert.ok(fronts[fronts.length - 1] - fronts[0] > 10, 'the note walked forward');
  });

  test('a bare or junk event never throws, and the note is gone once the events stop', () => {
    const her = unit(1, 5, 10);
    const { fx } = makeFx([her]);
    note(fx, her.id, 8, 10, undefined, undefined);
    fx.simFx('oblvnsNote', 8, 10, { id: her.id });
    fx.simFx('oblvnsNote', NaN, NaN, { id: her.id, dr: 1, dc: 0 });
    run(fx, 0.2);
    assert.ok(fx.counts.particles > 0, 'still drawn');
    run(fx, 1);                                // every trail/head particle expires (life 0.34 s max)
    assert.equal(drawn(fx), null, 'nothing is left hanging on the field');
  });

  // the impact, the end and the skills' effects are for the official layer (render/vfx/wiring.js kitFx): nothing procedural
  test('the impact, end and skill events draw nothing procedurally', async () => {
    const { FX_KINDS } = await import('../../public/js/render/fx.js');
    assert.equal(FX_KINDS.oblvnsNoteHit.a, 'none');
    assert.equal(FX_KINDS.oblvnsNoteEnd.a, 'none');
    assert.equal(FX_KINDS.oblvnsSkill.a, 'none');
  });

  test('her skills\' official effects: a start one-shot, one live loop per slot, a stop at the end of the skill', async () => {
    const { FxWiring } = await import('../../public/js/render/vfx/wiring.js');
    const spawned = [];
    const ofx = {
      active: true,
      lib: { has: (k) => ['oblvns_skill_03_start', 'oblvns_skill_03_range', 'oblvns_skill_03_buff', 'oblvns_skill_02_buff', 'oblvns_skill_02_buff_01'].includes(k) },
      ctx: { heightAt: () => 0.5 },
      spawn(key, place, opts) {
        const h = { key, opts, at: { ...place }, stopped: false, killed: false, place() {}, stop() { this.stopped = true; }, kill() { this.killed = true; } };
        spawned.push(h);
        return h;
      },
    };
    const w = new FxWiring(ofx);
    const skill = (mode, key, tag) => w.simFx('oblvnsSkill', 5, 10, { id: 1, mode, key, tag });
    assert.equal(skill('once', 'oblvns_skill_03_start', 's3start'), true);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].at.pos, [-5, 1, -0.5], 'at her tile, on its ground (the effect frame: board − (10, 9))');
    assert.equal(spawned[0].opts.loop, undefined, 'a start is a one-shot');
    assert.equal(skill('loop', 'oblvns_skill_03_range', 's3range'), true);
    assert.equal(skill('loop', 'oblvns_skill_03_buff', 's3buff'), true);
    assert.equal(spawned.length, 3);
    assert.equal(spawned[1].opts.loop, true);
    // a second loop in one slot swaps the first out (a timbre switch re-uses its slot)
    assert.equal(skill('loop', 'oblvns_skill_02_buff_01', 's3buff'), true);
    assert.ok(spawned[2].stopped, 'the previous loop of the slot stops');
    assert.equal(spawned.length, 4);
    assert.equal(skill('stop', null, 's3range'), true);
    assert.ok(spawned[1].stopped, 'the range loop ends with the skill');
    assert.equal(skill('stop', null, 's3range'), false, 'stopping a slot that is not live is not an official draw');
    assert.equal(skill('once', 'not_extracted', 'x'), false, 'an effect that was not extracted falls back');
    w.clear();
    assert.ok(spawned[3].killed, 'clear() kills the live loops');
  });

  test('her prefabs take the unit\'s direction: the start mirrors and S3\'s ground range / the note trail turn on a left-facing half', async () => {
    const { FxWiring } = await import('../../public/js/render/vfx/wiring.js');
    // the extracted prefabs' own metadata (public/assets/local/fx/prefabs): the starts are FLIP_TWO_SIDE with a rotationY
    // helper, S3's range is FOUR_DIRECTION with _useBodyRotation, a trail is a projectile body (art along +x)
    const DEFS = {
      oblvns_skill_03_start: { rotateType: 1, rotY: 2, leftIsDefault: false },
      oblvns_skill_03_range: { rotateType: 2, rotY: -1, useBodyRotation: true },
      oblvns_attack_01_trail: { rotateType: 0, rotY: -1 },
    };
    const spawned = [];
    const ofx = {
      active: true,
      lib: { has: (k) => k in DEFS, def: (k) => DEFS[k] || null },
      ctx: { heightAt: () => 0 },
      spawn(key, place, opts) {
        const h = { key, opts, at: { ...place }, placed: [], place(o) { this.placed.push(o); }, stop() {}, kill() {} };
        spawned.push(h);
        return h;
      },
    };
    const views = {
      7: { id: 7, x: 15, y: 10, z: 0, dir: 'LEFT', visFacing: -1, destroyed: false },   // the right-hand half of a pair field
      8: { id: 8, x: 5, y: 10, z: 0, dir: 'RIGHT', visFacing: 1, destroyed: false },    // the left-hand half
    };
    const w = new FxWiring(ofx, { view: (id) => views[id] || null });
    const skill = (id, mode, key, tag) => w.simFx('oblvnsSkill', views[id].x, views[id].y, { id, mode, key, tag });
    // LEFT: the official client turns a FOUR_DIRECTION effect with her body (bodyYaw LEFT = π) and mirrors FLIP_TWO_SIDE
    assert.equal(skill(7, 'loop', 'oblvns_skill_03_range', 's3range'), true);
    assert.equal(spawned.at(-1).at.yaw, Math.PI, 'the ground range turns with her (LEFT)');
    assert.equal(skill(7, 'once', 'oblvns_skill_03_start', 's3start'), true);
    assert.equal(spawned.at(-1).at.flipY, true, 'the cast effect mirrors for a left-facing unit');
    w.simFx('oblvnsNote', 15, 10, { note: 71, trail: 'oblvns_attack_01_trail', dr: 0, dc: -1 });
    assert.equal(spawned.at(-1).at.yaw, Math.PI, 'the note trail points the way the note flies');
    w.simFx('oblvnsNote', 15, 10, { note: 71, trail: 'oblvns_attack_01_trail', dr: 1, dc: 0 });
    assert.equal(spawned.at(-1).placed.at(-1).yaw, Math.PI / 2, 'and follows it when the note homes');
    // RIGHT: the same events keep the art's own direction (the left half was never wrong)
    assert.equal(skill(8, 'loop', 'oblvns_skill_03_range', 's3range'), true);
    assert.equal(spawned.at(-1).at.yaw, 0, 'the ground range keeps her direction (RIGHT)');
    assert.equal(skill(8, 'once', 'oblvns_skill_03_start', 's3start'), true);
    assert.equal(spawned.at(-1).at.flipY, false, 'the cast effect is not mirrored for a right-facing unit');
    w.simFx('oblvnsNote', 5, 10, { note: 81, trail: 'oblvns_attack_01_trail', dr: 0, dc: 1 });
    assert.equal(spawned.at(-1).at.yaw, 0, 'a rightward note trail is unturned');
    w.clear();
  });

  test('a prefab that loads after its fx event is turned once its metadata is known', async () => {
    const { FxWiring } = await import('../../public/js/render/vfx/wiring.js');
    const defs = new Map();
    const spawned = [];
    const ofx = {
      active: true,
      lib: { has: () => true, def: (k) => defs.get(k) || null },
      ctx: { heightAt: () => 0 },
      spawn(key, place, opts) {
        const h = { key, opts, at: { ...place }, place() {}, stop() {}, kill() {} };
        spawned.push(h);
        return h;
      },
    };
    const v = { id: 7, x: 15, y: 10, z: 0, dir: 'LEFT', visFacing: -1, destroyed: false };
    const w = new FxWiring(ofx, { view: () => v });
    // the extraction's files load on demand: at the fx event the metadata is not here yet
    assert.equal(w.simFx('oblvnsSkill', 15, 10, { id: 7, mode: 'loop', key: 'oblvns_skill_03_range', tag: 's3range' }), true);
    const h = spawned.at(-1);
    assert.equal(h.at.yaw, undefined, 'nothing to turn it by yet — the art keeps its own direction');
    defs.set('oblvns_skill_03_range', { rotateType: 2, rotY: -1, useBodyRotation: true });
    const fx = { yaw: 0, mirror: false, flipY: false, place(o) { Object.assign(this, o); } };
    h.opts.track(fx);
    assert.equal(fx.yaw, Math.PI, 'the first frame after the load turns it with her direction');
    w.clear();
  });
  test('her effects land on her tile: the sim\'s board (x, y) is the effect frame\'s (x − 10, y − 9, −height)', async () => {
    const { FxWiring, NOTE_Z } = await import('../../public/js/render/vfx/wiring.js');
    const spawned = [];
    const ofx = {
      active: true,
      lib: { has: () => true },
      ctx: { heightAt: () => 0.4 },
      spawn(key, place) {
        const h = { key, at: { ...place }, place() {}, stop() {}, kill() {} };
        spawned.push(h);
        return h;
      },
    };
    const w = new FxWiring(ofx);
    const note = (x, y, id) => w.simFx('oblvnsNote', x, y, { note: id, trail: 'oblvns_attack_01_trail', tone: 'phys' });
    // her tile on the left half (col 5, row 10): the effect frame\'s (−5, 1), NOTE_Z above the tile\'s 0.4
    assert.equal(note(5, 10, 1), true);
    assert.deepEqual(spawned[0].at, { pos: [-5, 1, -(0.4 + NOTE_Z)], groundZ: -0.4, yaw: 0 }, 'on her tile, not 10 × 9 tiles off it');
    // the right-hand helper of a two-helper 联防: the sim\'s column already carries colOffset +8 (board 3 → field 11)
    assert.equal(note(11, 10, 2), true);
    assert.deepEqual(spawned[1].at.pos, [1, 1, -(0.4 + NOTE_Z)], 'the field column, no offset added or lost');
    // a skill effect sits on her tile\'s ground (its prefab nodes give the height)
    assert.equal(w.simFx('oblvnsSkill', 5, 10, { id: 1, mode: 'once', key: 'oblvns_skill_03_start', tag: 's3start' }), true);
    assert.deepEqual(spawned[2].at, { pos: [-5, 1, -0.4], groundZ: -0.4 }, 'the same tile as a unit\'s feet (mounts.js unitPoint)');
    w.clear();
  });
  test('the official layer follows a flight: one trail per note, moved along it, its impact on a hit and its stop at the end', async () => {
    const { FxWiring, NOTE_Z } = await import('../../public/js/render/vfx/wiring.js');
    const spawned = [];
    const ofx = {
      active: true,
      lib: { has: (k) => k === 'oblvns_attack_01_trail' || k === 'oblvns_attack_01_hit' },
      ctx: { heightAt: () => 0 },
      spawn(key, place, opts) {
        const h = {
          key, opts, at: { ...place }, placed: [], stopped: false, killed: false,
          place(o) { this.placed.push(o); }, stop() { this.stopped = true; }, kill() { this.killed = true; },
        };
        spawned.push(h);
        return h;
      },
    };
    const w = new FxWiring(ofx);
    const fxNote = (note, x, extra = {}) => w.simFx('oblvnsNote', x, 10, { note, trail: 'oblvns_attack_01_trail', tone: 'phys', ...extra });
    assert.equal(fxNote(7, 5), true, 'the first event of a flight spawns its official trail');
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].at.pos, [-5, 1, -NOTE_Z], 'placed where the note flies');
    assert.equal(spawned[0].opts.loop, true, 'a looping trail, one per flight');
    assert.equal(fxNote(7, 5.5), true);
    assert.equal(spawned.length, 1, 'the next event moves the same trail');
    assert.deepEqual(spawned[0].placed.at(-1).pos, [-4.5, 1, -NOTE_Z]);
    assert.equal(w.simFx('oblvnsNoteHit', 7, 10, { note: 7, hit: 'oblvns_attack_01_hit' }), true, 'the impact is its own effect');
    assert.equal(spawned.length, 2);
    assert.equal(w.simFx('oblvnsNoteEnd', 7, 10, { note: 7 }), true);
    assert.ok(spawned[0].stopped, 'the trail stops when the note ends');
    // nothing extracted for the key it names / 官方特效 off → false, and the procedural note draws it
    assert.equal(fxNote(8, 5, { trail: 'not_extracted' }), false);
    ofx.active = false;
    assert.equal(fxNote(9, 5), false);
    w.clear();
  });
});
