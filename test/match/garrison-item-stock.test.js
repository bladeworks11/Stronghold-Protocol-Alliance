// 缪尔赛思's 特质 garrison_76 hands out 变形同构体, and the band 变形者集群 hands out the same item at R5 / R10 / R15.
// That item is a VI-tier SHOP item, so 0.2.4's shared inventory (DESIGN §29.8) put it under the tier's stock count and
// every copy the team held occupied that stock (SharedItemPool.held reads the hand, the temp area and the equipped
// slots). The measured tier VI count is 3, so a trait ran into the shop cap mid-match: PlayerState.acquireItem refused
// the grant (`itemPool.canGain`) and dropped it with 「装备库存不足，未获得该装备」 — worst of all the elite's order of two
// (garrison_76_b), which failed whole while two copies were already held. 0.2.4 raised that ONE item's count to 9
// (tools/build-data.mjs `itemStock`), which also raised what the 调度中心 sold.
//
// The user's correction of 2026-10-12 replaces the workaround with the rule: the shared stock is the SHOP's — a
// purchase, a reward pick and a choice card consult it and occupy it — while equipment an EFFECT hands out (a 特质, a
// strategy, a bond, an item) is neither gated by it nor counted in it (acquireItem's `noStock` / `piece.stockCost`,
// Match.rollItemId's `ignoreStock`). 变形同构体 therefore sells at the measured tier VI count of 3 again, like every
// other tier-VI item, while the trait keeps delivering without a ceiling.
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
function prep({ seed = 21, data = undefined } = {}) {
  const h = makeMatch({ mode: 'solo', seed, fake: true, data }).start();
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
/** Item id of another tier-VI shop item (the stock 变形同构体 must match now that its override is gone). */
const tier6Item = Object.values(DATA.items)
  .filter((it) => !it.isGolden && it.tier === 6 && it.id !== ISO && !it.shopExcluded && it.itemType === 'EQUIP')
  .map((it) => it.id).sort()[0];

test('变形同构体 sells at the tier VI count again, like every other tier-VI item', () => {
  const { m, ps } = prep();
  const cap = m.itemPool.cap(ISO);
  assert.equal(cap, 3, `the measured tier VI count (DESIGN §29.8), not a raised override (cap ${cap})`);
  assert.equal(cap, m.itemPool.cap(tier6Item), `${tier6Item} carries the same tier VI count`);
  for (let i = 0; i < cap; i++) assert.ok(ps.acquireItem(ISO), `the shop copy ${i + 1}`);
  assert.equal(m.itemPool.left(ISO), 0, 'a purchase occupies the stock and sells the shop out');
  assert.equal(m.itemPool.canGain(ISO), false);
  checkInvariants(m);
  m.dispose();
});

test('the trait keeps delivering after the shop is sold out (garrison_76)', () => {
  const { m, ps } = prep();
  const cap = m.itemPool.cap(ISO);
  // Buy the whole tier VI stock first: the trait's grant must not consult it any more.
  for (let i = 0; i < cap; i++) assert.ok(ps.acquireItem(ISO), `the shop copy ${i + 1}`);
  assert.equal(owned(ps, ISO), cap);
  assert.equal(m.itemPool.left(ISO), 0, 'the shop is sold out');
  assert.equal(m.itemPool.held(ISO), cap, 'shop copies occupy the stock');

  assert.deepEqual(buyMlyss(m, ps, 0), { ok: true }, 'bought 缪尔赛思');
  assert.equal(owned(ps, ISO), cap + 1, 'garrison_76 delivered its 变形同构体 past the sold-out shop');
  assert.equal(m.itemPool.held(ISO), cap, 'and the granted copy took no stock');
  assert.equal(m.itemPool.left(ISO), 0, 'the shop stays sold out');
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
  // hand, then temp, so BOTH the operator and its 变形同构体 land in temp and nothing is lost.
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

test('the whole route of a match arrives, off the shop stock (three normal traits + the elite order of two)', () => {
  const { h, m, ps } = prep({ seed: 23 });
  for (let i = 0; i < 4; i++) assert.deepEqual(buyMlyss(m, ps, i), { ok: true }, `buy ${i + 1}`);
  // 1 + 1 + 1 from the normal copies, then the elite the third one merged into orders two more
  assert.equal(owned(ps, ISO), 5, 'all five grants of the route were delivered');
  assert.equal(m.itemPool.held(ISO), 0, 'no granted copy occupies the shop stock');
  assert.equal(m.itemPool.left(ISO), m.itemPool.cap(ISO), 'so the 调度中心 still sells its own three');
  h.invariants();
  m.dispose();
});

test('a sold-out shop does not shorten the route either (garrison_76_b)', () => {
  const { m, ps } = prep({ seed: 22 });
  const cap = m.itemPool.cap(ISO);
  for (let i = 0; i < cap; i++) assert.ok(ps.acquireItem(ISO), `the shop copy ${i + 1}`);
  assert.equal(m.itemPool.canGain(ISO), false, 'the shop is sold out');
  for (let i = 0; i < 4; i++) assert.deepEqual(buyMlyss(m, ps, i), { ok: true }, `buy ${i + 1}`);
  assert.equal(owned(ps, ISO), cap + 5, 'the shop copies plus all five grants');
  assert.equal(m.itemPool.held(ISO), cap, 'only the shop copies occupy stock');
  checkInvariants(m);
  m.dispose();
});

test('an effect\'s own item draw ignores the stock; the shop\'s draws keep it', () => {
  // One copy per tier-VI item makes the gate directly observable: the tier can be exhausted within the 整备区.
  const data = structuredClone(DATA);
  data.config.economy.itemPoolCopiesOverrides = {};
  data.config.economy.itemPoolCopies = { ...data.config.economy.itemPoolCopies, 6: 1 };
  const { m, ps } = prep({ seed: 26, data });
  const tier6 = Object.values(data.items)
    .filter((it) => !it.isGolden && it.itemType === 'EQUIP' && !it.shopExcluded && it.tier === 6)
    .map((it) => it.id);
  assert.ok(tier6.length > 1);
  for (const id of tier6) assert.ok(ps.acquireItem(id), id);
  assert.equal(m.itemPool.canGain(tier6[0]), false, 'the whole tier is sold out');
  // ctx.rollItem / ctx.rollPool (effectsMeta) draw a trait's 定制品 or a strategy's random equipment with
  // `ignoreStock`; the 调度中心 / 机密商店 / 道具补给 draws (choices.js, spDraft) leave it false.
  assert.equal(m.rollItemId({ tier: 6, player: ps }), null, 'the shop draw has nothing left of tier VI');
  assert.ok(m.rollItemId({ tier: 6, player: ps, ignoreStock: true }), 'an effect draw still finds one');
  m.dispose();
});

test('an effect\'s item offer ignores the stock too, and its pick takes none', () => {
  const { m, ps } = prep({ seed: 27 });
  const cap = m.itemPool.cap(ISO);
  for (let i = 0; i < cap; i++) assert.ok(ps.acquireItem(ISO), `the shop copy ${i + 1}`);
  assert.equal(m.itemPool.canGain(ISO), false, 'the shop is sold out');
  // ctx.offerItems (a strategy's 特殊装备, 凯瑟琳 定向投放 的装备池) keeps a sold-out item on the list; the family default
  // (a shop-sourced offer) still filters it out.
  assert.equal(ps.pushItemOffer([ISO], { source: 'band' }), null, 'a shop-sourced offer drops it');
  assert.ok(ps.pushItemOffer([ISO], { source: 'band', noStock: true }), 'an effect offer lists it');
  ps.recompute();
  assert.ok(ps.pickReward(0).ok, 'the pick goes through');
  assert.equal(owned(ps, ISO), cap + 1, 'the picked copy arrived');
  assert.equal(m.itemPool.held(ISO), cap, 'and took no shop stock');
  checkInvariants(m);
  m.dispose();
});

test('KNOWN GAP: a board-tile merge with the whole 整备区 full loses the trait gift silently', () => {
  const { h, m, ps } = prep({ seed: 25 });
  // The one route where the operator costs NO stash slot: two copies are deployed, so the third completes the merge onto
  // the consumed copy's tile (acquire.js _mergeChess, mergeTile). Nothing is freed for the items — the consumed copies'
  // own equipment comes off into the same full stash (returned, and destroyed with a log warning when even the elite's
  // two slots are taken) — and garrison_76_b's order of two then finds no stash slot for its items. The STOCK no longer
  // refuses it (the grants take none), so this is purely the 整备区's own limit; ctx.grantItem reports it as a toast, not
  // a log warning, so the loss stays invisible.
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
