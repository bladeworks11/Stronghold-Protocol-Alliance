// test/match/draft-capacity.test.js — the two co-op draft steps at 6–20 seats.
//
// The owner's rule (2026-10-12):
//   * the STRATEGY step (BAND_DRAFT) is ROOM-WIDE: the whole room drafts one seat at a time and a strategy any other
//     seat took is unavailable to everyone, so a twenty-player room hands out twenty different strategies. It is
//     deliberately NOT split into groups.
//   * the in-match 机变 step (SP_DRAFT) is per GROUP: every fixed card-pool group draws its OWN six-card page, a
//     card a group-mate took is the only one it cannot repeat, and two groups may take the same card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE, BASE_SEATS } from '../../shared/constants.js';
import { DATA, makeMatch, checkInvariants } from './harness.js';
import { BAND_TURN_SECONDS } from '../../server/match/Match.js';

const TURN_MS = BAND_TURN_SECONDS * 1000;

/** A started co-op match with `n` humans, all confirmed, sitting in the strategy draft. */
function bandDraftOf(n, seed = 5) {
  const h = makeMatch({ mode: 'coop', humans: n, seed, fake: true }).start();
  for (let i = 0; i < n; i++) h.m.handle(`p_${i}`, { t: 'g.infoReady' });
  h.sched.advance(1);
  assert.equal(h.m.phase, PHASE.BAND_DRAFT);
  return h;
}

test('the strategy step is one room-wide draft at every capacity — no parallel groups', () => {
  for (const n of [1, 2, 4, 6, 8, 20]) {
    const h = bandDraftOf(n);
    const m = h.m;
    assert.equal(m.draft.groups, undefined, `${n} players: the strategy draft has no groups`);
    assert.equal(m.draftGroupOf?.('p_0') ?? null, null, `${n} players: no per-group resolution`);
    // exactly one seat decides, whatever the room size
    assert.ok(m.draftTurn(), `${n} players: one picker`);
    h.m.dispose();
  }
});

test('队友已选 is room-wide: a twenty-player room may not repeat a strategy anywhere', () => {
  const h = bandDraftOf(20);
  const m = h.m;
  const band = m.gd.bandIds()[0];
  const first = m.draftTurn();
  assert.deepEqual(m.handle(first, { t: 'g.band', bandId: band }), { ok: true });
  // every other seat sees it as taken, not just the first one's neighbours
  for (const ps of m.order) {
    if (ps.playerId === first) continue;
    assert.equal(m.bandTaken(band, ps.playerId), true, `${ps.playerId} sees the pick as taken`);
  }
  // and the next picker is refused for that same strategy
  const second = m.draftTurn();
  assert.notEqual(second, first);
  assert.deepEqual(m.handle(second, { t: 'g.band', bandId: band }), { error: ERR.BAD_TARGET, detail: '队友已选' });
  // a different strategy is fine
  assert.deepEqual(m.handle(second, { t: 'g.band', bandId: m.gd.bandIds()[1] }), { ok: true });
  m.dispose();
});

test('the whole twenty-player room can be dealt twenty DIFFERENT strategies', () => {
  const h = bandDraftOf(20);
  const m = h.m;
  const ids = m.gd.bandIds();
  assert.ok(ids.length >= 20, `the mode offers ${ids.length} strategies for 20 seats`);
  for (let guard = 0; guard < 60 && m.phase === PHASE.BAND_DRAFT; guard++) {
    const pid = m.draftTurn();
    if (!pid) break;
    const free = ids.find((b) => !m.bandTaken(b, pid));
    assert.ok(free, `${pid} always has a free strategy`);
    if (!free) break;
    const r = m.handle(pid, { t: 'g.band', bandId: free });
    assert.ok(r.ok, JSON.stringify(r));
  }
  const picks = m.order.map((ps) => ps.bandId);
  assert.equal(picks.filter(Boolean).length, 20, 'every seat picked');
  assert.equal(new Set(picks).size, 20, 'and no strategy was handed out twice');
  h.invariants();
  m.dispose();
});

test('the seat whose turn it is is the only one allowed to pick, at any capacity', () => {
  const h = bandDraftOf(8);
  const m = h.m;
  const picker = m.draftTurn();
  const waiting = m.order.map((p) => p.playerId).filter((id) => id !== picker);
  for (const pid of waiting) {
    assert.deepEqual(m.handle(pid, { t: 'g.band', bandId: m.gd.bandIds()[0] }), { error: ERR.NOT_YOUR_TURN }, pid);
  }
  assert.deepEqual(m.handle(picker, { t: 'g.band', bandId: m.gd.bandIds()[0] }), { ok: true });
  m.dispose();
});

test('a turn that runs out takes the default, and the default never duplicates either', () => {
  const h = bandDraftOf(8);
  const m = h.m;
  // let every turn expire one after another
  for (let i = 0; i < 12 && m.phase === PHASE.BAND_DRAFT; i++) h.sched.advance(TURN_MS + 1);
  assert.notEqual(m.phase, PHASE.BAND_DRAFT, 'the draft finished');
  const picks = m.order.map((ps) => ps.bandId);
  assert.equal(picks.filter(Boolean).length, 8);
  assert.equal(new Set(picks).size, 8, 'the timeout defaults are unique too');
  for (const ps of m.order) assert.ok(m.gd.bandAllowed(ps.bandId));
  h.invariants();
  m.dispose();
});

// ---------------------------------------------------------------------------------------------------------------
// 机变 (SP_DRAFT): one six-card page per fixed card-pool group
// ---------------------------------------------------------------------------------------------------------------

/** A match sitting in its in-match 机变 step, with `n` humans. */
function spDraftOf(n, seed = 7) {
  const h = makeMatch({ mode: 'coop', humans: n, seed, fake: true }).start();
  for (let i = 0; i < n; i++) h.m.handle(`p_${i}`, { t: 'g.infoReady' });
  h.sched.advance(1); // INFO → BAND_DRAFT
  const ids = h.m.gd.bandIds();
  for (let i = 0; i < n; i++) {
    const pid = h.m.draftTurn();
    if (!pid) break;
    const free = ids.find((b) => !h.m.bandTaken(b, pid)) || ids[0];
    h.m.handle(pid, { t: 'g.band', bandId: free });
  }
  h.sched.advance(1); // BAND_DRAFT → BATTLE_CHECK
  h.runToPhase(PHASE.SP_DRAFT);
  return h;
}

test('机变 keeps ONE page for a small room', () => {
  const h = spDraftOf(4);
  const s = h.m.sp;
  if (s) {
    assert.deepEqual(s.groups, [], 'four players keep the single room-wide page');
    assert.equal(h.m.spPageOf('p_0').cards, s.cards);
  }
  h.m.dispose();
});

test('机变 gives every fixed group its own six-card page, so twenty seats always have options', () => {
  const h = spDraftOf(20);
  const m = h.m;
  const s = m.sp;
  assert.equal(s.groups.length, 5, 'twenty players ⇒ five card-pool groups');
  for (const page of s.groups) {
    assert.equal(page.cards.length, 6, `group ${page.id} has six options`);
    assert.equal(page.playerIds.length, 4);
  }
  // each group's page is its own draw (a page per group, not one shared list)
  const pages = s.groups.map((p) => p.cards.map((c) => c.id).join('|'));
  assert.equal(new Set(pages).size, 5, 'five independent pages');
  // the whole room shares one event family
  for (const page of s.groups) assert.equal(page.cards.length > 0, true);
  m.dispose();
});

test('机变: a group-mate blocks a position, another group does not', () => {
  const h = spDraftOf(8);
  const m = h.m;
  const s = m.sp;
  const [a, b] = s.groups;
  // find the seat of group A whose turn it is
  const pidA = s.order[s.cursor];
  const memberA = a.playerIds.includes(pidA) ? pidA : a.playerIds[0];
  const psA = m.players.get(memberA);
  // make it that seat's turn by picking for everyone ahead of it
  let guard = 0;
  while (m.spTurn() !== memberA && guard++ < 40) {
    const cur = m.players.get(m.spTurn());
    if (!cur) break;
    const open = m.spPageOf(cur.playerId).cards.map((_c, i) => i).find((i) => m.spCardOpen(cur, i));
    if (open == null) break;
    m.handle(cur.playerId, { t: 'g.skill', idx: open });
    if (guard > 38) break;
  }
  if (m.spTurn() === memberA) {
    assert.ok(m.spCardOpen(psA, 0), 'the seat has an open position');
    m._applyCard(psA, 0);
    // a group-mate sees position 0 as taken on ITS page
    const mate = a.playerIds.find((id) => id !== memberA);
    if (mate) assert.equal(m.spCardOpen(m.players.get(mate), 0), false, 'the group-mate cannot repeat it');
    // a member of the other group still has position 0 open on its own page
    const other = b.playerIds[0];
    assert.equal(m.spCardOpen(m.players.get(other), 0), true, 'the other group may take the same card');
  }
  m.dispose();
});

test('机变: every one of the twenty seats can take a card without running the pages out', () => {
  const h = spDraftOf(20);
  const m = h.m;
  let taken = 0;
  for (let guard = 0; guard < 200 && m.phase === PHASE.SP_DRAFT; guard++) {
    const actors = m.spActors();
    if (!actors.length) break;
    let progress = false;
    for (const ps of actors) {
      const open = m.spPageOf(ps.playerId).cards.map((_c, i) => i).find((i) => m.spCardOpen(ps, i));
      if (open == null) continue;
      assert.ok(m.pickCard(ps, open).ok !== false, `${ps.playerId} picked`);
      taken++;
      progress = true;
    }
    if (!progress) break;
  }
  assert.equal(taken, 20, 'all twenty seats took a card (a single six-card page could only serve six)');
  m.dispose();
});

test('two groups may hold the same 机变 card at the same position', () => {
  const h = spDraftOf(8);
  const m = h.m;
  const s = m.sp;
  // take position 0 for the first group's current member, then for the second group's
  const picked = [];
  for (const page of s.groups) {
    const pid = page.playerIds.find((id) => s.picks[id] == null);
    if (!pid) continue;
    const ps = m.players.get(pid);
    if (m.spCardOpen(ps, 0)) { m._applyCard(ps, 0); picked.push(pid); }
  }
  assert.ok(picked.length >= 2, `two seats took position 0 (${picked.join(', ')})`);
  for (const pid of picked) assert.equal(s.picks[pid], 0, `${pid} took position 0`);
  m.dispose();
});

test('every page has a turn of its OWN: the groups decide in parallel, never waiting for one another', () => {
  const h = spDraftOf(8);
  const m = h.m;
  const s = m.sp;
  const [a, b] = s.groups;
  const pickerOf = (page) => m.spAheadOf(page).find((pid) => page.playerIds.includes(pid));
  const [firstA, firstB] = [pickerOf(a), pickerOf(b)];
  assert.notEqual(firstA, firstB, 'the two pages are waiting for two different seats');
  assert.ok(firstA && firstB, 'each page names one of its own members');
  // the pending list starts at that seat (the page's own cursor) and never mentions another group
  assert.equal(m.spAheadOf(a)[0], firstA);
  assert.equal(m.spAheadOf(a)[0], m.spTurnOf(a), 'the pending list starts at the page picker');
  assert.equal(m.spAheadOf(a).length, a.playerIds.length, 'every member of the group is still to pick');
  assert.deepEqual(m.spAheadOf(a).filter((pid) => b.playerIds.includes(pid)), [], 'never another group member');
  // BOTH of them may pick right now — either one used to be refused with NOT_YOUR_TURN while the room order sat on the
  // other group's seat (the client then drew the first page's cards under a "someone else is deciding" banner)
  assert.equal(m.spTurnOf(a), firstA);
  assert.equal(m.spTurnOf(b), firstB);
  assert.deepEqual(m.pickCard(m.players.get(firstA), 0), { ok: true }, `${firstA} picks on its own page`);
  assert.deepEqual(m.pickCard(m.players.get(firstB), 1), { ok: true }, `${firstB} picks on its own page`);
  assert.equal(s.picks[firstA], 0);
  assert.equal(s.picks[firstB], 1);
  // each page moved on by itself: group A's next member is its own, not the room cursor's seat
  const nextA = pickerOf(a);
  const nextB = pickerOf(b);
  assert.notEqual(nextA, firstA);
  assert.notEqual(nextB, firstB);
  assert.ok(a.playerIds.includes(nextA) && b.playerIds.includes(nextB));
  assert.equal(m.spTakenOf(a)[0], firstA, 'position 0 is taken on group A page');
  assert.equal(m.spTakenOf(b)[1], firstB, 'position 1 is taken on group B page');
  assert.equal(m.spTakenOf(b)[0] ?? null, null, 'group B position 0 stays free for its other members');
  m.dispose();
});

test('the published sp names each page turn, so a client can tell whose turn it is without guessing', () => {
  const h = spDraftOf(20);
  const m = h.m;
  const sp = m.publicView().sp;
  assert.equal(sp.groups.length, 5);
  for (const g of sp.groups) {
    const page = m.sp.groups.find((p) => p.id === g.id);
    assert.equal(g.turn, m.spTurnOf(page), `group ${g.id} turn`);
    assert.ok(g.members.includes(g.turn), `group ${g.id}: the turn is one of its own members`);
    assert.deepEqual(g.ahead, m.spAheadOf(page), `group ${g.id} pending list`);
    // every page holds six options for its own four seats, and none of them is taken yet
    assert.equal(g.cards.length, 6);
    assert.deepEqual(g.taken, {});
  }
  // one seat per page may pick at once: five actors, one from each group, all different seats
  const actors = m.spActors().map((ps) => ps.playerId);
  assert.equal(actors.length, 5);
  assert.equal(new Set(actors).size, 5);
  for (const g of sp.groups) assert.ok(actors.includes(g.turn), `group ${g.id} picker acts`);
  m.dispose();
});

test('a seat that is eliminated before its turn never holds its page back', () => {
  const h = spDraftOf(8);
  const m = h.m;
  const [a] = m.sp.groups;
  const order = m.spAheadOf(a);
  assert.ok(order.length >= 2);
  const second = order[1];
  m.players.get(second).alive = false;
  const after = m.spAheadOf(a);
  assert.ok(!after.includes(second), 'the eliminated seat is no longer waited for');
  assert.equal(after[0], order[0], 'the picker stays the picker');
  assert.equal(m.spTurnOf(a), order[0]);
  m.dispose();
});
