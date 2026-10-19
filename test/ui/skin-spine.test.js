// Skin models from a cosmetic plugin (docs/SKINS.md, docs/PLUGINS.md §9): the overlay writes a Spine model as
// { skel, atlas, textures, pma, meta } — the clip roles live in `meta` (plugin.lock.json), while the renderer reads flat
// `anims` / `animations` / `events` / `hits` / `bounds`. Both parts are checked here: a model with only `meta` must be
// valid, and spineEntry must flatten it — otherwise the unit drew the operator's own model (this was the bug behind
// 宴 / 信仰搅拌机 wearing a skin and playing the original body's clips).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spineEntry, validSpine } from '../../public/js/assets.js';

const meta = {
  anims: {
    idle: 'Idle', deploy: 'Start', die: 'Die',
    attack: { begin: 'Attack_Begin', loop: 'Attack_Loop', end: 'Attack_End' },
    attackDown: null, move: null, stun: null,
    skill: { begin: 'Skill_Begin', loop: 'Skill_Loop', end: 'Skill_End', index: 0, idle: null },
    skills: { 0: { begin: 'Skill_Begin', loop: 'Skill_Loop', end: 'Skill_End', index: 0, idle: null } },
  },
  animations: { Idle: 6, Attack_Loop: 1.2, Skill_Loop: 1.2 },
  events: ['OnAttack'],
  hits: { Attack_Loop: [0], Skill_Loop: [0, 0.233] },
  bounds: { x: -1, y: -2, width: 100, height: 120 },
};

/** A plugin-served Spine model: absolute /p/ URLs, clip data under `meta` only. */
const overlaySpine = (stem) => ({
  skel: `/p/demo/abcd1234/files/${stem}.skel`,
  atlas: `/p/demo/abcd1234/files/${stem}.atlas`,
  textures: [`/p/demo/abcd1234/files/${stem}.png`],
  pma: false,
  meta,
});

const baseSpine = (stem) => ({
  skel: `/assets/spine/op/${stem}/front/${stem}.skel`,
  atlas: `/assets/spine/op/${stem}/front/${stem}.atlas`,
  textures: [`/assets/spine/op/${stem}/front/${stem}.png`],
  anims: { idle: 'Idle', attack: { begin: null, loop: 'Attack', end: null }, die: 'Die' },
  animations: { Idle: 3 },
});

test('a plugin skin model (clip data in `meta`) is a valid Spine entry', () => {
  assert.equal(validSpine(overlaySpine('skin')), true);
  assert.equal(validSpine({ skel: '/p/demo/abcd1234/x.skel', atlas: '/p/demo/abcd1234/x.atlas' }), false, 'no clips at all');
});

test('spineEntry flattens the overlay meta so the renderer plays the skin\'s own clips', () => {
  const manifest = {
    chars: {
      char_x: {
        spine: { front: baseSpine('char_x'), back: baseSpine('char_x') },
        skins: {
          'char_x@demo#1': { name: '演示', spine: { front: overlaySpine('x_demo_1'), back: overlaySpine('x_demo_1') } },
          'char_x@art#2': { name: '只有立绘', avatar: '/assets/char/avatar/x.png' },
        },
      },
    },
  };
  const e = spineEntry(manifest, 'char_x', { skin: 'char_x@demo#1' });
  assert.ok(e, 'the skin model resolves');
  assert.match(e.skel, /x_demo_1\.skel$/);
  assert.equal(e.anims.idle, 'Idle');
  assert.equal(e.anims.attack.loop, 'Attack_Loop', 'a clip name that differs from the default roles survives');
  assert.equal(e.anims.skills[0].loop, 'Skill_Loop');
  assert.equal(e.animations.Attack_Loop, 1.2);
  assert.deepEqual(e.events, ['OnAttack']);
  assert.deepEqual(e.hits.Attack_Loop, [0]);
  assert.deepEqual(e.bounds, meta.bounds);
  assert.equal(e.meta, meta, 'the raw meta is kept beside the flattened fields');
  // back asks for the back model (the overlay writes the same files there)
  const b = spineEntry(manifest, 'char_x', { skin: 'char_x@demo#1', back: true });
  assert.match(b.skel, /x_demo_1\.skel$/);
  // a skin with art only, or an unknown one, keeps the operator's own model
  assert.match(spineEntry(manifest, 'char_x', { skin: 'char_x@art#2' }).skel, /char_x\.skel$/);
  assert.match(spineEntry(manifest, 'char_x', { skin: 'nope' }).skel, /char_x\.skel$/);
  // the overlay model without a skin asked for never replaces the operator's own
  assert.match(spineEntry(manifest, 'char_x').skel, /char_x\.skel$/);
});

test('spineEntry keeps a flat manifest Spine working unchanged', () => {
  const manifest = { chars: { char_y: { spine: { front: baseSpine('char_y'), back: baseSpine('char_y') } } } };
  const e = spineEntry(manifest, 'char_y');
  assert.equal(e.anims.attack.loop, 'Attack');
  assert.equal(e.meta, undefined);
});
