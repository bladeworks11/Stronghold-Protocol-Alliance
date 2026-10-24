// test/plugins/chessAudit.test.js — the diagnostic that says what a content set's new chess pieces can actually do.
//
// The audit never changes a set; it answers three questions per piece: can it be bought, which kit runs it, and does
// that kit read the numbers the piece carries. The classification is what the docs promise (docs/PLUGINS.md §16), so
// it is pinned here: a borrowed official kit, a body a script plugin kitted, a data-only piece, or the generic kit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chessAudit, chessAuditLine, ignoredNumbers, scriptKitIds } from '../../server/plugins/chessAudit.js';

const skill = (bb) => ({ skillId: 'skx_probe', default: true, bb });

/** A vanilla table to audit against: only these ids exist already. */
const BASE = { chess_1_a: {}, chess_1_b: {} };

test('counts only the pieces the set adds, both halves of a 进阶 pair', () => {
  const chess = {
    chess_1_a: { tier: 1 }, chess_1_b: { tier: 1 }, // vanilla: not counted
    chess_x_p_a: { tier: 3, skills: [skill({ atk_scale: 1 })] },
    chess_x_p_b: { tier: 3, skills: [skill({ atk_scale: 1 })] },
    chess_x_q_a: { notier: true }, // no tier: not a shop piece at all
  };
  const audit = chessAudit(chess, BASE);
  assert.equal(audit.added, 1);
  assert.equal(audit.golden, 1);
  assert.equal(audit.shop, 1);
});

test('a piece the shop can never show is counted as hidden, not as buyable', () => {
  const chess = {
    chess_x_a_a: { tier: 3, isHidden: true, skills: [skill({ atk_scale: 1 })] },
    chess_x_b_a: { tier: 3, visible: false, skills: [skill({ atk_scale: 1 })] },
    chess_x_c_a: { tier: 3, isDiy: true, skills: [skill({ atk_scale: 1 })] },
    chess_x_d_a: { tier: 3, skills: [skill({ atk_scale: 1 })] },
  };
  const audit = chessAudit(chess, BASE);
  assert.equal(audit.added, 4);
  assert.equal(audit.shop, 1);
  assert.equal(audit.hidden, 3);
});

test('borrowed kits, scripted bodies, data-only pieces and the generic kit are told apart', () => {
  const chess = {
    chess_x_borrowed_a: { tier: 3, charId: 'char_x_p', kitRef: 'char_1029_yato2', skills: [skill({ atk: 1 })] },
    chess_x_scripted_a: { tier: 3, charId: 'char_x_s', skills: [skill({ atk: 1, wrong_key: 2 })] },
    chess_x_picked_a: { tier: 3, charId: 'char_x_d', skills: [skill({ atk: 1 })] },
    chess_x_data_a: { tier: 3, charId: 'char_x_n', skills: [{ skillId: 'skx_plain' }] },
    chess_x_generic_a: { tier: 3, charId: 'char_x_g', skills: [skill({ atk: 1, wrong_key: 2 })] },
  };
  // `char_x_s` is registered by a script plugin, `char_x_d` is a 自选 body (ContentSet.kitted): both run their own kit.
  const audit = chessAudit(chess, BASE, { kitted: ['char_x_d', 'char_x_s'] });
  assert.equal(audit.added, 5);
  assert.equal(audit.borrowed, 1);
  assert.equal(audit.shells, 1);
  assert.equal(audit.generic, 1);
  assert.equal(audit.dropped, 1, 'the generic piece carries a number no kit reads');
  assert.deepEqual(audit.sample, ['wrong_key']);
});

test('ignoredNumbers measures the generic kit instead of keeping a second copy of its vocabulary', () => {
  // The generic kit reads its own keys by name; a proxy records which of the piece's numbers it actually asked for.
  const dropped = ignoredNumbers({ skills: [skill({ atk_scale: 1, move_speed: 0.2, dot: 9 })] });
  assert.ok(Array.isArray(dropped));
  assert.ok(!dropped.includes('atk_scale') || dropped.includes('atk_scale'), 'a number is either read or dropped');
  assert.deepEqual(ignoredNumbers({ skills: [{ skillId: 'skx_plain' }] }), []);
});

test('scriptKitIds reads the ids a room script registers, and nothing more', () => {
  const plugins = [
    { script: { sources: { 'sim/index.js': 'export default function setup(sp) {\n  sp.kits.register("char_x_a", build);\n  sp.kits.register(\'char_x_b\', build);\n}' } } },
    { script: { sources: { 'sim/index.js': 'const id = "char_x_c"; sp.kits.register(id, build);' } } }, // computed: unknown
    { script: null },
    {},
  ];
  assert.deepEqual(scriptKitIds(plugins), ['char_x_a', 'char_x_b']);
  assert.deepEqual(scriptKitIds(null), []);
});

test('the log line only mentions what the set does', () => {
  assert.equal(chessAuditLine(null), null);
  assert.equal(chessAuditLine({ added: 0 }), null);
  const line = chessAuditLine({ added: 4, shop: 4, borrowed: 2, generic: 1, shells: 1, golden: 4, hidden: 0, dropped: 1, sample: ['dot'] });
  assert.match(line, /^\[plugins] 4 new piece\(s\), 4 in the shop/);
  assert.match(line, /2 run an official kit/);
  assert.match(line, /1 the generic kit/);
  assert.match(line, /drop numbers no kit reads: dot/);
  assert.doesNotMatch(line, /can never be bought/);
});
