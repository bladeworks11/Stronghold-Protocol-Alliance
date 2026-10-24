'use strict';
// 内容同步（client/sync.js）：把服务器上的「素材 + 插件文件」镜像一份到本地，之后启动只补缺、只换改过的。
//
// 为什么要有它：以前服务器一换素材/插件，就得重新发一个客户端安装包，否则客户端里的旧副本会一直生效（素材地址带内容
// 哈希，本地对不上就回落网络，但打包进去的旧文件仍然占着地方、旧的插件清单还指向老文件）。现在客户端启动后向
//
//     GET <server>/sync/manifest.json
//
// 要一份清单（server/http/syncManifest.js）：{ assets: {rel: hash16}, models: [[模型哈希, rel…]],
// plugins: {id: {version, files: {rel: sha256}}} }，和自己记录过的版本比较，然后：
//   * 缺的 → 下载（素材 /assets/~<hash>/<rel>、字体 /fonts/~<hash>/<rel>、插件 /p/<id>/<sha256 前 8>/<rel>），
//     按清单里的哈希校验字节，写进 <userData>/content/…（临时文件 + 改名，写一半断电不会留下坏文件）；
//   * 改过的 → 哈希不同，重新下载覆盖；
//   * 服务器上已经没有的 → 从本地缓存里删掉；
//   * 清单没变（If-None-Match 得 304）→ 什么都不做，一个字节都不下。
//
// 安装包里自带的素材/插件不会被复制进缓存：客户端另有一份「包内清单」（bundle-index.json，打包时生成）说明包里每个
// 文件的哈希，对得上就不再下载，所以完整安装包升级后只补真正新增/改动的那部分；没有包内清单的旧包则在首次同步时
// 按文件懒校验（结果记在 <userData>/bundle-check.json，客户端版本不变就一直有效）。
//
// 状态记在 <userData>/sync.json（清单 ETag + 每个已在本地可用的文件及其哈希），同步进度写 <userData>/sync-status.json
// 供界面/自检读取；manifest 的版本号不认识时直接放弃（向前兼容：旧客户端遇到新协议只是不同步，不会写坏东西）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_VERSION = 1;
const MANIFEST_PATH = '/sync/manifest.json';
const CONCURRENCY = 6;
const RETRIES = 3;
const MANIFEST_TIMEOUT_MS = 20_000;
const FILE_TIMEOUT_MS = 120_000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hash16 = (buf) => sha256(buf).slice(0, 16);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
};
const isFile = (abs) => { try { return fs.statSync(abs).isFile(); } catch { return false; } };

/** 素材 rel（'assets/…' / 'fonts/…'）→ 服务器 URL（带内容哈希段）。 */
function assetUrl(rel, hash) {
  if (rel.startsWith('assets/')) return `/assets/~${hash}/${rel.slice('assets/'.length)}`;
  if (rel.startsWith('fonts/')) return `/fonts/~${hash}/${rel.slice('fonts/'.length)}`;
  return null;
}

/** 插件文件的 URL（服务器用 sha256 前 8 位做缓存段）。 */
function pluginUrl(id, rel, sha) {
  return `/p/${encodeURIComponent(id)}/${sha.slice(0, 8)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * @param {{ dir: string, server: string, fetchFn?: (url: string, init?: object) => Promise<Response>,
 *           bundle?: { assetsDir?: string | null, pluginsDir?: string | null, indexFile?: string | null },
 *           app?: string, log?: (line: string) => void, concurrency?: number }} opts
 *   dir: 缓存根目录（<userData>/content）；bundle: 安装包自带的素材/插件目录与包内清单；app: 客户端版本（bundle-check 用）
 */
function createContentSync({ dir, server, fetchFn = null, bundle = {}, app = '', log = () => {}, concurrency = CONCURRENCY }) {
  const stateFile = path.join(dir, 'sync.json');
  const statusFile = path.join(dir, '..', 'sync-status.json');
  const bundleCheckFile = path.join(dir, '..', 'bundle-check.json');
  const bundleIndexFile = bundle.indexFile || (bundle.assetsDir ? path.join(path.dirname(bundle.assetsDir), 'bundle-index.json') : null);
  const doFetch = fetchFn || ((url, init) => fetch(url, init));

  let state = normalizeState(readJson(stateFile, null));
  let bundleIndex = readJson(bundleIndexFile, null);
  if (!bundleIndex || bundleIndex.v !== 1) bundleIndex = null;
  const bundleCheck = readJson(bundleCheckFile, null);
  const checked = bundleCheck && bundleCheck.app === app && bundleCheck.files ? bundleCheck.files : {};
  let checkedDirty = false;
  let running = null;
  let knownHashes = null;
  let modelIndex = null;

  function normalizeState(doc) {
    const out = { v: STATE_VERSION, etag: '', at: null, assets: {}, models: [], plugins: {} };
    if (!doc || doc.v !== STATE_VERSION) return out;
    if (typeof doc.etag === 'string') out.etag = doc.etag;
    if (typeof doc.at === 'string') out.at = doc.at;
    if (doc.assets && typeof doc.assets === 'object') {
      for (const [rel, h] of Object.entries(doc.assets)) if (typeof h === 'string') out.assets[rel] = h;
    }
    if (Array.isArray(doc.models)) {
      for (const group of doc.models) {
        if (!Array.isArray(group) || group.length < 2 || typeof group[0] !== 'string' || !group[0]) continue;
        const rels = group.slice(1).filter((rel) => typeof rel === 'string' && rel);
        if (rels.length) out.models.push([group[0], ...rels]);
      }
    }
    if (doc.plugins && typeof doc.plugins === 'object') {
      for (const [id, p] of Object.entries(doc.plugins)) {
        if (!p || typeof p !== 'object' || !p.files || typeof p.files !== 'object') continue;
        const files = {};
        for (const [rel, h] of Object.entries(p.files)) if (typeof h === 'string') files[rel] = h;
        out.plugins[id] = { version: String(p.version || ''), files };
      }
    }
    return out;
  }

  const assetAbs = (rel) => path.join(dir, ...rel.split('/'));
  const pluginAbs = (id, rel) => path.join(dir, 'plugins', id, ...rel.split('/'));
  const bundleAssetAbs = (rel) => {
    if (!bundle.assetsDir) return null;
    if (rel.startsWith('assets/')) return path.join(bundle.assetsDir, ...rel.slice('assets/'.length).split('/'));
    if (rel.startsWith('fonts/')) return path.join(path.dirname(bundle.assetsDir), 'fonts', ...rel.slice('fonts/'.length).split('/'));
    return null;
  };
  const bundlePluginAbs = (id, rel) => (bundle.pluginsDir ? path.join(bundle.pluginsDir, id, ...rel.split('/')) : null);

  /** 包内文件的哈希（包内清单优先，其次懒校验一次并记住）。返回 null 表示包里没有这个文件。 */
  function bundleHash(rel) {
    const key = `a:${rel}`;
    if (bundleIndex && bundleIndex.assets && typeof bundleIndex.assets[rel] === 'string') return bundleIndex.assets[rel];
    if (key in checked) return checked[key];
    const abs = bundleAssetAbs(rel);
    if (!abs || !isFile(abs)) return null;
    let h = null;
    try { h = hash16(fs.readFileSync(abs)); } catch { return null; }
    checked[key] = h;
    checkedDirty = true;
    return h;
  }

  function bundlePluginHash(id, rel) {
    const key = `p:${id}/${rel}`;
    const fromIndex = bundleIndex && bundleIndex.plugins && bundleIndex.plugins[id] && bundleIndex.plugins[id].files;
    if (fromIndex && typeof fromIndex[rel] === 'string') return fromIndex[rel];
    if (key in checked) return checked[key];
    const abs = bundlePluginAbs(id, rel);
    if (!abs || !isFile(abs)) return null;
    let h = null;
    try { h = sha256(fs.readFileSync(abs)); } catch { return null; }
    checked[key] = h;
    checkedDirty = true;
    return h;
  }

  function persistCheck() {
    if (!checkedDirty) return;
    checkedDirty = false;
    writeJson(bundleCheckFile, { app, at: new Date().toISOString(), files: checked });
  }

  function status(value) {
    writeJson(statusFile, { at: new Date().toISOString(), ...value });
  }

  /** 下载一个文件到 abs（校验 sha256 的前 hash.length 位），失败重试。 */
  async function download(url, abs, hash) {
    let lastError = null;
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      try {
        const res = await doFetch(`${server}${url}`, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const want = hash.length === 16 ? hash16(buf) : sha256(buf);
        if (want !== hash) throw new Error(`hash mismatch (${want.slice(0, 12)} != ${hash.slice(0, 12)})`);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = `${abs}.${process.pid}.part`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, abs);
        return buf.length;
      } catch (err) {
        lastError = err;
        if (attempt < RETRIES - 1) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    throw lastError || new Error('download failed');
  }

  /** 一批下载，最多 concurrency 个同时进行；失败的不阻塞其它文件。 */
  async function runJobs(jobs, onDone) {
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          const bytes = await download(job.url, job.abs, job.hash);
          onDone(job, bytes, null);
        } catch (err) {
          onDone(job, 0, err);
        }
      }
    });
    await Promise.all(workers);
  }

  /** 服务器上已经没有的文件，从缓存里删掉（安装包自带的不管）。 */
  function prune(keep, listFiles) {
    let removed = 0;
    for (const abs of listFiles()) {
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (keep.has(rel)) continue;
      try { fs.rmSync(abs, { force: true }); removed += 1; } catch { /* ignore */ }
    }
    return removed;
  }

  function eachCacheFile(root) {
    const out = [];
    const walk = (abs) => {
      let ents;
      try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const d of ents) {
        const child = path.join(abs, d.name);
        if (d.isDirectory()) walk(child);
        else if (d.isFile()) out.push(child);
      }
    };
    walk(root);
    return out;
  }

  async function sync() {
    if (running) return running;
    running = (async () => {
      const started = Date.now();
      // 1. 要清单（有 ETag 就带上：没变时 304，一个字节都不下）
      let res;
      try {
        const headers = state.etag ? { 'if-none-match': state.etag } : {};
        res = await doFetch(`${server}${MANIFEST_PATH}`, { headers, signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
      } catch (err) {
        status({ state: 'offline', error: String((err && err.message) || err) });
        return { ok: false, offline: true, error: String((err && err.message) || err) };
      }
      if (res.status === 304) {
        status({ state: 'done', skipped: true, at: new Date().toISOString() });
        return { ok: true, skipped: true, downloaded: 0, bytes: 0, ms: Date.now() - started };
      }
      if (res.status === 503) {
        status({ state: 'waiting', error: 'manifest not ready' });
        return { ok: false, waiting: true };
      }
      if (!res.ok) {
        status({ state: 'error', error: `manifest HTTP ${res.status}` });
        return { ok: false, error: `manifest HTTP ${res.status}` };
      }
      let doc;
      try { doc = await res.json(); } catch (err) {
        status({ state: 'error', error: 'manifest is not JSON' });
        return { ok: false, error: 'manifest is not JSON' };
      }
      if (!doc || doc.v !== 1 || !doc.assets || typeof doc.assets !== 'object') {
        status({ state: 'error', error: 'manifest version not understood' });
        return { ok: false, error: 'manifest version not understood' };
      }
      const assets = doc.assets;
      const models = Array.isArray(doc.models) ? doc.models.filter((g) => Array.isArray(g) && g.length > 1) : [];
      const plugins = doc.plugins && typeof doc.plugins === 'object' ? doc.plugins : {};
      const pluginRels = [];
      for (const [id, p] of Object.entries(plugins)) {
        if (!p || !p.files || typeof p.files !== 'object') continue;
        for (const [rel, sha] of Object.entries(p.files)) if (typeof sha === 'string' && sha.length === 64) pluginRels.push({ id, rel, sha });
      }
      const total = Object.keys(assets).length + pluginRels.length;
      status({ state: 'syncing', total, done: 0, bytes: 0 });

      // 2. 比对：本地缓存对得上、或安装包里有同样字节的，都算「已具备」
      const jobs = [];
      const present = { assets: {}, plugins: {} };
      for (const [rel, hash] of Object.entries(assets)) {
        if (typeof hash !== 'string') continue;
        if (state.assets[rel] === hash && isFile(assetAbs(rel))) { present.assets[rel] = hash; continue; }
        if (bundleHash(rel) === hash) {
          present.assets[rel] = hash;
          // 安装包里的那份就是当前版本：缓存里如果还躺着旧副本，删掉，免得被当成新的
          const stale = assetAbs(rel);
          if (state.assets[rel] !== hash && isFile(stale)) { try { fs.rmSync(stale, { force: true }); } catch { /* ignore */ } }
          continue;
        }
        const url = assetUrl(rel, hash);
        if (!url) continue;
        jobs.push({ kind: 'asset', rel, hash, url, abs: assetAbs(rel) });
      }
      for (const { id, rel, sha } of pluginRels) {
        const known = state.plugins[id] && state.plugins[id].files ? state.plugins[id].files[rel] : null;
        if (known === sha && isFile(pluginAbs(id, rel))) {
          (present.plugins[id] = present.plugins[id] || { version: String(plugins[id].version || ''), files: {} }).files[rel] = sha;
          continue;
        }
        if (bundlePluginHash(id, rel) === sha) {
          (present.plugins[id] = present.plugins[id] || { version: String(plugins[id].version || ''), files: {} }).files[rel] = sha;
          const stale = pluginAbs(id, rel);
          if (known !== sha && isFile(stale)) { try { fs.rmSync(stale, { force: true }); } catch { /* ignore */ } }
          continue;
        }
        jobs.push({ kind: 'plugin', id, rel, hash: sha, url: pluginUrl(id, rel, sha), abs: pluginAbs(id, rel) });
      }
      persistCheck();

      // 3. 下缺的 / 换改过的
      let done = 0;
      let bytes = 0;
      let failed = 0;
      const errors = [];
      let lastStatus = 0;
      const onDone = (job, n, err) => {
        done += 1;
        if (err) {
          failed += 1;
          if (errors.length < 8) errors.push(`${job.kind === 'asset' ? '' : `${job.id}/`}${job.rel}: ${err.message}`);
          return;
        }
        bytes += n;
        if (job.kind === 'asset') present.assets[job.rel] = job.hash;
        else (present.plugins[job.id] = present.plugins[job.id] || { version: '', files: {} }).files[job.rel] = job.hash;
        const now = Date.now();
        if (now - lastStatus > 400) { lastStatus = now; status({ state: 'syncing', total, done, bytes }); }
      };
      await runJobs(jobs, onDone);

      // 4. 服务器上已经没有的，从缓存删掉
      const keepAssets = new Set(Object.keys(present.assets).map((rel) => rel));
      const keepPlugins = new Set();
      for (const [id, p] of Object.entries(present.plugins)) for (const rel of Object.keys(p.files)) keepPlugins.add(`plugins/${id}/${rel}`);
      const removedAssets = prune(keepAssets, () => eachCacheFile(path.join(dir, 'assets')).concat(eachCacheFile(path.join(dir, 'fonts'))));
      const removedPlugins = prune(keepPlugins, () => eachCacheFile(path.join(dir, 'plugins')));

      // 5. 记下这次的结果（只记「确实已经具备」的文件；失败的留给下次）
      const next = {
        v: STATE_VERSION,
        etag: failed ? '' : String(res.headers.get('etag') || ''),
        at: new Date().toISOString(),
        assets: present.assets,
        models,
        plugins: {},
      };
      for (const [id, p] of Object.entries(present.plugins)) {
        const version = String((plugins[id] && plugins[id].version) || p.version || '');
        next.plugins[id] = { version, files: p.files };
      }
      state = next;
      writeJson(stateFile, state);
      knownHashes = null;
      modelIndex = null;
      status({ state: failed ? 'partial' : 'done', total, done, bytes, failed, removed: removedAssets + removedPlugins, errors });
      const ms = Date.now() - started;
      if (jobs.length || removedAssets || removedPlugins) {
        log(`[sync] ${jobs.length} file(s) to fetch, ${done} done, ${failed} failed, ${(bytes / 1048576).toFixed(1)} MB, ${removedAssets + removedPlugins} removed, ${ms} ms`);
      } else {
        log(`[sync] up to date (${total} files)${ms > 200 ? `, ${ms} ms` : ''}`);
      }
      return { ok: failed === 0, total, fetched: done, failed, bytes, removed: removedAssets + removedPlugins, ms };
    })().finally(() => { running = null; });
    return running;
  }

  /** 缓存里这个素材文件是否存在（不校验哈希；写入时校验过）。 */
  function cachedAsset(rel) {
    const abs = assetAbs(rel);
    return isFile(abs) ? abs : null;
  }

  function cachedPlugin(id, rel) {
    const abs = pluginAbs(id, rel);
    return isFile(abs) ? abs : null;
  }

  /** 缓存里有没有这个素材的「当前版本」（用于忽略 URL 里的模型哈希段）。 */
  function assetRecord(rel) {
    return state.assets[rel] || null;
  }

  /** URL 里的哈希是不是别的素材文件的内容哈希（否则可能是 Spine 模型哈希，按当前文件回答）。 */
  function isAssetFileHash(hash) {
    if (!hash) return false;
    if (!knownHashes) knownHashes = new Set(Object.values(state.assets));
    return knownHashes.has(hash);
  }

  /** Spine 模型的哈希 → 它包含的文件（清单的 models 分组）。 */
  function modelMembers(hash) {
    if (!hash) return null;
    if (!modelIndex) {
      modelIndex = new Map();
      for (const group of state.models) modelIndex.set(group[0], new Set(group.slice(1)));
    }
    return modelIndex.get(hash) || null;
  }

  /** 这个 URL 里的哈希是不是包含 rel 的那个 Spine 模型的哈希。 */
  function isAssetModelHash(rel, hash) {
    const members = modelMembers(hash);
    return Boolean(members && members.has(rel));
  }

  /** 安装包里这个素材的哈希（包内清单优先，旧包懒校验一次）；null 表示安装包里没有。 */
  function bundleAssetHash(rel) {
    return bundleHash(rel);
  }

  /** 安装包里这个插件文件的哈希（同上）。 */
  function bundlePluginFileHash(id, rel) {
    return bundlePluginHash(id, rel);
  }

  function pluginRecord(id, rel) {
    const p = state.plugins[id];
    return p && p.files ? p.files[rel] || null : null;
  }

  return {
    run: sync,
    cachedAsset,
    cachedPlugin,
    assetRecord,
    isAssetFileHash,
    isAssetModelHash,
    bundleAssetHash,
    bundlePluginFileHash,
    pluginRecord,
    get root() { return dir; },
    get state() { return state; },
    /** 测试/自检：换一份状态重新读（不常用）。 */
    reload() { state = normalizeState(readJson(stateFile, null)); knownHashes = null; modelIndex = null; },
    statusFile,
    stateFile,
  };
}

module.exports = { createContentSync, assetUrl, pluginUrl, MANIFEST_PATH };
