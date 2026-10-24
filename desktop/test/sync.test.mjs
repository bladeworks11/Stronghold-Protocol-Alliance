// client/sync.js 的回归测试：用本地 HTTP 服务假装游戏服务器，验证「只补缺、只换改过的、删掉服务器上没了的」。
//   node --test client/test/
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createContentSync } = require('../sync.js');

const sha256 = (buf) => require('node:crypto').createHash('sha256').update(buf).digest('hex');
const h16 = (buf) => sha256(buf).slice(0, 16);

/** 一台假服务器：/sync/manifest.json 按当前 files 生成，/assets/… 与 /p/… 按内容返回。 */
function fakeServer() {
  const state = {
    assets: { 'assets/char/a.png': Buffer.from('png-a'), 'fonts/x.woff2': Buffer.from('font-x') },
    models: [],
    plugins: { 'test-pack': { version: '1.0.0', files: { 'files/p.png': Buffer.from('plugin-p') } } },
    hits: [],
    etag: '',
    fail: false,
  };
  const server = createServer((req, res) => {
    state.hits.push(req.url);
    if (state.fail) { res.writeHead(500); res.end('nope'); return; }
    if (req.url === '/sync/manifest.json') {
      const doc = {
        v: 1,
        app: '0.3.3',
        assets: Object.fromEntries(Object.entries(state.assets).map(([rel, buf]) => [rel, h16(buf)])),
        models: state.models,
        plugins: Object.fromEntries(Object.entries(state.plugins).map(([id, p]) => [id, {
          version: p.version,
          files: Object.fromEntries(Object.entries(p.files).map(([rel, buf]) => [rel, sha256(buf)])),
        }])),
      };
      const body = Buffer.from(JSON.stringify(doc));
      state.etag = `"${sha256(body).slice(0, 32)}"`;
      if (req.headers['if-none-match'] === state.etag) { res.writeHead(304, { etag: state.etag }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', etag: state.etag });
      res.end(body);
      return;
    }
    const asset = /^\/assets\/~([0-9a-f]+)\/(.+)$/.exec(req.url) || /^\/fonts\/~([0-9a-f]+)\/(.+)$/.exec(req.url);
    if (asset) {
      const rel = (req.url.startsWith('/fonts') ? 'fonts/' : 'assets/') + decodeURIComponent(asset[2]);
      const buf = state.assets[rel];
      if (!buf || h16(buf) !== asset[1]) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(buf);
      return;
    }
    const plugin = /^\/p\/([a-z0-9-]+)\/([0-9a-f]{8})\/(.+)$/.exec(req.url);
    if (plugin) {
      const pack = state.plugins[plugin[1]];
      const buf = pack && pack.files[decodeURIComponent(plugin[3])];
      if (!buf || sha256(buf).slice(0, 8) !== plugin[2]) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(buf);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { state, server };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'sp-sync-'));

test('首次同步：下载缺的素材与插件，写好状态', async (t) => {
  const { state, server } = fakeServer();
  const base = await listen(server);
  t.after(() => server.close());
  const dir = await tmpDir();
  const sync = createContentSync({ dir, server: base, app: '0.3.3' });
  const r = await sync.run();
  assert.equal(r.ok, true);
  assert.equal(r.fetched, 3);
  assert.equal(r.failed, 0);
  assert.equal(await fs.readFile(sync.cachedAsset('assets/char/a.png'), 'utf8'), 'png-a');
  assert.equal(await fs.readFile(sync.cachedPlugin('test-pack', 'files/p.png'), 'utf8'), 'plugin-p');
  assert.equal(sync.assetRecord('assets/char/a.png'), h16(Buffer.from('png-a')));
  assert.equal(sync.pluginRecord('test-pack', 'files/p.png'), sha256(Buffer.from('plugin-p')));
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'sync.json'), 'utf8'));
  assert.equal(saved.v, 1);
  assert.equal(saved.etag, state.etag);
  assert.deepEqual(Object.keys(saved.assets).sort(), ['assets/char/a.png', 'fonts/x.woff2']);
  assert.equal(saved.plugins['test-pack'].version, '1.0.0');
});

test('第二次同步：304，一个文件都不下', async (t) => {
  const { state, server } = fakeServer();
  const base = await listen(server);
  t.after(() => server.close());
  const dir = await tmpDir();
  await createContentSync({ dir, server: base, app: '0.3.3' }).run();
  state.hits.length = 0;
  const r = await createContentSync({ dir, server: base, app: '0.3.3' }).run();
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.deepEqual(state.hits, ['/sync/manifest.json']);
});

test('改过的素材只重下这一份，服务器删掉的从缓存清掉', async (t) => {
  const { state, server } = fakeServer();
  const base = await listen(server);
  t.after(() => server.close());
  const dir = await tmpDir();
  await createContentSync({ dir, server: base, app: '0.3.3' }).run();
  state.assets['assets/char/a.png'] = Buffer.from('png-a-v2');
  delete state.assets['fonts/x.woff2'];
  state.hits.length = 0;
  const r = await createContentSync({ dir, server: base, app: '0.3.3' }).run();
  assert.equal(r.ok, true);
  assert.equal(r.fetched, 1);
  assert.equal(r.removed, 1);
  assert.equal(await fs.readFile(path.join(dir, 'assets/char/a.png'), 'utf8'), 'png-a-v2');
  await assert.rejects(fs.stat(path.join(dir, 'fonts/x.woff2')));
  assert.deepEqual(state.hits.sort(), ['/assets/~' + h16(Buffer.from('png-a-v2')) + '/char/a.png', '/sync/manifest.json'].sort());
});

test('服务器没起来：记 offline，不写坏状态', async () => {
  const dir = await tmpDir();
  const sync = createContentSync({ dir, server: 'http://127.0.0.1:1', app: '0.3.3' });
  const r = await sync.run();
  assert.equal(r.ok, false);
  assert.equal(r.offline, true);
  await assert.rejects(fs.stat(path.join(dir, 'sync.json')));
});

test('安装包里已有同样字节的文件：不下载，记成已具备', async (t) => {
  const { state, server } = fakeServer();
  const base = await listen(server);
  t.after(() => server.close());
  const dir = await tmpDir();
  const bundleAssets = path.join(dir, '..', `${path.basename(dir)}-bundle`);
  await fs.mkdir(path.join(bundleAssets, 'char'), { recursive: true });
  await fs.writeFile(path.join(bundleAssets, 'char', 'a.png'), 'png-a');
  const sync = createContentSync({
    dir, server: base, app: '0.3.3',
    bundle: { assetsDir: bundleAssets, pluginsDir: null, indexFile: null },
  });
  state.hits.length = 0;
  const r = await sync.run();
  assert.equal(r.ok, true);
  assert.equal(r.fetched, 2); // 字体和插件还是要下，包里的 a.png 不用
  assert.equal(state.hits.some((u) => u.includes('/char/a.png')), false);
  assert.equal(sync.assetRecord('assets/char/a.png'), h16(Buffer.from('png-a')));
  assert.equal(sync.cachedAsset('assets/char/a.png'), null); // 包里的文件不进缓存
});

test('Spine 模型哈希：认得成员文件，不认识的哈希不认', async (t) => {
  const { state, server } = fakeServer();
  const base = await listen(server);
  t.after(() => server.close());
  const dir = await tmpDir();
  state.models = [['modelhash0000000', 'assets/char/m.skel', 'assets/char/m.atlas']];
  state.assets['assets/char/m.skel'] = Buffer.from('skel');
  state.assets['assets/char/m.atlas'] = Buffer.from('atlas');
  const sync = createContentSync({ dir, server: base, app: '0.3.3' });
  await sync.run();
  assert.equal(sync.isAssetModelHash('assets/char/m.skel', 'modelhash0000000'), true);
  assert.equal(sync.isAssetModelHash('assets/char/m.atlas', 'modelhash0000000'), true);
  assert.equal(sync.isAssetModelHash('assets/char/a.png', 'modelhash0000000'), false);
  assert.equal(sync.isAssetModelHash('assets/char/m.skel', 'otherhash00000000'), false);
});
