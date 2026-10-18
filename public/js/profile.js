// public/js/profile.js — 账号同步 (account sync): the server keeps this player's preferences under the nickname they play
// with, so another device picks them up. One nickname is one account; there is no password (the owner's decision), so the
// server's copy is what it says: whoever knows a nickname can read and rewrite that account's settings.
//
// What syncs: every `sp.pref.*` value of this browser except the bookkeeping of the sync itself (`sp.pref.sync`) and the
// browser's rescue copy of a damaged stats envelope (`sp.pref.stats.damaged`). That is 设置 (画面 / 声音 / 语言), 快捷键,
// 编队 / 持有 / 自选, 表情, the lobby's remembered choices and 对局统计 (`sp.pref.stats`, the match history of
// public/js/ui/stats.js). Session tokens (`sp.tokens`) and the nickname (`sp.name`) are not preferences and never leave
// the browser this way.
//
// The flow — the browser always holds a working copy, the server is the shared one:
//   * a local preference write (savePref) marks its key; 1.2 s later the marked keys go up (one PUT, debounced);
//   * on page load, with sync on: no account on the server → upload; local edits since the last sync → upload (this
//     device wins); the account changed elsewhere → download, apply and reload once;
//   * 对局统计 of a settled match are written by the SERVER (server/statsRecord.js) — same record id, so the copy this
//     browser keeps for its history and the account's copy collapse on merge (ui/stats.js mergeStats); this browser
//     uploads only what the server cannot know: a match it gave up early (`end: 'quit'`) and, once, the history of an
//     account it is adopting;
//   * the account's records and this browser's are merged by record id on every download, so two devices add to one
//     history instead of replacing it;
//   * 设置 → 账号同步 has the switch and the explicit buttons (上传本机设置 / 下载账号设置 / 删除服务器上的设置).
//
// Applying downloaded values writes localStorage directly (never savePref), so a download cannot echo back as an upload.
// The account name is the nickname the title screen enters (screens/title.js enterSession → accountEntered).

import { createStore, onPrefSaved, loadPref, savePref, store } from './store.js';
import { identity } from './net.js';
import { loadStats, saveStats, mergeStats } from './ui/stats.js';
import { PROFILE_API, PROFILE_LIMITS, profileUrl } from '../../shared/profiles.js';
import { t } from '../../shared/i18n.js';

export { PROFILE_API, PROFILE_LIMITS };

/** localStorage key (under `sp.pref.`) of the sync's own bookkeeping: { name, enabled, at, hash }. */
export const SYNC_KEY = 'sync';
/** The prefix of every preference (`sp.pref.<key>`, store.js loadPref / savePref). */
export const PREF_PREFIX = 'sp.pref.';
/** How long after a local change the upload runs (a slider drag writes many times) [ASSUMED]. */
export const UPLOAD_DELAY_MS = 1200;
/** Request timeout of one sync call [ASSUMED]. */
export const REQUEST_TIMEOUT_MS = 8000;
/** Preferences that never travel: the sync's own bookkeeping and the browser's rescue copy of damaged stats. */
const DENIED = new Set([SYNC_KEY, 'stats.damaged']);

/**
 * What the settings page shows: { name, enabled, status ('off' | 'idle' | 'syncing' | 'ok' | 'error'), at, error }.
 */
export const syncState = createStore({ name: '', enabled: false, status: 'off', at: 0, error: null });

/** localStorage, or null where it is unavailable (private mode, a sandboxed frame). */
function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * The sync's bookkeeping.
 * @returns {{ name: string, enabled: boolean, at: number, hash: string, etag: string, sent: string[] }}
 *   etag: the account's ETag as of the last sync (a page load sends it back and gets a body-less 304 when nothing
 *   changed); sent: the ids of the 对局统计 records the account is known to have (a finished match uploads only the new
 *   ones, not the whole envelope)
 */
export function loadSync() {
  const raw = loadPref(SYNC_KEY, null);
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    name: typeof o.name === 'string' ? o.name : '',
    enabled: o.enabled === true,
    at: Number.isFinite(o.at) ? o.at : 0,
    hash: typeof o.hash === 'string' ? o.hash : '',
    etag: typeof o.etag === 'string' ? o.etag : '',
    sent: (Array.isArray(o.sent) ? o.sent : []).filter((id) => typeof id === 'string' && id).slice(0, PROFILE_LIMITS.records),
  };
}

/**
 * Remember what both sides agreed on (also the switch of the sync).
 * @param {{ name?: string, enabled?: boolean, at?: number, hash?: string, etag?: string, sent?: string[] }} patch
 */
export function saveSync(patch) {
  const next = { ...loadSync(), ...patch };
  savePref(SYNC_KEY, next);
  return next;
}

/**
 * The ids of the records in a stats envelope (`{ v, records }`), as the sync bookkeeping keeps them.
 * @param {any} envelope
 * @returns {string[]}
 */
function recordIds(envelope) {
  const records = envelope && Array.isArray(envelope.records) ? envelope.records : [];
  return records.map((r) => (r && typeof r.id === 'string' ? r.id : '')).filter(Boolean).slice(0, PROFILE_LIMITS.records);
}

/**
 * Every preference this browser holds, as `{ <key>: <value> }` (JSON values, the ones `sp.pref.<key>` stores).
 * @param {Storage | null} [storage]
 * @returns {Record<string, any>}
 */
export function collectPrefs(storage = safeStorage()) {
  const out = {};
  if (!storage) return out;
  let count = 0;
  try { count = Number(storage.length) || 0; } catch { /* a storage without a length holds nothing */ }
  for (let i = 0; i < count; i++) {
    let full = null;
    try { full = storage.key(i); } catch { /* a key that cannot be read is skipped */ }
    if (typeof full !== 'string' || !full.startsWith(PREF_PREFIX)) continue;
    const key = full.slice(PREF_PREFIX.length);
    if (!key || DENIED.has(key)) continue;
    let raw;
    try { raw = storage.getItem(full); } catch { continue; }
    if (raw == null) continue;
    try { out[key] = JSON.parse(raw); } catch { /* not a JSON preference: leave it alone */ }
  }
  return out;
}

/**
 * A short fingerprint of a preference set — what the sync remembers about the state both sides agreed on (a hash, not a
 * version: it only has to tell "does this browser still hold what it last synced").
 * @param {Record<string, any>} values
 * @returns {string}
 */
export function prefsHash(values) {
  const text = Object.keys(values).sort().map((k) => `${k}\u0000${JSON.stringify(values[k])}`).join('\u0001');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${text.length.toString(36)}-${h.toString(36)}`;
}

/**
 * Write downloaded preferences into this browser (localStorage directly: no savePref, no echo). `stats` is merged with the
 * local history instead of replacing it (ui/stats.js mergeStats).
 * @param {Record<string, any>} values
 * @param {Storage | null} [storage]
 * @returns {string[]} the keys that were written
 */
export function applyPrefs(values, storage = safeStorage()) {
  const applied = [];
  if (!values || typeof values !== 'object') return applied;
  // applying an account is not a local edit: nothing written here may echo back as an upload (the caller uploads what the
  // merge added, once, itself)
  quietWrites = true;
  try {
    for (const [key, value] of Object.entries(values)) {
      if (!key || DENIED.has(key)) continue;
      if (key === 'stats') {
        try { saveStats(mergeStats(loadStats(), value)); applied.push(key); } catch { /* keep the local history */ }
        continue;
      }
      if (!storage) continue;
      try {
        const json = JSON.stringify(value);
        if (json.length > PROFILE_LIMITS.keyBytes) continue; // the server would refuse it anyway
        storage.setItem(`${PREF_PREFIX}${key}`, json);
        applied.push(key);
      } catch { /* quota / no storage */ }
    }
  } finally {
    quietWrites = false;
  }
  return applied;
}

/**
 * One request against the account API.
 * @param {string} name @param {RequestInit} [init]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function call(name, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(profileUrl(name), { credentials: 'same-origin', cache: 'no-store', signal: ctl.signal, ...init });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The account on the server. With an `etag` the request is conditional: when the account has not changed since that
 * ETag, the answer is a 304 with no body (`{ notModified: true }`) — a page load with nothing to sync then costs a few
 * hundred bytes instead of the whole profile.
 * @param {string} name
 * @param {{ etag?: string }} [opts]
 * @returns {Promise<{ notModified: true } | { name: string, updatedAt: number, keys: Record<string, any>, etag: string } | null>}
 *   null when there is no account
 */
export async function fetchAccount(name, { etag = '' } = {}) {
  const { status, body } = await call(name, etag ? { headers: { 'if-none-match': etag } } : {});
  if (status === 304) return { notModified: true };
  if (status === 404) return null;
  if (status !== 200 || !body || typeof body !== 'object' || !body.keys) {
    throw Object.assign(new Error('account unavailable'), { code: body?.error || `HTTP_${status}` });
  }
  return {
    name: typeof body.name === 'string' ? body.name : name,
    updatedAt: Number(body.updatedAt) || 0,
    keys: body.keys,
    etag: typeof body.etag === 'string' ? body.etag : '',
  };
}

/**
 * Upload preferences and/or records.
 * @param {string} name
 * @param {Record<string, any>} keys whole preference values
 * @param {{ v: number, records: any[] } | null} [append] the 对局统计 records the account does not have yet
 * @returns {Promise<{ updatedAt: number, stats: any, etag: string }>}
 */
export async function saveAccount(name, keys, append = null) {
  const payload = {};
  if (Object.keys(keys).length) payload.keys = keys;
  if (append && Array.isArray(append.records) && append.records.length) payload.append = { stats: append };
  const { status, body } = await call(name, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (status !== 200 || !body || typeof body !== 'object') {
    throw Object.assign(new Error('account not saved'), { code: body?.error || `HTTP_${status}` });
  }
  return { updatedAt: Number(body.updatedAt) || 0, stats: body.stats ?? null, etag: typeof body.etag === 'string' ? body.etag : '' };
}

/**
 * Remove the account from the server.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function removeAccount(name) {
  const { status, body } = await call(name, { method: 'DELETE' });
  if (status === 404) return false;
  if (status !== 200) throw Object.assign(new Error('account not removed'), { code: body?.error || `HTTP_${status}` });
  return true;
}

/** The nickname this page plays with (the store's name, else the remembered one). */
function accountName() {
  const fromStore = store.get()?.me?.name;
  if (typeof fromStore === 'string' && fromStore) return fromStore;
  try { return identity.loadName() || ''; } catch { return ''; }
}

/**
 * A short description of a failed call for the status line.
 * @param {any} err
 * @returns {string}
 */
export function describeSyncError(err) {
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'PROFILE_RATE') return t('请求太频繁，请稍后再试');
  if (code === 'PROFILE_SIZE') return t('设置大于服务器允许的大小');
  if (code === 'PROFILE_FULL') return t('服务器上的账号数量已满');
  if (code === 'PROFILE_DISK') return t('服务器无法写入账号文件');
  if (code === 'HTTP_405' || code === 'HTTP_403') return t('服务器没有开启账号同步');
  if (err?.name === 'AbortError') return t('请求超时');
  return code || String(err?.message || err).slice(0, 80);
}

// ---- the sync itself -------------------------------------------------------------------------------

/** Keys waiting for the upload timer. @type {Set<string>} */
const pending = new Set();
let timer = null;
/** Whether a PUT is on the wire (a second flush waits for it). */
let busy = false;
/** Set while a downloaded account is being written: those writes must not be taken for local edits. */
let quietWrites = false;
/** The settings page's toast, and how the page reloads after a download (main.js installProfileSync). */
let notify = () => {};
let reloadPage = () => { try { globalThis.location?.reload(); } catch { /* no page (a test) */ } };

/**
 * Upload preferences (all of them, or the named keys) and remember the state both sides agreed on.
 *
 * 对局统计 are the server's own copy now: it writes one record per player at settlement (server/statsRecord.js, the same
 * record id), so a finished match costs no upload at all. What the server cannot know still goes up:
 *   * a match this browser gave up early (`end: 'quit'` — the leaver gets no settlement);
 *   * the whole history, once, when the account is adopted (`bootstrap`: a browser that played before it had an account);
 *   * everything on request (`force`: 设置 → 账号同步「上传本机设置」, and the union after a download) — a safety net for a
 *     record the server could not save.
 * `append` carries those records only; the server answers with the union, which this browser then adopts.
 * @param {string[] | null} [keys] the preference keys to send (null: all)
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
async function upload(keys = null, { force = false } = {}) {
  const cfg = loadSync();
  if (!cfg.enabled || !cfg.name) return false;
  const all = collectPrefs();
  const wanted = (k) => !keys || keys.includes(k);
  const values = {};
  for (const [k, v] of Object.entries(all)) if (k !== 'stats' && wanted(k)) values[k] = v;
  let append = null;
  if (wanted('stats') && all.stats && Array.isArray(all.stats.records)) {
    const known = new Set(cfg.sent);
    const bootstrap = !cfg.at && !cfg.sent.length;
    const fresh = all.stats.records.filter((r) => {
      if (!r || typeof r.id !== 'string' || !r.id) return false;
      if (known.has(r.id)) return false;
      return force || bootstrap || r.end === 'quit';
    });
    if (fresh.length) append = { v: Number(all.stats.v) || 0, records: fresh };
  }
  if (!Object.keys(values).length && !append) return true;
  syncState.set({ status: 'syncing', error: null });
  try {
    const res = await saveAccount(cfg.name, values, append);
    // the server merges the stats envelope: take its union (it may hold records of another device)
    if (res.stats) applyPrefs({ stats: res.stats });
    saveSync({
      at: res.updatedAt,
      hash: prefsHash(collectPrefs()),
      etag: res.etag,
      // the account now holds every record this browser has (its own settlements are written there by the server)
      sent: append ? recordIds(collectPrefs().stats) : cfg.sent,
    });
    syncState.set({ status: 'ok', at: res.updatedAt, error: null });
    return true;
  } catch (err) {
    syncState.set({ status: 'error', error: describeSyncError(err) });
    return false;
  }
}

/** Send the pending keys once the debounce has passed. */
async function flush() {
  if (busy) { scheduleUpload(pending); return; }
  const keys = [...pending];
  pending.clear();
  if (!keys.length) return;
  busy = true;
  try { await upload(keys); } finally { busy = false; }
}

/**
 * Mark keys for the next upload.
 * @param {Iterable<string>} keys
 */
function scheduleUpload(keys) {
  for (const k of keys) pending.add(k);
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void flush(); }, UPLOAD_DELAY_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

/**
 * Apply a downloaded account, push what the merge added, and reload the page once: modules that read `sp.pref.*` at load
 * (settings, language, loadout) keep what they read, so a running page cannot take the values over. A match on screen is
 * never thrown away by a reload — the values are stored and the page says when they take effect.
 * @param {{ name: string, updatedAt: number, keys: Record<string, any>, etag?: string }} account
 */
async function applyAccount(account) {
  applyPrefs(account.keys);
  // what the account itself holds: the upload below then sends only the records it lacks (a local history it never saw)
  const serverIds = recordIds(account.keys?.stats);
  saveSync({ name: account.name, at: account.updatedAt, hash: prefsHash(collectPrefs()), etag: account.etag || '', sent: serverIds });
  syncState.set({ name: account.name, status: 'ok', at: account.updatedAt, error: null });
  if (recordIds(collectPrefs().stats).some((id) => !serverIds.includes(id))) await upload(['stats'], { force: true });
  if (store.get()?.match?.public) { notify(t('对局结束后刷新页面，设置就会生效'), 'info'); return; }
  reloadPage();
}

/**
 * Reconcile the browser with the account. On a page load this browser's edits win (`adopt: false`): upload when the
 * server has nothing or when something changed since the last sync, download only when the account changed elsewhere and
 * this browser did not. Switching the sync on, or entering another nickname, means "this account is mine now"
 * (`adopt: true`): an account that exists is taken over, otherwise this browser's copy becomes the account.
 * The request is conditional (the ETag of the last sync): an unchanged account answers 304 with no body.
 * @param {string} [name] the account (default: the one this browser synced)
 * @param {{ adopt?: boolean }} [opts]
 */
async function bootSync(name = '', { adopt = false } = {}) {
  const cfg = loadSync();
  const account = name || cfg.name;
  if (!cfg.enabled || !account) return;
  syncState.set({ name: account, enabled: true, status: 'idle', error: null });
  const etag = cfg.name === account ? cfg.etag : '';
  let remote;
  try {
    remote = await fetchAccount(account, { etag });
  } catch (err) {
    syncState.set({ status: 'error', error: describeSyncError(err) });
    return;
  }
  const localHash = prefsHash(collectPrefs());
  if (remote?.notModified) {
    // the account is exactly what this browser last synced: nothing to download (a few hundred bytes spent)
    if (localHash !== cfg.hash) await upload();
    else syncState.set({ status: 'ok', at: cfg.at });
    return;
  }
  if (!remote) { await upload(); return; }
  if (!adopt && localHash !== cfg.hash) { await upload(); return; }
  if (!adopt && remote.updatedAt === cfg.at) { saveSync({ etag: remote.etag }); syncState.set({ status: 'ok', at: cfg.at }); return; }
  await applyAccount(remote);
}

/**
 * Boot hook (main.js): wire preference writes to the upload and reconcile once when the sync is on.
 * @param {{ notify?: (text: string, kind?: string) => void, reload?: () => void }} [opts]
 */
export function installProfileSync({ notify: say = null, reload = null } = {}) {
  if (typeof say === 'function') notify = say;
  if (typeof reload === 'function') reloadPage = reload;
  const cfg = loadSync();
  syncState.set({ name: cfg.name || accountName(), enabled: !!cfg.enabled, status: cfg.enabled ? 'idle' : 'off', at: cfg.at || 0, error: null });
  onPrefSaved((key) => {
    if (DENIED.has(key) || quietWrites) return;
    const c = loadSync();
    if (!c.enabled || !c.name) return;
    scheduleUpload([key]);
  });
  if (!cfg.enabled) return;
  if (!cfg.name) {
    const name = accountName();
    if (!name) return;
    saveSync({ name });
  }
  void bootSync();
}

/**
 * 设置 → 账号同步: switch the sync on or off for the nickname this page plays with. Switching it on takes over the
 * account when the server has one (download, then the page reloads) and uploads this browser's copy when it has none.
 * @param {boolean} on
 * @returns {{ ok: boolean, error?: 'no-name' }}
 */
export function setSyncEnabled(on) {
  const name = accountName() || loadSync().name;
  if (on && !name) return { ok: false, error: 'no-name' };
  // switching it on adopts the account: no remembered ETag or record list may stand between the two sides
  const cfg = saveSync({ name, enabled: !!on, hash: '', ...(on ? { etag: '', sent: [] } : {}) });
  syncState.set({ name: cfg.name, enabled: !!on, status: on ? 'syncing' : 'off', at: cfg.at, error: null });
  if (on) void bootSync(name, { adopt: true });
  return { ok: true };
}

/**
 * The title screen entered a nickname (screens/title.js enterSession): a different account than the one this browser
 * synced goes through the same reconcile as a page load.
 * @param {string} name
 */
export function accountEntered(name) {
  const cfg = loadSync();
  if (!cfg.enabled || !name || cfg.name === name) return;
  saveSync({ name, at: 0, hash: '', etag: '', sent: [] });
  syncState.set({ name, enabled: true, status: 'syncing', error: null });
  void bootSync(name, { adopt: true });
}

/** 设置 → 账号同步「上传本机设置」: everything this browser holds goes up and the account follows it. */
export async function uploadNow() {
  const name = accountName() || loadSync().name;
  if (!name) return { ok: false, error: 'no-name' };
  if (!loadSync().name) saveSync({ name });
  // an explicit request: everything this browser holds, including matches the server may have missed
  const ok = await upload(null, { force: true });
  if (ok) notify(t('本机设置已上传到「{name}」', { name }), 'success');
  else notify(t('同步失败：{error}', { error: syncState.get().error || '' }), 'error');
  return { ok };
}

/** 设置 → 账号同步「下载账号设置」: the account replaces this browser's copy (stats are merged) and the page reloads. */
export async function downloadNow() {
  const name = accountName() || loadSync().name;
  if (!name) return { ok: false, error: 'no-name' };
  syncState.set({ name, status: 'syncing', error: null });
  let account;
  try {
    account = await fetchAccount(name);
  } catch (err) {
    const error = describeSyncError(err);
    syncState.set({ status: 'error', error });
    notify(t('同步失败：{error}', { error }), 'error');
    return { ok: false, error };
  }
  if (!account) {
    // nothing to download yet: this browser's copy becomes the account
    const ok = await upload(null, { force: true });
    if (ok) notify(t('服务器上没有「{name}」的设置，已改为上传本机设置', { name }), 'info');
    return { ok };
  }
  // applyAccount reloads the page (or, mid-match, says when the values take effect)
  await applyAccount(account);
  return { ok: true };
}

/** 设置 → 账号同步「删除服务器上的设置」: the account is removed, this browser keeps its copy and stops syncing. */
export async function deleteAccount() {
  const name = accountName() || loadSync().name;
  if (!name) return { ok: false, error: 'no-name' };
  try {
    const existed = await removeAccount(name);
    saveSync({ enabled: false, at: 0, hash: '', etag: '', sent: [] });
    syncState.set({ enabled: false, status: 'off', at: 0, error: null });
    return { ok: true, existed };
  } catch (err) {
    const error = describeSyncError(err);
    syncState.set({ status: 'error', error });
    return { ok: false, error };
  }
}
