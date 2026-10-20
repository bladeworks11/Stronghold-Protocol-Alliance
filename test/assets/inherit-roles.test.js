// A skin's skeleton is its operator's rig with other art: the roles come from the body (server/plugins/pack.js
// skeletonClipData passes data/assets.json's anims to inheritRoles) — resolving them from the clip names guessed both
// which skill is the primary one and which slots are the attack (宴's S2/S3, 信仰搅拌机's Skill_3). Clips the skin's
// rig does not have fall back to its own resolve, or off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inheritBounds, inheritRoles, resolveRoles, roleAnimationNames } from '../../tools/assets/anim-roles.mjs';

const CLIPS = ['Attack', 'Attack_Begin', 'Attack_End', 'Attack_Loop', 'Die', 'Idle', 'Skill_2_Loop', 'Skill_3_Begin',
  'Skill_3_End', 'Skill_3_Idle', 'Skill_Begin', 'Skill_End', 'Skill_Loop', 'Start'];
const durations = Object.fromEntries(CLIPS.map((n) => [n, 1]));

// 宴: one plain Skill set for S1, S2/S3 attack with her ordinary clips (data/assets.json）
const utageBody = {
  idle: 'Idle', deploy: 'Start',
  attack: { begin: null, loop: 'Attack', end: null },
  skill: { begin: null, loop: 'Attack', end: null, via: 'attack', index: 1, idle: null },
  die: 'Die', move: null, stun: null,
  skills: {
    0: { begin: null, loop: 'Skill_Loop', end: null, index: 0, idle: null },
    1: { begin: null, loop: 'Attack', end: null, via: 'attack', index: 1, idle: null },
  },
};

// 信仰搅拌机: Skill_3 is the primary skill the kit holds (data/assets.json)
const rmixerBody = {
  idle: 'Idle', deploy: 'Start',
  attack: { begin: 'Attack_Begin', loop: 'Attack_Loop', end: 'Attack_End' },
  skill: { begin: 'Skill_3_Begin', loop: 'Skill_3_Idle', end: 'Skill_3_End', index: 2, idle: 'Skill_3_Idle' },
  die: 'Die', move: null, stun: null,
  skills: {
    0: { begin: 'Skill_Begin', loop: 'Skill_Loop', end: 'Skill_End', index: 0, idle: null },
    1: { begin: 'Skill_2_Loop', loop: 'Skill_2_Loop', end: null, index: 1, idle: null },
    2: { begin: 'Skill_3_Begin', loop: 'Skill_3_Idle', end: 'Skill_3_End', index: 2, idle: 'Skill_3_Idle' },
  },
};

test('inheritRoles: the body decides the primary skill and the slots it leaves to the attack', () => {
  const r = inheritRoles(utageBody, CLIPS, resolveRoles(CLIPS, { skillIndices: [0, 1, 2], durations }));
  assert.equal(r.skill.loop, 'Attack', 'S2/S3 attack like the body, they do not kneel');
  assert.equal(r.skill.via, 'attack');
  assert.equal(r.skill.index, 1);
  assert.deepEqual(Object.keys(r.skills), ['0', '1'], 'no third slot invented for an index the body does not map');
  assert.equal(r.skills['0'].loop, 'Skill_Loop');
  assert.equal(r.skills['1'].loop, 'Attack');
});

test('inheritRoles: a body whose primary skill is Skill_3 keeps Skill_3 on its skin', () => {
  const resolved = resolveRoles(CLIPS, { skillIndices: [0, 1, 2], durations });
  assert.equal(resolved.skill.loop, 'Skill_Loop', 'by name alone the lowest Skill_N wins (the reported bug)');
  const r = inheritRoles(rmixerBody, CLIPS, resolved);
  assert.equal(r.skill.loop, 'Skill_3_Idle');
  assert.equal(r.skill.index, 2);
  assert.equal(r.skills['2'].loop, 'Skill_3_Idle');
  assert.deepEqual([r.idle, r.deploy, r.attack.loop, r.die], ['Idle', 'Start', 'Attack_Loop', 'Die']);
});

test('inheritRoles: a clip the skin rig lacks falls back to its own resolve, never to a name it has not got', () => {
  const rig = ['Attack', 'Idle', 'Stand'];
  const fallback = resolveRoles(rig, { skillIndices: [0, 1, 2], durations: { Attack: 1, Idle: 1, Stand: 1 } });
  const r = inheritRoles(utageBody, rig, fallback);
  assert.equal(r.idle, 'Idle');
  assert.equal(r.deploy, 'Idle', 'no Start in the rig: the fallback deploy clip');
  assert.equal(r.attack.loop, 'Attack');
  assert.equal(r.skill.loop, 'Attack');
  for (const n of roleAnimationNames(r)) assert.ok(rig.includes(n), `${n} is not in the rig`);
});

test('inheritBounds: a skin without setup-pose bounds keeps its body\'s, never the renderer default', () => {
  const body = { x: -345.685, y: -2.442, width: 1223.606, height: 631.382 };
  assert.deepEqual(inheritBounds(null, body), body, '信仰搅拌机 boc#12 parses to none: the client would size it as a chibi');
  const own = { x: -229.342, y: -15.379, width: 378.568, height: 409.91 };
  assert.deepEqual(inheritBounds(own, body), own, 'a skin that has bounds of its own keeps them');
  assert.equal(inheritBounds(null, null), null, 'nothing to inherit stays absent');
});
