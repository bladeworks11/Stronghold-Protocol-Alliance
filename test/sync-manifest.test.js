// GET /sync/manifest.json (server/http/syncManifest.js): what the desktop client keeps a copy of — every hashed art
// file and every file a loaded plugin serves, with the hash of its bytes, gzipped, behind a strong ETag, and answers a
// client that has the same set with a 304; 503 while the asset index is still building (never a short list, which the
// client would read as "those files were deleted").
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { createAssetIndex } from '../server/http/assetIndex.js';
import { createSyncManifest, SYNC_MANIFEST_VERSION } from '../server/http/syncManifest.js';

const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-sync-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

function get(port, p, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers, method, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** The route on a real socket (it is a plain request handler). */
async function serve(sync) {
  const server = http.createServer((req, res) => sync.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** A registry stub: one loaded cosmetic plugin, one skipped, one plugin without served files. */
function fakeRegistry(files) {
  let onScan = null;
  const state = {
    files: files ?? { 'chars/a.png': Buffer.from('a'), 'audio/x.mp3': Buffer.from('mp3') },
    version: '1.0.0',
  };
  return {
    state,
    registry: {
      plugins: () => [
        {
          id: 'skin-pack', status: 'loaded', manifest: { version: state.version }, class: 'cosmetic',
          visual: { served: new Map(Object.entries(state.files).map(([rel, bytes]) => [rel, { rel, sha256: sha256(bytes), bytes: bytes.length }])) },
        },
        { id: 'broken', status: 'skipped', manifest: { version: '0.0.1' }, visual: { served: new Map([['x.png', { sha256: 'b'.repeat(64) }]]) } },
        { id: 'empty', status: 'loaded', manifest: { version: '2.0.0' }, visual: { served: new Map() } },
      ],
      onScan: (fn) => { onScan = fn; return () => { onScan = null; }; },
    },
    rescan: () => onScan && onScan(),
  };
}

describe('GET /sync/manifest.json', () => {
  test('names every hashed art file and the files of the loaded plugins', async () => {
    const img = randomBytes(64);
    const dir = tree({ 'public/assets/char/a.png': img, 'public/fonts/f.woff2': 'font', 'public/js/app.js': 'no' });
    const idx = createAssetIndex({ publicDir: path.join(dir, 'public'), delayMs: 0 });
    idx.start();
    await idx.whenReady();
    const fake = fakeRegistry();
    const sync = createSyncManifest({ assetIndex: idx, registry: fake.registry, app: '9.9.9' });
    const srv = await serve(sync);
    try {
      const res = await get(srv.port, '/sync/manifest.json');
      assert.equal(res.status, 200);
      const doc = JSON.parse(res.body.toString());
      assert.equal(doc.v, SYNC_MANIFEST_VERSION);
      assert.equal(doc.app, '9.9.9');
      assert.deepEqual(Object.keys(doc.assets).sort(), ['assets/char/a.png', 'fonts/f.woff2']);
      assert.equal(doc.assets['assets/char/a.png'], sha16(img));
      assert.deepEqual(doc.counts, { assets: 2, plugins: 2, models: 0 });
      assert.deepEqual(Object.keys(doc.plugins), ['skin-pack'], 'a skipped plugin and one without served files are left out');
      assert.equal(doc.plugins['skin-pack'].version, '1.0.0');
      assert.equal(doc.plugins['skin-pack'].files['chars/a.png'], sha256(Buffer.from('a')));
      assert.equal(doc.plugins['skin-pack'].files['audio/x.mp3'], sha256(Buffer.from('mp3')));
      assert.ok(!('js/app.js' in doc.assets), 'only the asset folders are indexed');
      assert.match(res.headers.etag, /^"[0-9a-f]{32}"$/);
      assert.match(res.headers.etag, /^"[0-9a-f]{32}"$/);
      assert.equal(res.headers['cache-control'], 'no-cache');
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      await srv.close();
      sync.close();
      idx.close();
    }
  });

  test('gzips when asked, and answers a client that already has the same set with a 304', async () => {
    const dir = tree({ 'public/assets/a.png': 'a'.repeat(500) });
    const idx = createAssetIndex({ publicDir: path.join(dir, 'public'), delayMs: 0 });
    idx.start();
    await idx.whenReady();
    const sync = createSyncManifest({ assetIndex: idx, registry: fakeRegistry().registry });
    const srv = await serve(sync);
    try {
      const plain = await get(srv.port, '/sync/manifest.json');
      const gz = await get(srv.port, '/sync/manifest.json', { 'accept-encoding': 'gzip' });
      assert.equal(gz.headers['content-encoding'], 'gzip');
      assert.equal(zlib.gunzipSync(gz.body).toString(), plain.body.toString());
      assert.equal(gz.headers.etag, plain.headers.etag, 'one document, one ETag');
      const again = await get(srv.port, '/sync/manifest.json', { 'if-none-match': plain.headers.etag });
      assert.equal(again.status, 304);
      assert.equal(again.body.length, 0);
      assert.equal(again.headers.etag, plain.headers.etag);
      const miss = await get(srv.port, '/sync/manifest.json', { 'if-none-match': '"00000000000000000000000000000000"' });
      assert.equal(miss.status, 200);
      const head = await get(srv.port, '/sync/manifest.json', {}, 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      assert.equal(Number(head.headers['content-length']), plain.body.length);
    } finally {
      await srv.close();
      sync.close();
      idx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rebuilds after the asset index or the plugin folders change', async () => {
    const dir = tree({ 'public/assets/a.png': 'one' });
    const idx = createAssetIndex({ publicDir: path.join(dir, 'public'), delayMs: 0 });
    idx.start();
    await idx.whenReady();
    const fake = fakeRegistry();
    const sync = createSyncManifest({ assetIndex: idx, registry: fake.registry });
    const srv = await serve(sync);
    try {
      const first = await get(srv.port, '/sync/manifest.json');
      const firstDoc = JSON.parse(first.body.toString());
      // a file added to the art, and a file added to the plugin
      fs.writeFileSync(path.join(dir, 'public/assets/b.png'), 'two');
      await idx.refresh();
      fake.state.files['chars/new.png'] = Buffer.from('new');
      fake.rescan();
      const second = await get(srv.port, '/sync/manifest.json');
      assert.equal(second.status, 200);
      const doc = JSON.parse(second.body.toString());
      assert.notEqual(second.headers.etag, first.headers.etag);
      assert.deepEqual(Object.keys(doc.assets).sort(), ['assets/a.png', 'assets/b.png']);
      assert.equal(Object.keys(firstDoc.assets).length, 1);
      assert.ok('chars/new.png' in doc.plugins['skin-pack'].files);
    } finally {
      await srv.close();
      sync.close();
      idx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('answers 503 while the asset index is still building, and when the server has no index at all', async () => {
    const dir = tree({ 'public/assets/a.png': 'a' });
    const idx = createAssetIndex({ publicDir: path.join(dir, 'public'), delayMs: 60_000 });
    idx.start(); // not ready yet
    const sync = createSyncManifest({ assetIndex: idx, registry: fakeRegistry().registry });
    const srv = await serve(sync);
    try {
      const building = await get(srv.port, '/sync/manifest.json');
      assert.equal(building.status, 503);
      assert.match(JSON.parse(building.body.toString()).error, /building/);
      await idx.refresh();
      const ready = await get(srv.port, '/sync/manifest.json');
      assert.equal(ready.status, 200);
    } finally {
      await srv.close();
      sync.close();
      idx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const none = createSyncManifest({ assetIndex: null });
    const srv2 = await serve(none);
    try {
      const res = await get(srv2.port, '/sync/manifest.json');
      assert.equal(res.status, 503);
    } finally {
      await srv2.close();
      none.close();
    }
  });
});
