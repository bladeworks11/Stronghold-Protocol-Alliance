// 账号同步 (account sync): one nickname is one account, no password — the server keeps the preferences the browser holds
// in `sp.pref.*` (server/profiles.js, shared/profiles.js, public/js/profile.js). What is checked here: the store and its
// files (hashed names, one account per nickname), the stats merge by record id, the HTTP API over a real socket
// (GET / PUT / DELETE, the refusals, the per-address rate), the switch that turns the routes off, and the browser side's
// preference collection, hashing, download and upload against a fake localStorage + fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createProfiles, mergeStatEnvelopes, PROFILE_LIMITS } from '../server/profiles.js';
import { buildSettlementRecord, createSettlementSink } from '../server/statsRecord.js';
import { startServer } from '../server/index.js';
import { MAX_RECORDS, buildRecord, normalizeRecord, recordId } from '../public/js/ui/stats.js';

/** A temporary folder (removed by the caller). */
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-${tag}-`));

/** One HTTP request against a running server. @returns {Promise<{ status: number, headers: any, body: string }>} */
function request(port, method, p, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: p, method, agent: false,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

/** A tiny server whose only route is the account API (the rate limits are the store's own). */
async function accountServer(dir, limits) {
  const profiles = createProfiles({ dir, limits });
  const server = http.createServer((req, res) => {
    const rawPath = (req.url || '/').split('?')[0];
    profiles.handle(req, res, rawPath, '').catch((e) => { res.writeHead(500); res.end(String(e)); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { profiles, server, port: server.address().port, close: () => new Promise((r) => server.close(() => r())) };
}

const accountPath = (name) => `/api/profile/${encodeURIComponent(name)}`;

test('one nickname is one account: written whole, read back, and the file is the name\'s hash', async () => {
  const dir = tmpDir('profiles');
  try {
    const profiles = createProfiles({ dir });
    assert.equal(await profiles.read('阿米娅'), null, 'no account yet');
    const saved = await profiles.write('阿米娅', { settings: { bgm: 0.4, muted: false }, lang: 'en' });
    assert.ok(saved.updatedAt > 0);
    const read = await profiles.read('阿米娅');
    assert.deepEqual(read.keys, { settings: { bgm: 0.4, muted: false }, lang: 'en' });
    assert.equal(read.name, '阿米娅');
    // one file, named by the hash of the nickname: nothing a client sends reaches a path
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{32}\.json$/);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.equal(stored.name, '阿米娅', 'the name is inside the file');
    assert.equal(stored.keys.settings.value.bgm, 0.4);
    assert.equal(await profiles.count(), 1);
    // a nickname that would be a path stays inside the folder (the API refuses it before this; the store cannot be tricked)
    await profiles.write('../../etc/passwd', { lang: 'ja' });
    assert.equal(fs.readdirSync(dir).length, 2);
    assert.ok(fs.readdirSync(dir).every((n) => /^[0-9a-f]{32}\.json$/.test(n)));
    // remove
    assert.equal(await profiles.remove('阿米娅'), true);
    assert.equal(await profiles.remove('阿米娅'), false, 'a second removal finds nothing');
    assert.equal(await profiles.read('阿米娅'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stats merge by record id: two devices add to one history, and the cap drops the oldest', () => {
  const envelope = (...ids) => ({ v: 2, records: ids.map((id) => ({ id })) });
  const merged = mergeStatEnvelopes(envelope('a', 'b'), envelope('b', 'c'));
  assert.deepEqual(merged.records.map((r) => r.id), ['b', 'c', 'a'], 'this request first, then what only the server had');
  assert.equal(merged.v, 2);
  // the two sides never produce a duplicate
  assert.equal(mergeStatEnvelopes(envelope('x'), envelope('x')).records.length, 1);
  // records without an id cannot be told apart: kept as they come
  assert.equal(mergeStatEnvelopes({ records: [{ n: 1 }] }, { records: [{ n: 2 }] }).records.length, 2);
  // the record cap is the browser's own (public/js/ui/stats.js MAX_RECORDS)
  assert.equal(PROFILE_LIMITS.records, MAX_RECORDS);
  const many = (tag) => ({ records: Array.from({ length: MAX_RECORDS }, (_, i) => ({ id: `${tag}${i}` })) });
  const capped = mergeStatEnvelopes(many('old'), many('new'));
  assert.equal(capped.records.length, MAX_RECORDS);
  assert.equal(capped.records[0].id, 'new0');
});

test('HTTP: GET / PUT / DELETE an account; a bad name, key, body or method is refused', async () => {
  const dir = tmpDir('profiles-http');
  const srv = await accountServer(dir);
  try {
    assert.equal((await request(srv.port, 'GET', accountPath('阿米娅'))).status, 404);
    const put = await request(srv.port, 'PUT', accountPath('阿米娅'), { keys: { settings: { bgm: 0.3 }, stats: { v: 2, records: [{ id: 'r1' }] } } });
    assert.equal(put.status, 200);
    const saved = JSON.parse(put.body);
    assert.equal(saved.name, '阿米娅');
    assert.ok(saved.updatedAt > 0);
    assert.deepEqual(saved.stats.records.map((r) => r.id), ['r1'], 'the merge comes back to the client');
    const got = JSON.parse((await request(srv.port, 'GET', accountPath('阿米娅'))).body);
    assert.deepEqual(got.keys.settings, { bgm: 0.3 });

    // whitespace and invisible characters are normalised (net.js sanitizeName), so both spellings are one account
    const padded = await request(srv.port, 'GET', accountPath('  阿米娅 '));
    assert.equal(padded.status, 200);
    assert.equal(JSON.parse(padded.body).name, '阿米娅');

    assert.equal((await request(srv.port, 'GET', '/api/profile/')).status, 400);
    assert.equal(JSON.parse((await request(srv.port, 'GET', '/api/profile/%20')).body).error, 'PROFILE_NAME');
    assert.equal((await request(srv.port, 'GET', '/api/profile/a%2Fb')).status, 400, 'a slash cannot name an account');
    assert.equal(JSON.parse((await request(srv.port, 'PUT', accountPath('阿米娅'), { keys: { 'bad key!': 1 } })).body).error, 'PROFILE_KEY');
    assert.equal(JSON.parse((await request(srv.port, 'PUT', accountPath('阿米娅'), { keys: {} })).body).error, 'PROFILE_BODY');
    const notJson = await request(srv.port, 'PUT', accountPath('阿米娅'), 'not json');
    assert.equal(JSON.parse(notJson.body).error, 'PROFILE_BODY');
    const tooBig = await request(srv.port, 'PUT', accountPath('阿米娅'), { keys: { settings: 'x'.repeat(PROFILE_LIMITS.keyBytes + 4096) } });
    assert.equal(tooBig.status, 413, 'one preference value over the per-key limit');
    assert.equal(JSON.parse(tooBig.body).error, 'PROFILE_SIZE');
    const wrongMethod = await request(srv.port, 'POST', accountPath('阿米娅'), { keys: { a: 1 } });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'GET, HEAD, PUT, DELETE');
    assert.deepEqual(JSON.parse((await request(srv.port, 'DELETE', accountPath('阿米娅'))).body), { ok: true, name: '阿米娅' });
    assert.equal((await request(srv.port, 'DELETE', accountPath('阿米娅'))).status, 404);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP: an unchanged account answers 304 with no body (a page load with nothing to sync)', async () => {
  const dir = tmpDir('profiles-etag');
  const srv = await accountServer(dir);
  try {
    await request(srv.port, 'PUT', accountPath('阿米娅'), { keys: { settings: { bgm: 0.3 } } });
    const first = await request(srv.port, 'GET', accountPath('阿米娅'));
    assert.equal(first.status, 200);
    const etag = first.headers.etag;
    assert.ok(etag, 'the answer carries an ETag');
    assert.equal(JSON.parse(first.body).etag, etag, 'and so does the body (the client keeps it)');
    const conditional = await request(srv.port, 'GET', accountPath('阿米娅'), null, { 'if-none-match': etag });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.body, '', 'no body: nothing changed');
    assert.equal(conditional.headers.etag, etag);
    // a write changes the validator; an outdated one gets the account again
    await request(srv.port, 'PUT', accountPath('阿米娅'), { keys: { settings: { bgm: 0.4 } } });
    const stale = await request(srv.port, 'GET', accountPath('阿米娅'), null, { 'if-none-match': etag });
    assert.equal(stale.status, 200);
    assert.notEqual(stale.headers.etag, etag);
    assert.deepEqual(JSON.parse(stale.body).keys.settings, { bgm: 0.4 });
    // a weak validator of the same value matches too (proxies may rewrite it)
    const weak = await request(srv.port, 'GET', accountPath('阿米娅'), null, { 'if-none-match': `W/${stale.headers.etag}` });
    assert.equal(weak.status, 304);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP: append adds only the records the account lacks (a match uploads a few KB, not the history)', async () => {
  const dir = tmpDir('profiles-append');
  const srv = await accountServer(dir);
  const ids = (res) => JSON.parse(res.body).stats.records.map((r) => r.id);
  try {
    const first = await request(srv.port, 'PUT', accountPath('阿米娅'), { keys: { stats: { v: 2, records: [{ id: 'a' }, { id: 'b' }] } } });
    assert.deepEqual(ids(first), ['a', 'b']);
    // the client sends only the new match; the one it repeats is dropped by id
    const appended = await request(srv.port, 'PUT', accountPath('阿米娅'), { append: { stats: { v: 2, records: [{ id: 'c' }, { id: 'a' }] } } });
    assert.equal(appended.status, 200);
    assert.deepEqual(ids(appended), ['c', 'a', 'b'], 'incoming first, then what only the account had');
    const got = JSON.parse((await request(srv.port, 'GET', accountPath('阿米娅'))).body);
    assert.deepEqual(got.keys.stats.records.map((r) => r.id), ['c', 'a', 'b']);
    // an empty append is a no-op request: refused, since it carries nothing
    const empty = await request(srv.port, 'PUT', accountPath('阿米娅'), { append: { stats: { v: 2, records: [] } } });
    assert.equal(empty.status, 400);
    // stats in both places is ambiguous
    const both = await request(srv.port, 'PUT', accountPath('阿米娅'), { keys: { stats: { v: 2, records: [] } }, append: { stats: { v: 2, records: [{ id: 'd' }] } } });
    assert.equal(JSON.parse(both.body).error, 'PROFILE_BODY');
    // only `stats` may be appended
    const unknown = await request(srv.port, 'PUT', accountPath('阿米娅'), { append: { settings: { bgm: 1 } } });
    assert.equal(JSON.parse(unknown.body).error, 'PROFILE_KEY');
    // a key and an append in one request
    const mixed = await request(srv.port, 'PUT', accountPath('阿米娅'), { keys: { lang: 'en' }, append: { stats: { v: 2, records: [{ id: 'e' }] } } });
    assert.equal(mixed.status, 200);
    assert.deepEqual(ids(mixed)[0], 'e');
    const after = JSON.parse((await request(srv.port, 'GET', accountPath('阿米娅'))).body);
    assert.equal(after.keys.lang, 'en');
    assert.equal(after.keys.stats.records.length, 4);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP: the folder holds 2000 accounts, and the per-address write rate is bounded', async () => {
  const dir = tmpDir('profiles-rate');
  try {
    const srv = await accountServer(dir, { writesPerMin: 3, profiles: 1 });
    try {
      assert.equal((await request(srv.port, 'PUT', accountPath('甲'), { keys: { lang: 'en' } })).status, 200);
      // a second account beyond the folder limit is refused; the account that exists keeps working
      const full = await request(srv.port, 'PUT', accountPath('乙'), { keys: { lang: 'en' } });
      assert.equal(full.status, 503);
      assert.equal(JSON.parse(full.body).error, 'PROFILE_FULL');
      assert.equal((await request(srv.port, 'PUT', accountPath('甲'), { keys: { lang: 'ja' } })).status, 200);
      const fourth = await request(srv.port, 'PUT', accountPath('甲'), { keys: { lang: 'ko' } });
      assert.equal(fourth.status, 429);
      assert.equal(JSON.parse(fourth.body).error, 'PROFILE_RATE');
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the server serves the account API, and SP_PROFILES=off leaves it out', async () => {
  const dir = tmpDir('profiles-boot');
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, studio: false, profiles: { dir } });
  try {
    assert.ok(srv.profiles, 'the module is wired');
    assert.equal(typeof srv.lobby.statsSink, 'function', 'the lobby writes settlements into accounts');
    const url = (p) => `http://127.0.0.1:${srv.port}${p}`;
    assert.equal((await fetch(url(accountPath('博士')))).status, 404);
    const put = await fetch(url(accountPath('博士')), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: { settings: { bgm: 0.1 } } }) });
    assert.equal(put.status, 200);
    const got = await (await fetch(url(accountPath('博士')))).json();
    assert.deepEqual(got.keys.settings, { bgm: 0.1 });
    // and the lobby's settlement hook writes a finished match straight into the account (server/statsRecord.js)
    const frame = settlement();
    const room = { mode: 'coop', content: null };
    await fetch(url(accountPath('阿米娅')), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: { settings: { bgm: 0.1 } } }) });
    srv.lobby.statsSink(room, 'p0', { ...frame, playerId: 'p0' });
    let records = [];
    for (let i = 0; i < 200 && !records.length; i++) {
      await new Promise((r) => setTimeout(r, 5));
      records = (await (await fetch(url(accountPath('阿米娅')))).json()).keys.stats?.records ?? [];
    }
    assert.equal(records.length, 1, 'the settlement landed in the account');
    assert.equal(records[0].selfId, 'p0');
    assert.equal(records[0].id, recordId(frame, 'p0'));
    // every other POST keeps the plain 405 of the static server
    assert.equal((await fetch(url('/healthz'), { method: 'POST' })).status, 405);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const off = await startServer({ port: 0, host: '127.0.0.1', quiet: true, studio: false, profiles: false });
  try {
    assert.equal(off.profiles, null);
    assert.equal(off.lobby.statsSink, null, 'and no settlement is recorded anywhere');
    const res = await fetch(`http://127.0.0.1:${off.port}/api/profile/${encodeURIComponent('博士')}`);
    assert.equal(res.status, 404, 'the path falls through to the static 404');
    assert.ok(!String(res.headers.get('content-type') || '').includes('application/json'));
  } finally {
    await off.close();
  }
});

// ---- the browser side (public/js/profile.js) -------------------------------------------------------

/** A localStorage stand-in (the module reads globalThis.localStorage). */
function fakeStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    clear: () => map.clear(),
    dump: () => Object.fromEntries(map),
  };
}

/** Load the client module with a fake localStorage and a fake fetch (installed before the first import). */
async function loadClient(storage, fetchImpl) {
  globalThis.localStorage = storage;
  globalThis.fetch = fetchImpl;
  return import('../public/js/profile.js');
}

test('the browser: every preference travels except the sync\'s own bookkeeping', async () => {
  const storage = fakeStorage({
    'sp.pref.settings': JSON.stringify({ bgm: 0.5 }),
    'sp.pref.stats': JSON.stringify({ v: 2, records: [{ id: 'r1' }] }),
    'sp.pref.sync': JSON.stringify({ name: 'x', enabled: true }),
    'sp.pref.stats.damaged': '{oops',
    'sp.name': '阿米娅',           // the nickname is not a preference
    'sp.tokens': '["t1"]',          // session tokens never leave the browser
    'other-key': '1',
  });
  const mod = await loadClient(storage, async () => ({ status: 404, json: async () => ({ error: 'PROFILE_NOT_FOUND' }) }));
  const prefs = mod.collectPrefs();
  assert.deepEqual(Object.keys(prefs).sort(), ['settings', 'stats']);
  assert.equal(mod.SYNC_KEY, 'sync');
  // the fingerprint is stable and notices a change
  assert.equal(mod.prefsHash(prefs), mod.prefsHash({ ...prefs }));
  assert.notEqual(mod.prefsHash(prefs), mod.prefsHash({ ...prefs, settings: { bgm: 0.6 } }));
  // nothing of the bookkeeping is uploaded even when it is somewhere in the set
  assert.deepEqual(mod.applyPrefs({ settings: { bgm: 0.2 }, sync: { evil: true } }), ['settings']);
  assert.deepEqual(JSON.parse(storage.getItem('sp.pref.settings')), { bgm: 0.2 });
  assert.equal(storage.getItem('sp.pref.sync'), JSON.stringify({ name: 'x', enabled: true }), 'untouched');
});

test('the browser: 下载账号设置 applies the account, merges the history and reloads once', async () => {
  const row = (id) => ({ id, v: 2, t: 1, players: [{ playerId: 'p1', seat: 0 }] });
  const storage = fakeStorage({
    'sp.name': '阿米娅',
    // a local match the account does not have yet
    'sp.pref.stats': JSON.stringify({ v: 2, records: [row('mine')] }),
    'sp.pref.settings': JSON.stringify({ bgm: 0.9 }),
  });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
    if (!init.method || init.method === 'GET') {
      return {
        status: 200,
        json: async () => ({
          name: '阿米娅',
          updatedAt: 42,
          keys: { settings: { bgm: 0.1, muted: true }, stats: { v: 2, records: [row('theirs')] } },
        }),
      };
    }
    return { status: 200, json: async () => ({ name: '阿米娅', updatedAt: 43, keys: {}, stats: { v: 2, records: [row('theirs'), row('mine')] } }) };
  };
  const mod = await loadClient(storage, fetchImpl);
  let reloads = 0;
  mod.installProfileSync({ notify: () => {}, reload: () => { reloads += 1; } });
  mod.saveSync({ name: '阿米娅', enabled: true, at: 0, hash: '' });
  const res = await mod.downloadNow();
  assert.equal(res.ok, true);
  assert.equal(reloads, 1, 'the page reloads once so the settings modules read the new values');
  assert.deepEqual(JSON.parse(storage.getItem('sp.pref.settings')), { bgm: 0.1, muted: true });
  const merged = JSON.parse(storage.getItem('sp.pref.stats'));
  assert.deepEqual(merged.records.map((r) => r.id).sort(), ['mine', 'theirs'], 'both histories survive');
  const sync = JSON.parse(storage.getItem('sp.pref.sync'));
  assert.equal(sync.at, 43);
  assert.ok(sync.hash, 'the agreed state is remembered');
  assert.ok(calls.some((c) => c.method === 'PUT' && c.body.append?.stats), 'only the records the account lacks go up');
});

test('the browser: 上传本机设置 sends the preferences and remembers the account', async () => {
  const storage = fakeStorage({ 'sp.name': '阿米娅', 'sp.pref.settings': JSON.stringify({ bgm: 0.7 }), 'sp.pref.sync': JSON.stringify({ name: '阿米娅', enabled: false }) });
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'PUT') {
      sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return { status: 200, json: async () => ({ name: '阿米娅', updatedAt: 7, keys: {}, stats: null }) };
    }
    return { status: 404, json: async () => ({ error: 'PROFILE_NOT_FOUND' }) };
  };
  const mod = await loadClient(storage, fetchImpl);
  mod.installProfileSync({ notify: () => {}, reload: () => {} });
  mod.saveSync({ name: '阿米娅', enabled: true, at: 0, hash: '' });
  const res = await mod.uploadNow();
  assert.equal(res.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(decodeURIComponent(sent[0].url.split('/').pop()), '阿米娅');
  assert.deepEqual(sent[0].body.keys.settings, { bgm: 0.7 });
  assert.equal(sent[0].body.keys.sync, undefined, 'the bookkeeping stays on this device');
  const sync = JSON.parse(storage.getItem('sp.pref.sync'));
  assert.equal(sync.at, 7);
  assert.ok(sync.hash);
  assert.equal(mod.syncState.get().status, 'ok');
});

// ---- the page-load reconcile (installProfileSync → bootSync) --------------------------------------

/** Wait until `pred()` or the timeout (the reconcile runs in the background, unawaited). */
async function waitFor(pred, ms = 1500) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
}

test('a page load with an unchanged account spends one 304 and nothing else', async () => {
  const storage = fakeStorage({ 'sp.name': '阿米娅', 'sp.pref.settings': JSON.stringify({ bgm: 0.5 }) });
  const seen = [];
  const mod = await loadClient(storage, async (url, init = {}) => {
    seen.push({ method: init.method || 'GET', etag: (init.headers && init.headers['if-none-match']) || '' });
    return { status: 304, json: async () => null };
  });
  mod.saveSync({ name: '阿米娅', enabled: true, at: 77, hash: mod.prefsHash(mod.collectPrefs()), etag: '"abc"' });
  let reloads = 0;
  mod.installProfileSync({ notify: () => {}, reload: () => { reloads += 1; } });
  await waitFor(() => seen.length > 0);
  await new Promise((r) => setTimeout(r, 25)); // let the reconcile finish
  assert.equal(seen.length, 1, 'one conditional GET, no upload');
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].etag, '"abc"', 'the request carries the remembered ETag');
  assert.equal(reloads, 0, 'nothing to apply: no reload');
  assert.equal(JSON.parse(storage.getItem('sp.pref.settings')).bgm, 0.5);
});

test('a page load takes another device\'s change over when this browser has nothing new', async () => {
  // this browser synced already: its state is the account's (hash = what is stored), the account moved on elsewhere
  const storage = fakeStorage({ 'sp.name': '阿米娅', 'sp.pref.settings': JSON.stringify({ bgm: 0.5 }) });
  const mod = await loadClient(storage, async () => ({
    status: 200,
    json: async () => ({ name: '阿米娅', updatedAt: 99, keys: { settings: { bgm: 0.05, muted: true } } }),
  }));
  mod.saveSync({ name: '阿米娅', enabled: true, at: 10, hash: mod.prefsHash(mod.collectPrefs()) });
  let reloads = 0;
  mod.installProfileSync({ notify: () => {}, reload: () => { reloads += 1; } });
  await waitFor(() => reloads > 0);
  assert.equal(reloads, 1, 'the downloaded settings apply through a reload');
  assert.deepEqual(JSON.parse(storage.getItem('sp.pref.settings')), { bgm: 0.05, muted: true });
  assert.equal(JSON.parse(storage.getItem('sp.pref.sync')).at, 99);
});

test('a page load keeps this browser\'s own edits: they go up instead of being overwritten', async () => {
  const storage = fakeStorage({ 'sp.name': '阿米娅', 'sp.pref.settings': JSON.stringify({ bgm: 0.5 }) });
  const puts = [];
  const mod = await loadClient(storage, async (url, init = {}) => {
    if (init.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return { status: 200, json: async () => ({ name: '阿米娅', updatedAt: 30, keys: {}, stats: null }) }; }
    return { status: 200, json: async () => ({ name: '阿米娅', updatedAt: 20, keys: { settings: { bgm: 0.05 } } }) };
  });
  // the hash remembers a state this browser no longer holds: it has edits the account does not
  mod.saveSync({ name: '阿米娅', enabled: true, at: 10, hash: 'stale' });
  let reloads = 0;
  mod.installProfileSync({ notify: () => {}, reload: () => { reloads += 1; } });
  await waitFor(() => puts.length > 0);
  assert.equal(reloads, 0, 'nothing is downloaded over a local edit');
  assert.deepEqual(puts[0].keys.settings, { bgm: 0.5 });
  assert.deepEqual(JSON.parse(storage.getItem('sp.pref.settings')), { bgm: 0.5 });
  await waitFor(() => JSON.parse(storage.getItem('sp.pref.sync')).at === 30);
  assert.equal(JSON.parse(storage.getItem('sp.pref.sync')).at, 30);
});

test('a finished match uploads nothing (the server writes it); a match left early does', async () => {
  const row = (id, end = 'settled') => ({ id, v: 2, t: 1, end, players: [{ playerId: 'p1', seat: 0 }] });
  const envelope = (...records) => ({ v: 2, records });
  const storage = fakeStorage({ 'sp.name': '阿米娅', 'sp.pref.stats': JSON.stringify(envelope(row('m1'), row('m2'))) });
  const puts = [];
  // a small stand-in for the account: it keeps what it is sent and answers with everything it holds
  const held = new Map([['m1', row('m1')], ['m2', row('m2')]]);
  const mod = await loadClient(storage, async (url, init = {}) => {
    if (init.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      for (const r of body.append ? body.append.stats.records : []) held.set(r.id, r);
      return { status: 200, json: async () => ({ name: '阿米娅', updatedAt: 50 + puts.length, keys: {}, etag: `"e${puts.length}"`, stats: envelope(...held.values()) }) };
    }
    return { status: 200, json: async () => ({ name: '阿米娅', updatedAt: 40, keys: { stats: envelope(...held.values()) }, etag: '"e0"' }) };
  });
  // this browser synced already: the account is known to hold m1 and m2
  mod.saveSync({ name: '阿米娅', enabled: true, at: 40, hash: mod.prefsHash(mod.collectPrefs()), etag: '"e0"', sent: ['m1', 'm2'] });
  mod.installProfileSync({ notify: () => {}, reload: () => {} });
  // a settled match arrives (the server wrote its own copy at settlement): nothing to upload
  storage.setItem('sp.pref.stats', JSON.stringify(envelope(row('m3'), row('m1'), row('m2'))));
  const before = puts.length;
  await mod.uploadNow(); // force: the explicit button still sends everything (here: m3)
  assert.equal(puts.length, before + 1);
  assert.deepEqual(puts[0].append.stats.records.map((r) => r.id), ['m3'], 'the explicit upload sends what the account lacks');
  // a match left early: the server has no settlement for it, so the browser uploads that record
  storage.setItem('sp.pref.stats', JSON.stringify(envelope(row('q1', 'quit'), row('m3'), row('m1'), row('m2'))));
  await mod.uploadNow();
  const last = puts[puts.length - 1];
  assert.deepEqual(last.append.stats.records.map((r) => r.id), ['q1']);
  assert.equal(last.keys, undefined, 'no whole envelope');
  assert.deepEqual(JSON.parse(storage.getItem('sp.pref.sync')).sent.sort(), ['m1', 'm2', 'm3', 'q1']);
});

test('the automatic upload (not the button) skips settled matches', async () => {
  const row = (id, end = 'settled') => ({ id, v: 2, t: 1, end, players: [{ playerId: 'p1', seat: 0 }] });
  const envelope = (...records) => ({ v: 2, records });
  const storage = fakeStorage({ 'sp.name': '阿米娅', 'sp.pref.stats': JSON.stringify(envelope(row('m1'))) });
  const puts = [];
  const mod = await loadClient(storage, async (url, init = {}) => {
    if (init.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      return { status: 200, json: async () => ({ name: '阿米娅', updatedAt: 60, keys: {}, etag: '"e2"', stats: body.append?.stats ?? null }) };
    }
    return { status: 200, json: async () => ({ name: '阿米娅', updatedAt: 40, keys: { stats: envelope(row('m1')) }, etag: '"e1"' }) };
  });
  mod.saveSync({ name: '阿米娅', enabled: true, at: 40, hash: mod.prefsHash(mod.collectPrefs()), etag: '"e1"', sent: ['m1'] });
  mod.installProfileSync({ notify: () => {}, reload: () => {} });
  // a settled match and a settings change: the settings go up, the match does not
  storage.setItem('sp.pref.stats', JSON.stringify(envelope(row('m2'), row('m1'))));
  storage.setItem('sp.pref.settings', JSON.stringify({ bgm: 0.2 }));
  const before = puts.length;
  mod.saveSync({ name: '阿米娅', enabled: true, at: 40, hash: mod.prefsHash(mod.collectPrefs()), etag: '"e1"', sent: ['m1'] });
  await waitFor(() => puts.length > before);
  const put = puts[puts.length - 1];
  assert.deepEqual(put.keys.settings, { bgm: 0.2 }, 'the setting went up');
  assert.equal(put.append, undefined, 'the settled match did not');
});

// ---- the server's own record at settlement (server/statsRecord.js) ---------------------------------

/** A settlement payload the way server/match/results.js buildResult makes one. */
function settlement(over = {}) {
  const row = (seat, name, extra = {}) => ({
    playerId: `p${seat}`, seat, name, isBot: false, left: false, alive: true, victory: seat === 1, roundsPassed: 14,
    eliminatedRound: null, lp: 12, bandId: 'band_rhodes', title: { id: 'title_victor' }, trophies: 2, reward: 1,
    lineup: [{ id: 'chess_char_1_01', golden: true, tier: 3, items: ['item_1'] }],
    bonds: [{ bondId: 'bond_rhodes', layers: 3, active: true }],
    stats: { dmgDealt: 12345, kills: 40 },
    ...extra,
  });
  return {
    t: 'm.result', victory: true, roundsPassed: 14, lastRound: 14, hiddenReached: true, hiddenCleared: false,
    reason: 'victory', modeId: 'mode_multi_hard', difficulty: 'HARD', seed: 4242, durationMs: 1_200_000, teamLp: 12,
    players: [row(0, '阿米娅'), row(1, '凯尔希'), row(2, '没开同步的博士'), row(3, 'AI 队友', { isBot: true })],
    ...over,
  };
}

test('the server record and the browser record of one match are the same record (id and shape)', () => {
  const res = settlement();
  const ctx = { myId: 'p0', roomMode: 'coop', vs: 'cd'.repeat(32), content: { cs: 'ab'.repeat(32), vanilla: false, plugins: [{ id: 'bond-def', version: '1.0.0' }] }, now: 5000 };
  const server = buildSettlementRecord(res, ctx);
  const client = buildRecord(res, ctx);
  assert.ok(server && client);
  assert.equal(server.id, client.id, 'the same match, the same record id — the merge collapses the two copies');
  assert.equal(server.id, recordId(res, 'p0'));
  // what the stats page reads is what the browser would have written itself (normalizeRecord is the record schema)
  assert.deepEqual(normalizeRecord(server), client);
  // a spectator's frame has no row of its own: no record
  assert.equal(buildSettlementRecord(res, { myId: 'spectator' }), null);
  assert.equal(buildSettlementRecord({ t: 'm.result', players: [] }, { myId: 'p0' }), null);
});

test('a settlement writes one record per account; players without one, bots and stub settlements write nothing', async () => {
  const dir = tmpDir('profiles-settle');
  try {
    const profiles = createProfiles({ dir });
    await profiles.write('阿米娅', { settings: { bgm: 0.5 } });
    await profiles.write('凯尔希', { settings: { bgm: 0.4 } });
    const sink = createSettlementSink({ profiles, now: () => 5000 });
    const res = settlement();
    const room = { mode: 'coop', content: { cs: 'ab'.repeat(32), vanilla: false, plugins: [{ id: 'bond-def', version: '1.0.0' }] } };
    // the unicast frames, one per recipient (a bot never gets one; the server does not write for it anyway)
    for (const id of ['p0', 'p1', 'p2']) sink(room, id, { ...res, playerId: id });
    const wait = async () => {
      for (let i = 0; i < 200; i++) {
        const a = await profiles.read('阿米娅');
        const k = await profiles.read('凯尔希');
        if (a?.keys?.stats && k?.keys?.stats) return { a, k };
        await new Promise((r) => setTimeout(r, 5));
      }
      return { a: await profiles.read('阿米娅'), k: await profiles.read('凯尔希') };
    };
    const { a, k } = await wait();
    assert.equal(a.keys.stats.records.length, 1);
    assert.equal(a.keys.stats.records[0].selfId, 'p0');
    assert.equal(a.keys.stats.records[0].id, recordId(res, 'p0'));
    assert.equal(a.keys.stats.records[0].players.length, 4, 'the settlement rows are kept (the page normalizes them)');
    assert.ok(a.keys.stats.records[0].content, 'a match with gameplay plugins is recorded as such');
    assert.equal(k.keys.stats.records[0].selfId, 'p1');
    // the third player has no account: no file was made for the nickname
    assert.equal(fs.readdirSync(dir).length, 2);
    // an abandoned room's stub settlement is no played match
    sink(room, 'p0', { ...res, stub: true, playerId: 'p0' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await profiles.read('阿米娅')).keys.stats.records.length, 1);
    // a broadcast settlement (no playerId) records every human row once — the same ids, so nothing doubles
    sink(room, null, res);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await profiles.read('阿米娅')).keys.stats.records.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
