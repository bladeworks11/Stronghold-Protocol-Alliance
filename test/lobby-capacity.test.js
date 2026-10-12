// test/lobby-capacity.test.js — co-op room capacity (4/8/10/16/20 seats) and the seat-index ceiling of the wire
// protocol. Ported in spirit from LongQianChen/Stronghold-Protocol feat/IncreasePlayerCapacity.
//
// What this pins down:
//   * a co-op room is created with an explicit capacity, defaults to DEFAULT_SEATS, and only accepts ROOM_CAPACITIES;
//   * the host may resize before the match, members above a smaller ceiling are COMPACTED DOWNWARDS (never dropped)
//     and keep their ready flag;
//   * the seat array always matches `capacity`, so seat indices stay inside 0..capacity-1;
//   * the protocol accepts seats 0..MAX_SEATS-1 and refuses MAX_SEATS and above, for room.removeBot and room.kick.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { BOT_NAMES } from '../server/lobby.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, MAX_SEATS, DEFAULT_SEATS, ROOM_CAPACITIES } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';

function clientPool(getUrl) {
  const open = new Set();
  return {
    async connect() { const c = await TestClient.connect(getUrl()); open.add(c); return c; },
    async player(name, token) {
      const c = await this.connect();
      const w = await c.hello(name, token);
      c.id = w.playerId;
      c.token = w.token;
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}
const quietLog = () => {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
};
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const err = async (c, msg, code) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'error', `${msg.t}: ${JSON.stringify(r)}`);
  if (code) assert.equal(r.code, code, JSON.stringify(r));
  return r;
};
const seatOf = (state, id) => state.seats.find((s) => s && s.playerId === id) || null;
async function createRoom(c, capacity = null) {
  const msg = { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' };
  if (capacity != null) msg.capacity = capacity;
  await ok(c, msg);
  return c.waitFor('room.state', (s) => s.hostId === c.id);
}

describe('co-op room capacity', () => {
  let srv;
  let pool;
  const cap = quietLog();
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: StubMatch, lobbyGraceMs: 60_000 });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  test('constants: 20 seats are the ceiling, 8 is the default, only 4/8/10/16/20 are offered', () => {
    assert.equal(MAX_SEATS, 20);
    assert.equal(DEFAULT_SEATS, 8);
    assert.deepEqual([...ROOM_CAPACITIES], [4, 8, 10, 16, 20]);
  });

  test('protocol: seat indices are 0..MAX_SEATS-1 and capacity is a listed value', () => {
    const playerId = 'p_0123456789';
    assert.equal(validateC2S({ t: 'room.removeBot', seat: 0 }), null);
    assert.equal(validateC2S({ t: 'room.removeBot', seat: MAX_SEATS - 1 }), null);
    assert.notEqual(validateC2S({ t: 'room.removeBot', seat: MAX_SEATS }), null, 'seat 20 is out of range');
    assert.equal(validateC2S({ t: 'room.kick', seat: MAX_SEATS - 1, playerId }), null);
    assert.notEqual(validateC2S({ t: 'room.kick', seat: MAX_SEATS, playerId }), null);
    for (const c of ROOM_CAPACITIES) {
      assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: c }), null, `capacity ${c}`);
      assert.equal(validateC2S({ t: 'room.setCapacity', capacity: c }), null, `setCapacity ${c}`);
    }
    assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }), null, 'capacity stays optional');
    assert.notEqual(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 5 }), null);
    assert.notEqual(validateC2S({ t: 'room.setCapacity', capacity: 5 }), null);
    assert.notEqual(validateC2S({ t: 'room.setCapacity' }), null, 'capacity is required');
  });

  test('each offered capacity yields that many seats; an unlisted capacity is refused', async () => {
    for (const capacity of ROOM_CAPACITIES) {
      const host = await pool.player(`H${capacity}`);
      const st = await createRoom(host, capacity);
      assert.equal(st.capacity, capacity, `capacity ${capacity}`);
      assert.equal(st.seats.length, capacity, `capacity ${capacity}: seat array`);
      assert.equal(st.seats[0].playerId, host.id);
      assert.deepEqual(st.seats.slice(1), new Array(capacity - 1).fill(null));
      await ok(host, { t: 'room.leave' });
    }
    const host = await pool.player('Bad');
    const defaulted = await createRoom(host);
    assert.equal(defaulted.capacity, DEFAULT_SEATS, 'no capacity ⇒ the default');
    await err(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 5 }, ERR.BAD_MSG);
  });

  test('the AI name list covers every seat and holds no duplicate', () => {
    // a twenty-seat room seats up to MAX_SEATS - 1 AI teammates, and each name is drawn at RANDOM (never in list order)
    assert.ok(BOT_NAMES.length >= MAX_SEATS - 1, `${BOT_NAMES.length} names for up to ${MAX_SEATS - 1} AI seats`);
    assert.equal(new Set(BOT_NAMES).size, BOT_NAMES.length, 'no duplicate names in the list');
    assert.ok(BOT_NAMES.every((n) => n.startsWith('AI·')), 'every name is an AI name');
    // the last names the owner asked for are present
    for (const n of ['AI·史尔特尔', 'AI·Mon3tr', 'AI·逻各斯', 'AI·阿斯卡纶', 'AI·黑角']) {
      assert.ok(BOT_NAMES.includes(n), `${n} is in the list`);
    }
  });

  test('a twenty-seat room accepts nineteen AI teammates: seat 19 is reachable, seat 20 is not', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host, 20);
    for (let i = 0; i < MAX_SEATS - 1; i++) await ok(host, { t: 'room.addBot' });
    // `waitFor` returns the OLDEST matching frame, so every predicate below must be unreachable by an earlier frame
    // (an occupied-count or a bot-count that only grows) — matching on `seats[19] === null` would hit the empty room.
    const full = await host.waitFor('room.state', (s) => s.seats.filter(Boolean).length === MAX_SEATS);
    assert.equal(full.seats.length, 20);
    assert.equal(full.seats[19].isBot, true, 'the top seat is usable');
    assert.equal(seatOf(full, host.id).seat, 0);
    // every AI got a listed name and no two share one (the draw avoids reuse)
    const botNames = full.seats.filter((s) => s && s.isBot).map((s) => s.name);
    assert.equal(botNames.length, MAX_SEATS - 1);
    assert.equal(new Set(botNames).size, MAX_SEATS - 1, 'nineteen different names');
    for (const n of botNames) assert.ok(BOT_NAMES.includes(n), `${n} came from the list`);
    assert.ok(botNames.every((n) => !/^AI·\d+$/.test(n)), 'no numbered fallback name');
    // full: no seat left, and the protocol refuses one past the ceiling
    await err(host, { t: 'room.addBot' }, ERR.ROOM_FULL);
    await err(host, { t: 'room.removeBot', seat: MAX_SEATS }, ERR.BAD_MSG);
    // the top seat can be freed through the wire: seat 19 must round-trip
    await ok(host, { t: 'room.removeBot', seat: 19 });
    const freed = await host.waitFor('room.state', (s) => s.seats.filter(Boolean).length === MAX_SEATS - 1);
    assert.equal(freed.seats[19], null, 'the top seat came free');
    assert.equal(freed.seats.length, 20);
  });

  test('the host resizes before the match; members above a smaller ceiling compact downwards and keep ready', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host, 20);
    // four guests take seats 1..4
    const guests = [];
    for (let i = 0; i < 4; i++) {
      const g = await pool.player(`G${i}`);
      await ok(g, { t: 'room.join', code: st.code });
      const view = await host.waitFor('room.state', (s) => !!seatOf(s, g.id));
      assert.equal(seatOf(view, g.id).seat, i + 1, `guest ${i} takes the lowest free seat`);
      guests.push(g);
    }
    for (const g of guests) await ok(g, { t: 'room.ready', ready: true });
    const ready = await host.waitFor('room.state', (s) => s.seats.slice(1, 5).every((x) => x && x.ready));
    assert.ok(ready);
    // shrink to 10: everyone still fits, seats and ready flags survive
    await ok(host, { t: 'room.setCapacity', capacity: 10 });
    const ten = await host.waitFor('room.state', (s) => s.capacity === 10);
    assert.equal(ten.seats.length, 10);
    assert.equal(ten.seats.filter(Boolean).length, 5);
    for (let i = 0; i < 4; i++) {
      const s = seatOf(ten, guests[i].id);
      assert.equal(s.seat, i + 1, 'seat order is preserved');
      assert.equal(s.ready, true, 'a resize never unready a member');
    }
    // grow again: the new seats are empty and the members did not move
    await ok(host, { t: 'room.setCapacity', capacity: 16 });
    const sixteen = await host.waitFor('room.state', (s) => s.capacity === 16);
    assert.equal(sixteen.seats.length, 16);
    assert.deepEqual(sixteen.seats.slice(5), new Array(11).fill(null));
    // refuse a capacity that cannot hold the current members
    const solo = await pool.player('Solo');
    await ok(solo, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
    await err(solo, { t: 'room.setCapacity', capacity: 16 }, ERR.BAD_TARGET);
  });

  test('resize refusals: not the host, during a match; a capacity below the member count is refused', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host, 8);
    const guest = await pool.player('Guest');
    await ok(guest, { t: 'room.join', code: st.code });
    await host.waitFor('room.state', (s) => !!seatOf(s, guest.id));
    await err(guest, { t: 'room.setCapacity', capacity: 20 }, ERR.NOT_HOST);
    await err(host, { t: 'room.setCapacity', capacity: 5 }, ERR.BAD_MSG);
    // five occupied seats cannot fit into four
    for (let i = 0; i < 3; i++) await ok(host, { t: 'room.addBot' });
    await host.waitFor('room.state', (s) => s.seats.filter(Boolean).length === 5);
    await err(host, { t: 'room.setCapacity', capacity: 4 }, ERR.ROOM_FULL);
    // exactly fitting is fine
    await ok(host, { t: 'room.setCapacity', capacity: 8 });
    // during a match the capacity is frozen
    await ok(guest, { t: 'room.ready', ready: true });
    await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.ready);
    await ok(host, { t: 'room.start' });
    await host.waitFor('room.state', (s) => s.inMatch === true);
    await err(host, { t: 'room.setCapacity', capacity: 20 }, ERR.ROOM_STARTED);
  });
});
