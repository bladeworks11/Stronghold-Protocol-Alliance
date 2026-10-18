// server/profiles.js — accounts without passwords (账号同步): one nickname is one account, and the account holds the
// preferences the browser keeps in `sp.pref.*` — 画面 / 声音 / 语言 / 编队 / 自选 / 表情 / 大厅默认值 …
// (shared/profiles.js is the contract with the client; public/js/profile.js is the browser side.)
//
//   GET    /api/profile/<name>   → { name, updatedAt, keys: { <key>: <value> }, etag } | 404
//                                  (If-None-Match matching the stored ETag → 304 with no body)
//   PUT    /api/profile/<name>   { keys?: { <key>: <value> }, append?: { stats: { v, records } } }
//                                → { name, updatedAt, keys: { <key>: <at> }, etag, stats? }
//   DELETE /api/profile/<name>   → { ok: true } | 404
//   (HEAD answers as GET; another method → 405 with Allow)
//
// Traffic (a metered host bills the bytes out of the server, so this API keeps them small):
//   * every answer carries an ETag — a hash of the stored bytes — and a conditional GET that matches it is a 304 with no
//     body, so a page load with nothing to sync costs a few hundred bytes instead of the whole profile (the stats
//     envelope alone may reach ~800 KB, public/js/ui/stats.js MAX_CHARS);
//   * `append` uploads the records the account does not have yet, not the whole envelope: a finished match is a few KB
//     instead of hundreds. The server merges them by record id, exactly like a full envelope (mergeStatEnvelopes), and
//     answers with the union, so the client can adopt what another device added.
//
// Why no password: the owner asked for it (「只匹配用户名，不需要密码」). Anyone who knows a nickname can read and rewrite
// that account — the settings of a game with no accounts of its own, not an identity. The server therefore treats a
// profile as untrusted content: names are normalised with the protocol's own rule (net.js sanitizeName), keys must match
// PROFILE_KEY_RE, every value is bounded (PROFILE_LIMITS), the request rate is limited per client address, and the file
// name is the SHA-256 of the name — nothing a client sends ever reaches a path.
//
// Storage: `profiles/<sha256(name)[0..32]>.json`, one file per account, written whole through a temporary file and a
// rename (a reader never sees half a profile), serialised per name. A profile file is JSON:
//   { v: 1, name, updatedAt, keys: { <key>: { at, value } } }
// `stats` is the one key the server understands: its two envelopes are merged by record id (mergeStatEnvelopes), so a
// phone and a desktop add to one history instead of replacing it (public/js/ui/stats.js keeps the record shape).
//
// The folder is per-machine state: `.gitignore`d, never in the release packages (tools/package.mjs ships tracked files
// only), and it must be a volume in a container (docs/DEPLOY.md §3). SP_PROFILES=off turns the routes off entirely.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PROFILE_API, PROFILE_LIMITS, PROFILE_VERSION, isProfileKey } from '../shared/profiles.js';
import { sendJson } from './http/common.js';
import { clientAddress, sanitizeName } from './net.js';

export { PROFILE_API, PROFILE_LIMITS };

/** The JSON a profile file holds. @typedef {{ v: number, name: string, updatedAt: number, keys: Record<string, { at: number, value: any }> }} ProfileFile */

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Merge two stats envelopes by record id: the incoming records first (newest), the stored ones that it lacks after them,
 * capped at PROFILE_LIMITS.records. Records without a string id cannot be told apart and are kept as they come (bounded by
 * the caller's size limit). Version: the higher one, so an older client's upload never downgrades the envelope.
 * @param {any} stored the envelope already on the server
 * @param {any} incoming the envelope this request uploads
 * @returns {{ v: number, records: any[] }}
 */
export function mergeStatEnvelopes(stored, incoming) {
  const list = (v) => (isObj(v) && Array.isArray(v.records) ? v.records : []);
  const seen = new Set();
  const records = [];
  const push = (rec) => {
    if (!isObj(rec)) return;
    if (typeof rec.id === 'string' && rec.id) {
      if (seen.has(rec.id)) return;
      seen.add(rec.id);
    }
    if (records.length < PROFILE_LIMITS.records) records.push(rec);
  };
  // newest first: this request's records are the ones the browser just wrote
  for (const rec of list(incoming)) push(rec);
  for (const rec of list(stored)) push(rec);
  const v = Math.max(Number(stored?.v) || 0, Number(incoming?.v) || 0) || 1;
  return { v, records };
}

/** The file a nickname is stored in: its hash, never the name itself. @param {string} dir @param {string} name */
const fileOf = (dir, name) => path.join(dir, `${createHash('sha256').update(name).digest('hex').slice(0, 32)}.json`);

/**
 * The ETag of a stored profile: a hash of the exact bytes that are served, so any write changes it and a conditional
 * request can trust it.
 * @param {string} text
 * @returns {string} a quoted strong validator
 */
const etagOf = (text) => `"${createHash('sha256').update(text).digest('hex').slice(0, 32)}"`;

/**
 * The size of a value as JSON, in bytes (the bound a profile key may reach).
 * @param {any} value
 * @returns {number}
 */
function jsonBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value) ?? 'null'); } catch { return Infinity; }
}

/**
 * Read a request body of at most `limit` bytes.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>} rejects with `{ code: 'TOO_LARGE' }` beyond the limit
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > limit) { req.resume(); reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' })); return; }
    const chunks = [];
    let n = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      n += c.length;
      if (n > limit) { over = true; chunks.length = 0; reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' })); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/**
 * The accounts of one server (see the header).
 * @param {{ dir: string, log?: object, trustProxy?: 'auto' | boolean, now?: () => number, limits?: Partial<typeof PROFILE_LIMITS> }} opts
 *   dir: the profiles folder; trustProxy: whose forwarding headers name a client (net.js clientAddress)
 * @returns {{ handles: (rawPath: string) => boolean,
 *             handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *                      rawPath: string, query: string) => Promise<void>,
 *             read: (name: string) => Promise<{ name: string, updatedAt: number, keys: Record<string, any> } | null>,
 *             write: (name: string, values: Record<string, any>) => Promise<{ name: string, updatedAt: number, stats: any }>,
 *             remove: (name: string) => Promise<boolean>, count: () => number, dir: string }}
 */
export function createProfiles({ dir, log = null, trustProxy = 'auto', now = () => Date.now(), limits: limitOpts = {} }) {
  const limits = { ...PROFILE_LIMITS, ...limitOpts };
  let counted = null;          // how many profile files the folder holds (cache; invalidated on write / remove)
  let dirReady = false;
  /** Writes of one name run one after another (two devices of an account never interleave). @type {Map<string, Promise<any>>} */
  const chains = new Map();
  /** Requests per client address, per minute. @type {Map<string, { at: number, reads: number, writes: number }>} */
  const rate = new Map();
  let fsWarned = false;

  const prune = () => {
    if (rate.size < 512) return;
    const edge = now() - 60000;
    for (const [ip, r] of rate) if (r.at < edge) rate.delete(ip);
  };

  /** Count the folder's profile files (null when it cannot be read). */
  async function countFiles() {
    if (counted != null) return counted;
    try {
      const names = await fsp.readdir(dir);
      counted = names.filter((n) => n.endsWith('.json')).length;
    } catch (e) {
      if (e.code !== 'ENOENT') { counted = null; }
      else counted = 0;
    }
    return counted;
  }

  /** Create the folder on first use. @returns {Promise<boolean>} */
  async function ensureDir() {
    if (dirReady) return true;
    try {
      await fsp.mkdir(dir, { recursive: true });
      dirReady = true;
      return true;
    } catch (e) {
      if (!fsWarned) { fsWarned = true; log?.warn?.(`[profiles] cannot create ${dir}: ${e.code || e.message} — account sync unavailable`); }
      return false;
    }
  }

  /**
   * Read one account as the client gets it (values only).
   * @param {string} name
   * @returns {Promise<{ name: string, updatedAt: number, keys: Record<string, any> } | null>}
   */
  async function read(name) {
    const found = await readWithEtag(name);
    if (!found) return null;
    return { ...found.profile, name };
  }

  /** The file's text (null when there is none). @param {string} name @returns {Promise<string | null>} */
  async function readText(name) {
    try { return await fsp.readFile(fileOf(dir, name), 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  /**
   * Read one account with the ETag of the file it came from: a page load that sends it back gets a body-less 304, so a
   * sync that has nothing to do costs a few hundred bytes instead of the whole profile (traffic is what a metered host
   * bills for; the stats envelope alone can reach ~800 KB).
   * @param {string} name
   * @returns {Promise<{ profile: { name: string, updatedAt: number, keys: Record<string, any> }, etag: string } | null>}
   */
  async function readWithEtag(name) {
    const text = await readText(name);
    if (text == null) return null;
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!isObj(parsed) || !isObj(parsed.keys)) return null;
    const keys = {};
    for (const [k, entry] of Object.entries(parsed.keys)) if (isObj(entry) && 'value' in entry) keys[k] = entry.value;
    return { profile: { name, updatedAt: Number(parsed.updatedAt) || 0, keys }, etag: etagOf(text) };
  }

  /** Read the whole file (with the per-key timestamps). @param {string} name @returns {Promise<ProfileFile | null>} */
  async function readFile(name) {
    try {
      const parsed = JSON.parse(await fsp.readFile(fileOf(dir, name), 'utf8'));
      if (!isObj(parsed) || !isObj(parsed.keys)) return null;
      return { v: Number(parsed.v) || PROFILE_VERSION, name, updatedAt: Number(parsed.updatedAt) || 0, keys: parsed.keys };
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      log?.warn?.(`[profiles] ${name}: unreadable (${e.code || e.message}) — starting again`);
      return null;
    }
  }

  /** Write the file through a temporary one and a rename. @param {string} name @param {ProfileFile} profile @returns {Promise<string>} the text written */
  async function writeFile(name, profile) {
    const abs = fileOf(dir, name);
    const tmp = `${abs}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const text = JSON.stringify(profile);
    await fsp.writeFile(tmp, text, 'utf8');
    try { await fsp.rename(tmp, abs); } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
    return text;
  }

  /** Run one write of a name after the previous one. @template T @param {string} name @param {() => Promise<T>} fn */
  function serialised(name, fn) {
    const prev = chains.get(name) || Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(name, next.catch(() => {}));
    next.finally(() => { if (chains.get(name) === next) chains.delete(name); }).catch(() => {});
    return next;
  }

  /**
   * Store the values of one request: `stats` is merged with what is stored, every other key replaces its value.
   * `append` (`{ stats: { v, records } }`) adds records the account does not have yet — what a match costs a client to
   * upload: the new records only (~7 KB), not the whole envelope (~300 KB–800 KB).
   * @param {string} name
   * @param {Record<string, any>} values
   * @param {{ stats?: any } | null} [append]
   * @returns {Promise<{ name: string, updatedAt: number, stats: any, etag: string }>}
   */
  async function write(name, values, append = null) {
    return serialised(name, async () => {
      if (!await ensureDir()) throw Object.assign(new Error('profiles folder unavailable'), { code: 'PROFILE_DISK' });
      const stored = await readFile(name);
      if (!stored && (await countFiles()) >= limits.profiles) throw Object.assign(new Error('too many accounts'), { code: 'PROFILE_FULL' });
      const at = now();
      const keys = stored ? { ...stored.keys } : {};
      let stats = null;
      for (const [k, value] of Object.entries(values)) {
        if (k === 'stats' && isObj(value) && Array.isArray(value.records)) {
          const prev = isObj(keys[k]) ? keys[k].value : null;
          stats = mergeStatEnvelopes(prev, value);
          keys[k] = { at, value: stats };
        } else {
          keys[k] = { at, value };
        }
      }
      const appended = append && isObj(append.stats) && Array.isArray(append.stats.records) ? append.stats : null;
      if (appended && appended.records.length) {
        const prev = isObj(keys.stats) ? keys.stats.value : null;
        stats = mergeStatEnvelopes(prev, appended);
        keys.stats = { at, value: stats };
      }
      const profile = { v: PROFILE_VERSION, name, updatedAt: at, keys };
      const text = await writeFile(name, profile);
      if (!stored && counted != null) counted += 1;
      return { name, updatedAt: at, stats, etag: etagOf(text) };
    });
  }

  /**
   * Whether an account exists, without reading it (one stat: the settlement writes ask for a nickname's account).
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async function has(name) {
    try { await fsp.access(fileOf(dir, name)); return true; } catch { return false; }
  }

  /**
   * Remove one account.
   * @param {string} name
   * @returns {Promise<boolean>} whether it existed
   */
  async function remove(name) {
    return serialised(name, async () => {
      try { await fsp.rm(fileOf(dir, name), { force: false }); } catch (e) {
        if (e.code === 'ENOENT') return false;
        throw e;
      }
      if (counted != null && counted > 0) counted -= 1;
      return true;
    });
  }

  /** How many accounts the folder holds (null when unreadable). */
  const count = () => countFiles();

  /**
   * The per-address request rate: true while the caller stays inside its minute.
   * @param {string} ip @param {'read' | 'write'} kind
   */
  function withinRate(ip, kind) {
    const t = now();
    let r = rate.get(ip);
    if (!r || t - r.at >= 60000) { r = { at: t, reads: 0, writes: 0 }; rate.set(ip, r); prune(); }
    if (kind === 'write') {
      r.writes += 1;
      return r.writes <= limits.writesPerMin;
    }
    r.reads += 1;
    return r.reads <= limits.readsPerMin;
  }

  /** Is this path an account's? @param {string} rawPath */
  const handles = (rawPath) => rawPath === PROFILE_API || rawPath.startsWith(`${PROFILE_API}/`);

  /** An error answer in the API's own shape (the page reads `error`). */
  function fail(req, res, status, code, detail) {
    sendJson(req, res, status, detail ? { error: code, detail } : { error: code });
  }

  /**
   * Answer a request whose path is `/api/profile…` (routes.js).
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} rawPath
   * @param {string} _query unused: the account API takes everything in the path and the body
   */
  async function handle(req, res, rawPath, _query) {
    const ip = clientAddress(req, trustProxy).ip || 'unknown';
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (!isRead && req.method !== 'PUT' && req.method !== 'DELETE') {
      res.setHeader('Allow', 'GET, HEAD, PUT, DELETE');
      fail(req, res, 405, 'PROFILE_METHOD');
      return;
    }
    if (!withinRate(ip, isRead ? 'read' : 'write')) { fail(req, res, 429, 'PROFILE_RATE'); return; }
    // /api/profile/<name> names one account; the bare collection and a trailing slash name none
    const rest = rawPath.slice(PROFILE_API.length);
    if (!rest.startsWith('/') || rest === '/') { fail(req, res, 400, 'PROFILE_NAME'); return; }
    let raw;
    try { raw = decodeURIComponent(rest.slice(1)); } catch { fail(req, res, 400, 'PROFILE_NAME'); return; }
    if (raw.includes('/')) { fail(req, res, 400, 'PROFILE_NAME'); return; }
    const name = sanitizeName(raw);
    if (!name || name.length > limits.nameChars) { fail(req, res, 400, 'PROFILE_NAME'); return; }

    try {
      if (isRead) {
        const found = await readWithEtag(name);
        if (!found) { fail(req, res, 404, 'PROFILE_NOT_FOUND'); return; }
        res.setHeader('ETag', found.etag);
        // a conditional request that matches answers 304: nothing changed, so nothing is sent (a page load that has
        // nothing to sync costs a few hundred bytes instead of the whole profile)
        const inm = String(req.headers['if-none-match'] || '');
        const matches = inm.split(',').map((v) => v.trim().replace(/^W\//, '')).filter(Boolean).some((v) => v === found.etag);
        if (matches) {
          res.writeHead(304, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        sendJson(req, res, 200, { ...found.profile, name, etag: found.etag });
        return;
      }
      if (req.method === 'DELETE') {
        const existed = await remove(name);
        if (!existed) { fail(req, res, 404, 'PROFILE_NOT_FOUND'); return; }
        log?.info?.(`[profiles] ${name}: removed`);
        sendJson(req, res, 200, { ok: true, name });
        return;
      }
      // PUT: { keys: { <key>: <value> }, append: { stats: { v, records } } } — a request carries at least one of them
      let body;
      try { body = await readBody(req, limits.bodyBytes); } catch (e) {
        if (e.code === 'TOO_LARGE') { res.setHeader('Connection', 'close'); fail(req, res, 413, 'PROFILE_SIZE'); return; }
        throw e;
      }
      let payload;
      try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch { fail(req, res, 400, 'PROFILE_BODY'); return; }
      if (!isObj(payload)) { fail(req, res, 400, 'PROFILE_BODY'); return; }
      const rawKeys = payload.keys === undefined ? {} : payload.keys;
      if (!isObj(rawKeys)) { fail(req, res, 400, 'PROFILE_BODY'); return; }
      // `append` adds records: the client sends only the matches the account does not have yet (the server merges by id)
      const append = payload.append === undefined ? null : payload.append;
      if (append !== null) {
        if (!isObj(append)) { fail(req, res, 400, 'PROFILE_BODY'); return; }
        for (const sub of Object.keys(append)) {
          if (sub !== 'stats') { fail(req, res, 400, 'PROFILE_KEY', sub.slice(0, 64)); return; }
        }
        if (!isObj(append.stats) || !Array.isArray(append.stats.records)) { fail(req, res, 400, 'PROFILE_BODY'); return; }
        if (jsonBytes(append.stats) > limits.keyBytes) { fail(req, res, 413, 'PROFILE_SIZE', 'stats'); return; }
        if (rawKeys.stats !== undefined) { fail(req, res, 400, 'PROFILE_BODY'); return; } // one way or the other
      }
      const entries = Object.entries(rawKeys);
      // a request that carries nothing would still rewrite the file (and invalidate every ETag): refuse it
      if (!entries.length && !(append && append.stats.records.length)) { fail(req, res, 400, 'PROFILE_BODY'); return; }
      if (entries.length > limits.keys) { fail(req, res, 400, 'PROFILE_KEY'); return; }
      for (const [k, value] of entries) {
        if (!isProfileKey(k) || k.length > limits.keyChars) { fail(req, res, 400, 'PROFILE_KEY', k.slice(0, 64)); return; }
        if (jsonBytes(value) > limits.keyBytes) { fail(req, res, 413, 'PROFILE_SIZE', k); return; }
      }
      const values = Object.fromEntries(entries);
      const result = await write(name, values, append);
      const keys = Object.fromEntries(Object.keys(values).map((k) => [k, result.updatedAt]));
      log?.debug?.(`[profiles] ${name}: ${Object.keys(values).join(', ') || '-'}${append ? ` +${append.stats.records.length} stats` : ''}`);
      res.setHeader('ETag', result.etag);
      sendJson(req, res, 200, { name, updatedAt: result.updatedAt, keys, etag: result.etag, ...(result.stats ? { stats: result.stats } : {}) });
    } catch (e) {
      if (e?.code === 'PROFILE_FULL') { fail(req, res, 503, 'PROFILE_FULL'); return; }
      if (e?.code === 'PROFILE_DISK' || ['ENOSPC', 'EACCES', 'EPERM', 'EROFS'].includes(e?.code)) {
        if (!fsWarned) { fsWarned = true; log?.warn?.(`[profiles] cannot write ${dir}: ${e.code} — account sync unavailable`); }
        fail(req, res, 503, 'PROFILE_DISK');
        return;
      }
      log?.error?.('[profiles] request failed', e);
      fail(req, res, 500, 'PROFILE_ERROR');
    }
  }

  return { handles, handle, read, write, remove, has, count, dir, limits };
}
