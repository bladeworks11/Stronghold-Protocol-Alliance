// server/http/syncManifest.js — GET /sync/manifest.json: what a desktop client (client/sync.js) keeps a copy of.
//
// The desktop client (client/) serves /assets/…, /fonts/…, /media/… and /p/<id>/<hash8>/… from its own folder when it
// has the file, and from this server otherwise. This route says which files this server serves right now and the hash
// of each one's bytes, so the client can download exactly what it lacks, replace what changed and drop what is gone:
//
//   { v: 1, app, at, counts: { assets, plugins, models }, assets: { '<rel>': '<hash16>' },
//     models: [['<model hash>', '<rel>', '<rel>', …], …],
//     plugins: { '<id>': { version, files: { '<rel>': '<sha256>' } } } }
//
// * assets/ and fonts/ — every file the asset index (assetIndex.js) has hashed, with its 16-hex content hash. That is
//   the hash a served URL carries (`/assets/~0123456789abcdef/char/…`).
// * models — a Spine model's skeleton, atlas and pages share the hash of the model (its members' hashes hashed), so the
//   client cannot recognise those URLs by the file hashes alone; these groups say which files a model's hash names, and
//   the client answers such a URL from its own copy instead of asking this server again.
// * plugins — the files a loaded cosmetic or ui plugin serves at /p/<id>/<hash8>/<rel> (registry.js pluginFile, the same
//   list), with the SHA-256 their URLs name. The client fetches `/p/<id>/<sha256 8>/<rel>` and checks the whole hash.
//
// The document is built on the first request, kept until the asset index or the plugin folders change (assetIndex
// onChange, registry onScan), and sent gzipped with a strong ETag: a client that already has this set sends
// If-None-Match and gets a 304, reading no body at all.
//
// While the asset index is still building the answer is 503 — never a short list, which a client would have to read as
// "those files were deleted on the server" and drop its copy.

import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { APP_VERSION } from '../../shared/constants.js';
import { sendJson } from './common.js';

/** Version of the JSON body (client/sync.js refuses a version it does not know). */
export const SYNC_MANIFEST_VERSION = 1;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const etagOf = (bytes) => `"${sha256(bytes).slice(0, 32)}"`;
const noopLog = { info() {}, warn() {}, debug() {} };

/** The `{ rel: sha256 }` map of the files one loaded plugin serves (cosmetic plugin files, ui plugin frames). */
function pluginFiles(plugin) {
  const files = {};
  for (const served of [plugin.visual?.served, plugin.ui?.served]) {
    if (!served) continue;
    for (const [rel, f] of served) if (f && typeof f.sha256 === 'string' && f.sha256.length === 64) files[rel] = f.sha256;
  }
  return files;
}

/**
 * The /sync/manifest.json route.
 * @param {{ assetIndex?: ReturnType<import('./assetIndex.js').createAssetIndex> | null,
 *           registry?: ReturnType<import('../plugins/registry.js').createPluginRegistry> | null,
 *           app?: string, log?: object }} opts
 *   assetIndex: the content hashes of public/assets and public/fonts (null: a server that does not index art, the route
 *   then answers 503); registry: the plugin folders (null: no /p/ files at all)
 * @returns {{ handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
 *             stats: () => object, close: () => void }}
 */
export function createSyncManifest({ assetIndex = null, registry = null, app = APP_VERSION, log = noopLog } = {}) {
  /** @type {{ body: Buffer, gzip: Buffer, etag: string, at: string, assets: number, plugins: number } | null} */
  let cached = null;
  const unsubscribe = [];
  const forget = () => { cached = null; };

  if (assetIndex && typeof assetIndex.onChange === 'function') unsubscribe.push(assetIndex.onChange(forget));
  if (registry && typeof registry.onScan === 'function') unsubscribe.push(registry.onScan(forget));

  function build() {
    const assets = {};
    let assetCount = 0;
    if (assetIndex && assetIndex.ready) {
      for (const [rel, hash] of assetIndex.entries()) { assets[rel] = hash; assetCount += 1; }
    }
    const models = assetIndex && assetIndex.ready && typeof assetIndex.modelGroups === 'function' ? assetIndex.modelGroups() : [];
    const plugins = {};
    let pluginCount = 0;
    for (const p of registry ? registry.plugins() : []) {
      if (!p || p.status !== 'loaded') continue;
      const files = pluginFiles(p);
      const rels = Object.keys(files).sort();
      if (!rels.length) continue;
      const sorted = {};
      for (const rel of rels) sorted[rel] = files[rel];
      plugins[p.id] = { version: String(p.manifest?.version ?? ''), files: sorted };
      pluginCount += rels.length;
    }
    const doc = {
      v: SYNC_MANIFEST_VERSION, app, at: new Date().toISOString(),
      counts: { assets: assetCount, plugins: pluginCount, models: models.length }, assets,
      ...(models.length ? { models } : {}), plugins,
    };
    const body = Buffer.from(JSON.stringify(doc));
    return { body, gzip: zlib.gzipSync(body, { level: 6 }), etag: etagOf(body), at: doc.at, assets: assetCount, plugins: pluginCount };
  }

  function current() {
    if (!cached) cached = build();
    return cached;
  }

  /** The cached document, or a fresh one (a test's and /healthz's view). */
  function stats() {
    if (assetIndex && !assetIndex.ready) return { ready: false, files: 0, plugins: 0, etag: null, at: null };
    const doc = current();
    return { ready: true, files: doc.assets, plugins: doc.plugins, etag: doc.etag, at: doc.at };
  }

  function handle(req, res) {
    if (!assetIndex) { sendJson(req, res, 503, { error: 'this server does not index its art', retryAfterMs: 0 }); return; }
    if (!assetIndex.ready) { sendJson(req, res, 503, { error: 'asset index building', retryAfterMs: 2000 }); return; }
    const doc = current();
    const matches = String(req.headers['if-none-match'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    res.setHeader('ETag', doc.etag);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Vary', 'Accept-Encoding');
    if (matches.includes(doc.etag) || matches.includes('*')) {
      res.writeHead(304);
      res.end();
      return;
    }
    const gzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    const body = gzip ? doc.gzip : doc.body;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return {
    handle,
    stats,
    close() { for (const fn of unsubscribe) { try { fn(); } catch { /* ignore */ } } cached = null; },
  };
}
