// 缪尔赛思's 特质 garrison_76 hands out 变形同构体, and the band 变形者集群 hands out the same item at R5 / R10 / R15.
// That item is a VI-tier SHOP item, so 0.2.4's shared inventory (DESIGN §29.8) put it under the tier's stock count —
// but it is the only equipment a trait or a strategy can grant, and every copy the team holds occupies that stock
// (SharedItemPool.held counts the hand, the temp area and the equipped slots). The measured tier VI count is small, so
// the traits ran into the shop cap mid-match: PlayerState.acquireItem refused the grant (`itemPool.canGain`) and dropped
// it with 「装备库存不足，未获得该装备」. The worst case was the elite's order of two — garrison_76_b — which failed whole
// while two copies were already held. These tests pin that a GAIN keeps delivering: the ceiling of the table must leave
// room for every grant route the data has (tools/build-data.mjs `itemStock` carries the 变形同构体 override and
// data/config.json the matching economy count, 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, legalTileFor, checkInvariants, DATA } from './harness.js';

const ISO = 'chess_item_6_09_e_a';
const MLYSS = 'chess_char_6_11_a';
/** Every copy of `id` the player owns, the equipped slots included (SharedItemPool.held reads the same three areas). */
const owned = (ps, id) => {
  let n = 0;
  for (const p of [...ps.hand, ...ps.temp]) if (p && p.kind === 'item' && p.id === id) n++;
  for (const c of ps.allChess()) for (const it of c.items || []) if (it.id === id) n++;
  return n;
};

/** PREP R1 of a real match; the player keeps nothing but money, like the stock suites (test/match/shared-stock.test.js). */
function prep({ seed = 21 } = {}) {
  const h = makeMatch({ mode: 'solo', seed, fake: true }).start();
  h.toPrep(1);
  const ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); ps.offers.length = 0;
  ps.funds = 50; ps.bandId = null;
  ps.recompute();
  return { h, m: h.m, ps };
}
/** Put 缪尔赛思 in shop slot `n` and buy her (6 = her tier VI price); returns the handler's reply. */
function buyMlyss(m, ps, n) {
  ps.shop.slots[n] = { kind: 'chess', id: MLYSS, price: 6, basePrice: 6, sold: false, frozen: false };
  return m.handle('p_0', { t: 'g.buy', slot: n });
}

test('the trait keeps delivering after the team holds the whole tier VI stock (garrison_76)', () => {
  const { m, ps } = prep();
  const cap = m.itemPool.cap(ISO);
  assert.ok(Number.isInteger(cap) && cap > 0, `变形同构体 is a capped shop item (cap ${cap})`);

  // Two copies held is the worst case the report describes: the elite's order of two then met an empty stock.
  assert.ok(ps.acquireItem(ISO), 'the first copy');
  assert.ok(ps.acquireItem(ISO), 'the second copy');
  assert.equal(owned(ps, ISO), 2);
  assert.equal(m.itemPool.left(ISO), cap - 2, 'both copies occupy the shared stock');

  assert.deepEqual(buyMlyss(m, ps, 0), { ok: true }, 'bought 缪尔赛思');
  assert.equal(owned(ps, ISO), 3, 'garrison_76 delivered its 变形同构体 past the copies already held');

  checkInvariants(m);
  m.dispose();
});

/** Distinct plain equipment: a repeated id would merge and break the harness's "merges are immediate" invariant. */
const fillerIds = (n) => Object.values(DATA.items)
  .filter((it) => it.itemType === 'EQUIP' && !it.isGolden && it.kind === 'passive' && it.id !== ISO)
  .map((it) => it.id).sort().slice(0, n);

test('one slot short is harmless: with the hand full and temp empty the operator and its item both overflow to temp', () => {
  const { h, m, ps } = prep({ seed: 24 });
  // The hand FULL and the temp area EMPTY is the case the hand gate (economy.js buy / prep.js pickReward: freeSlot(hand))
  // refuses for a PURCHASE — 「整备区已满」. A trait is not gated that way: the gain happens and stow (pieces.js) tries the
  // hand, then temp, so BOTH the operator and its 变形同构体 land in temp and nothing is lost. This is the ordinary case
  // and the reason the report needed the whole 整备区 full, not one slot.
  ps.hand[0] = ps.newPiece('item', ISO);
  const fill = fillerIds(ps.hand.length);
  for (let i = 1; i < ps.hand.length; i++) ps.hand[i] = ps.newPiece('item', fill[i - 1]);
  ps.recompute();
  assert.equal(ps.hand.filter((x) => x === null).length, 0, 'the hand is full');
  assert.equal(ps.temp.filter((x) => x === null).length, ps.temp.length, 'the temp area is empty');
  assert.equal(owned(ps, ISO), 1, 'one copy held');

  assert.ok(ps.acquireChess(MLYSS, { source: 'probe' }), 'the operator is gained');
  assert.equal(owned(ps, ISO), 2, 'the trait gift arrived: it overflowed into temp beside the operator');
  assert.equal(h.logs.warn.filter((w) => /整备区已满/.test(w)).length, 0, 'nothing was destroyed with a warning');
  checkInvariants(m);
  m.dispose();
});

test('KNOWN GAP: a board-tile merge with the whole 整备区 full loses the trait gift silently', () => {
  const { h, m, ps } = prep({ seed: 25 });
  // The one route where the operator costs NO stash slot: two copies are deployed, so the third completes the merge onto
  // the consumed copy's tile (acquire.js _mergeChess, mergeTile). Nothing is freed for the items — the consumed copies'
  // own equipment comes off into the same full stash (returned, and destroyed with a log warning when even the elite's
  // two slots are taken) — and garrison_76_b's order of two then hits acquireItem's stock/stow gate. ctx.grantItem does
  // not pass `requirePool` through to acquireItem (effectsMeta.js), so nothing compensates, and unlike a PURCHASE this
  // path has no hand gate and no `m.toast`: the loss is invisible.
  // Pinned as the CURRENT behaviour so that a fix (an overflow rule for trait grants, or a gate on the gain) shows up
  // here as a change instead of passing unnoticed.
  for (let i = 0; i < 2; i++) give(m, ps, MLYSS, 'board', legalTileFor(m, ps, MLYSS, new Set([...ps.board.keys()])));
  ps.hand[0] = ps.newPiece('item', ISO);
  const fill = fillerIds(ps.hand.length + ps.temp.length);
  for (let i = 1; i < ps.hand.length; i++) ps.hand[i] = ps.newPiece('item', fill[i - 1]);
  for (let i = 0; i < ps.temp.length; i++) ps.temp[i] = ps.newPiece('item', fill[ps.hand.length - 1 + i]);
  ps.recompute();
  assert.equal(ps.hand.filter((x) => x === null).length + ps.temp.filter((x) => x === null).length, 0, 'the whole 整备区 is full');

  const elite = ps.acquireChess(MLYSS, { source: 'probe' });
  assert.equal(elite && elite.id, 'chess_char_6_11_b', 'the elite was merged onto the deployed copy\'s tile');
  assert.equal(owned(ps, ISO), 1, 'CURRENT: the elite order of two was dropped — the gain reached no stash slot');
  assert.equal(h.logs.warn.filter((w) => /整备区已满|获得.*返还/.test(w)).length, 0, 'CURRENT: and it says nothing, so the loss is invisible');
  checkInvariants(m);
  m.dispose();
});

test('the stock of the table itself is enough for the elite order of two (garrison_76_b)', () => {
  const { m, ps } = prep({ seed: 22 });
  const cap = m.itemPool.cap(ISO);
  // the trait of the three normal copies bought in a match, then the elite's own order of two
  assert.ok(cap >= 5, `the ceiling must cover 1 + 1 + 1 + 2 grants of one match (cap ${cap})`);
  for (let i = 0; i < 3; i++) assert.ok(ps.acquireItem(ISO), `the three normal gains (${i + 1})`);
  assert.equal(m.itemPool.left(ISO), cap - 3, 'three copies of the stock are held');
  for (let i = 0; i < 2; i++) assert.ok(ps.acquireItem(ISO), `the elite's order of two (${i + 1})`);
  assert.equal(owned(ps, ISO), 5, 'every grant of the route arrived');
  assert.ok(m.itemPool.left(ISO) >= 0, 'the stock is not overdrawn');
  checkInvariants(m);
  m.dispose();
});

test('a match that buys 缪尔赛思 four times keeps every grant (three normal + the elite\'s two)', () => {
  const { h, m, ps } = prep({ seed: 23 });
  for (let i = 0; i < 4; i++) assert.deepEqual(buyMlyss(m, ps, i), { ok: true }, `buy ${i + 1}`);
  // 1 + 1 + 1 from the normal copies, then the elite the third one merged into orders two more
  assert.equal(owned(ps, ISO), 5, 'all five grants of the route were delivered');
  h.invariants();
  m.dispose();
});
