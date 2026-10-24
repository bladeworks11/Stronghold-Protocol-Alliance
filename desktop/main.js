'use strict';
// 卫戍协议：盟约 · 桌面客户端（Electron 外壳）
//
// 做法：客户端进程里跑一个「本地反向代理」，窗口打开 http://127.0.0.1:<port>/ ——
//   * /assets/…、/fonts/…、/media/…  有本地文件就直接从磁盘回答（打包素材时才有），没有就照常转发；
//   * 其它一切（HTML/JS/data/api/packs…）原样转发给真正的服务器，状态码、头、流都保留；
//   * WebSocket（/ws）用 upgrade 透传，对局照常联机。
// 这样页面和代理同源，游戏的绝对路径、WS、CSP、账号同步全都不用改；
// 也不用去动 Chromium 的网络层（Electron 44 里 http 的 protocol.handle 会直接把页面加载搞挂）。
//
// 服务端地址在 config.json 的 server（环境变量 SP_SERVER 可覆盖）。
// 命令行：--smoke 自检一次后退出（结果写到 smoke-result.json），--content-sync 只做一次素材/插件同步后退出，
//         --devtools 打开开发者工具。
//
// 素材/插件自动更新见 sync.js：开窗后向 /sync/manifest.json 对一次哈希，缺的下载、改过的覆盖、服务器删掉的清掉。

const { app, BrowserWindow, Menu, dialog, session, shell, net } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
const { createContentSync } = require('./sync');

const ROOT = __dirname;
const APP_NAME = 'Stronghold Protocol';

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

const config = readJson(path.join(ROOT, 'config.json'), {});
const SERVER = String(config.server || process.env.SP_SERVER || 'http://112.124.47.122').replace(/\/+$/, '');
const TARGET = (() => { try { return new URL(SERVER); } catch { return null; } })();
// 素材目录有两种放法，取第一个存在的：
//   绿色版 → <resources>\app\assets（ROOT/assets）
//   安装包 → <resources>\assets（electron-builder 的 extraResources）
const RES_DIR = app.isPackaged ? process.resourcesPath : ROOT;
const ASSET_CANDIDATES = [path.join(ROOT, 'assets'), path.join(RES_DIR, 'assets')];
const ASSET_DIR = ASSET_CANDIDATES.find((p) => fs.existsSync(p)) || ASSET_CANDIDATES[0];
const FONT_DIR = path.join(path.dirname(ASSET_DIR), 'fonts');
const HAS_ASSETS = fs.existsSync(ASSET_DIR);
// 打包进安装包的插件（resources\app\plugins）：插件文件按内容哈希命名，本地命中就省掉服务器的流量
const PLUGIN_CANDIDATES = [path.join(ROOT, 'plugins'), path.join(RES_DIR, 'plugins')];
const PLUGIN_DIR = PLUGIN_CANDIDATES.find((p) => fs.existsSync(p)) || PLUGIN_CANDIDATES[0];
const HAS_PLUGINS = fs.existsSync(PLUGIN_DIR);
// 包内清单（打包时生成）：包里每个素材/插件文件的哈希，同步时对得上就不用下载
const BUNDLE_INDEX = [path.join(ROOT, 'bundle-index.json'), path.join(RES_DIR, 'bundle-index.json')].find((p) => fs.existsSync(p)) || null;
const SMOKE = process.argv.includes('--smoke');
const SYNC_ONLY = process.argv.includes('--content-sync');
const DEVTOOLS = process.argv.includes('--devtools');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/opus', '.wav': 'audio/wav', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.atlas': 'text/plain; charset=utf-8', '.skel': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
};
// 与 shared/media.js 的 AUDIO_EXTS 一致
const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav'];

const counts = { local: 0, proxied: 0, ws: 0, failed: 0 };
let proxyPort = 0;
// 固定端口：origin 里的端口决定 localStorage / Cache Storage 的归属，必须每次一样。
const BASE_PORT = Number(config.port) || Number(process.env.SP_PORT) || 47812;
let proxyUrl = '';
let mainWindow = null;
let retryTimer = null;
let contentSync = null;

const inside = (base, abs) => {
  const b = path.resolve(base);
  const p = path.resolve(abs);
  return p === b || p.startsWith(b + path.sep);
};
const isFile = (abs) => { try { return fs.statSync(abs).isFile(); } catch { return false; } };
const segments = (s) => s.split('/').filter((x) => x.length > 0);
const mimeOf = (abs) => MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';

/** '/assets/~<hash>/char/x.png' → { root, hash, rest }（没有哈希段时 hash 为 null）。 */
function splitHashed(pathname) {
  const m = /^\/(assets|fonts|media)\/(?:~([0-9a-f]{6,64})\/)?(.*)$/.exec(pathname);
  return m ? { root: m[1], hash: m[2] || null, rest: m[3] } : null;
}

/** 安装包里自带的素材文件（assets 目录 / 同级的 fonts 目录）。 */
function bundledAssetFile(rel) {
  if (!HAS_ASSETS) return null;
  if (rel.startsWith('assets/')) {
    const abs = path.join(ASSET_DIR, ...segments(rel.slice('assets/'.length)));
    return inside(ASSET_DIR, abs) && isFile(abs) ? abs : null;
  }
  if (rel.startsWith('fonts/')) {
    const abs = path.join(FONT_DIR, ...segments(rel.slice('fonts/'.length)));
    return inside(FONT_DIR, abs) && isFile(abs) ? abs : null;
  }
  return null;
}

/**
 * URL 里的哈希段与手上的文件对不对得上（对得上才用本地文件，否则交给服务器）：
 *   * 文件内容哈希 —— 同步清单里的当前哈希，或安装包里那份文件的哈希；
 *   * Spine 模型哈希 —— 骨架、atlas、贴图共用一个父哈希，取当前文件即可。
 */
function assetFor(rel, urlHash) {
  const cached = contentSync ? contentSync.cachedAsset(rel) : null;
  const bundled = bundledAssetFile(rel);
  if (!urlHash) return cached || bundled;
  if (!contentSync) return bundled; // 还没有同步器：安装包里的文件就是服务器当初打的
  const known = contentSync.assetRecord(rel);
  if (known === urlHash) {
    if (cached) return cached;
    return contentSync.bundleAssetHash(rel) === urlHash ? bundled : null;
  }
  if (contentSync.isAssetModelHash(rel, urlHash)) return cached || bundled;
  if (!cached && contentSync.bundleAssetHash(rel) === urlHash) return bundled;
  return null;
}

/** /media/<名字> → 依次尝试的素材 rel（音频地址常常不带扩展名）。 */
function mediaRels(rest) {
  const parts = segments(rest);
  if (!parts.length) return [];
  const last = parts[parts.length - 1];
  const given = path.extname(last).toLowerCase();
  const hasExt = AUDIO_EXTS.includes(given);
  const stem = hasExt ? last.slice(0, -given.length) : last;
  const order = hasExt ? [given, ...AUDIO_EXTS.filter((e) => e !== given)] : AUDIO_EXTS;
  return order.map((ext) => `assets/audio/${[...parts.slice(0, -1), stem + ext].join('/')}`);
}

/** /assets/…、/fonts/…、/media/… → 本地文件（缓存优先，其次安装包），没有就返回 null 交给服务器 */
function localAsset(pathname) {
  const req = splitHashed(pathname);
  if (!req) return null;
  if (req.root === 'media') {
    for (const rel of mediaRels(req.rest)) {
      const abs = assetFor(rel, req.hash);
      if (abs) return abs;
    }
    return null;
  }
  const rel = req.root === 'assets' ? `assets/${req.rest}` : `fonts/${req.rest}`;
  return assetFor(rel, req.hash);
}

/**
 * /p/<id>/<hash8>/<path> → 插件文件（缓存优先，其次安装包），SHA-256 前 8 位对得上才用。
 * 服务器用内容哈希命名插件文件，所以旧副本永远不会被当成新的；对不上就照常转发给服务器。
 */
function localPluginFile(pathname) {
  const m = /^\/p\/([a-z0-9-]{2,32})\/([0-9a-f]{8})\/(.+)$/.exec(pathname);
  if (!m) return null;
  let rest;
  try { rest = decodeURIComponent(m[3]); } catch { return null; }
  if (contentSync) {
    const known = contentSync.pluginRecord(m[1], rest);
    const cached = contentSync.cachedPlugin(m[1], rest);
    if (known && known.slice(0, 8) === m[2]) {
      if (cached) return cached;
      if (HAS_PLUGINS && contentSync.bundlePluginFileHash(m[1], rest) === known) {
        const abs = path.join(PLUGIN_DIR, m[1], ...segments(rest));
        return inside(PLUGIN_DIR, abs) && isFile(abs) ? abs : null;
      }
      return null;
    }
  }
  if (!HAS_PLUGINS) return null;
  const abs = path.join(PLUGIN_DIR, m[1], ...segments(rest));
  if (!inside(PLUGIN_DIR, abs) || !isFile(abs)) return null;
  try {
    const hex = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    if (hex.slice(0, 8) !== m[2]) return null;
  } catch { return null; }
  return abs;
}

/** 本地文件 → 响应（素材地址带内容哈希，可以长期缓存）。 */
function serveLocal(req, res, abs) {
  let stat;
  try { stat = fs.statSync(abs); } catch { return false; }
  counts.local += 1;
  res.writeHead(200, {
    'content-type': mimeOf(abs),
    'content-length': stat.size,
    'cache-control': 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
  return true;
}

/** 转发给真正的服务器（HTTP，含请求体）。 */
function proxyRequest(req, res) {
  const mod = TARGET.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: TARGET.host };
  delete headers['accept-encoding']; // 让上游自己按需压缩，我们原样透传
  const upstream = mod.request({
    protocol: TARGET.protocol,
    hostname: TARGET.hostname,
    port: TARGET.port || (TARGET.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: req.url,
    headers,
  }, (up) => {
    counts.proxied += 1;
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
    up.on('error', () => res.destroy());
  });
  upstream.on('error', (err) => {
    counts.failed += 1;
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>连接失败</title>
        <body style="background:#0a0e0d;color:#d8e3de;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
        <div style="text-align:center"><p>连不上服务器 <code>${SERVER}</code></p>
        <p style="color:#7f938c">${String(err.message || err)}</p></div></body>`);
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
}

/** WebSocket 透传（/ws 的 upgrade 请求）。 */
function proxyUpgrade(req, socket, head) {
  const mod = TARGET.protocol === 'https:' ? https : http;
  const upstream = mod.request({
    protocol: TARGET.protocol,
    hostname: TARGET.hostname,
    port: TARGET.port || (TARGET.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: TARGET.host },
  });
  upstream.on('upgrade', (up, upSocket, upHead) => {
    counts.ws += 1;
    const lines = [`HTTP/1.1 101 Switching Protocols`];
    for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on('response', (up) => { // 不是 101（比如 503/429），把原响应交回去
    const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage || ''}`];
    for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    up.pipe(socket);
  });
  upstream.on('error', () => { try { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* 关掉 */ } });
  upstream.end();
}

/** 起本地代理（只监听 127.0.0.1）。 */
async function startProxy() {
  const server = http.createServer((req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { /* 保持 / */ }
    if ((req.method === 'GET' || req.method === 'HEAD')) {
      const abs = localAsset(pathname) || localPluginFile(pathname);
      if (abs && serveLocal(req, res, abs)) return;
    }
    proxyRequest(req, res);
  });
  server.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head));
  server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* ignore */ } });

  const tryListen = (port) => new Promise((res, rej) => {
    const onError = (err) => { server.removeListener('listening', onListening); rej(err); };
    const onListening = () => { server.removeListener('error', onError); res(server); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

  // 固定端口：页面 origin 里带端口，端口一变就等于换了站点，
  // 游戏存在 localStorage 里的代号 / 设置 / 已导入素材缓存都会丢。
  for (let p = BASE_PORT; p < BASE_PORT + 12; p += 1) {
    try { return await tryListen(p); } catch (err) { if (err.code !== 'EADDRINUSE') throw err; }
  }
  return tryListen(0);   // 全被占用才退回随机端口（此时存储会换一份）
}

/** 服务器健康检查（3 秒超时）。 */
async function serverHealthy() {
  if (!TARGET) return false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const res = await net.fetch(`${SERVER}/healthz`, { signal: ctl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

function loadWindowState() {
  const s = readJson(path.join(app.getPath('userData'), 'window-state.json'), null);
  const ok = s && Number.isFinite(s.width) && Number.isFinite(s.height);
  return {
    width: ok ? Math.max(960, Math.min(3840, s.width)) : 1440,
    height: ok ? Math.max(600, Math.min(2160, s.height)) : 900,
    x: ok && Number.isFinite(s.x) ? s.x : undefined,
    y: ok && Number.isFinite(s.y) ? s.y : undefined,
    maximized: !!(ok && s.maximized),
  };
}

function saveWindowState(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(path.join(app.getPath('userData'), 'window-state.json'),
      JSON.stringify({ ...b, maximized: win.isMaximized() }, null, 2));
  } catch { /* 记不住就算了 */ }
}

function showOffline(win) {
  win.loadFile(path.join(ROOT, 'offline.html'), { query: { server: SERVER, proxy: proxyUrl } }).catch(() => {});
  clearInterval(retryTimer);
  retryTimer = setInterval(async () => {
    if (await serverHealthy()) {
      clearInterval(retryTimer);
      win.loadURL(proxyUrl).catch(() => {});
    }
  }, 5000);
}

async function boot(win) {
  if (!TARGET) { showOffline(win); return; }
  if (await serverHealthy()) win.loadURL(`${proxyUrl}/`).catch(() => showOffline(win));
  else showOffline(win);
}

function createWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0e0d',
    title: APP_NAME,
    icon: path.join(ROOT, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      // 每次启动都回标题页（清 sessionStorage 里的 sp.entered；昵称不动）
      preload: path.join(ROOT, 'preload.js'),
    },
  });
  mainWindow = win;

  Menu.setApplicationMenu(null);
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});

  if (state.maximized) win.maximize();
  if (!SMOKE) win.once('ready-to-show', () => win.show());

  // 站内链接留在窗口里，站外链接交给系统浏览器
  const isLocal = (url) => url.startsWith(proxyUrl) || url.startsWith(`http://127.0.0.1:${proxyPort}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isLocal(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isLocal(url) || url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || String(url).startsWith('file://')) return;
    console.error(`[client] 加载失败 ${code} ${desc} ${url}`);
    showOffline(win);
  });

  // F11 全屏、Ctrl+R 重载、F12/Ctrl+Shift+I 开发者工具
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    if (key === 'f11') { win.setFullScreen(!win.isFullScreen()); event.preventDefault(); return; }
    if (key === 'f5' || (input.control && key === 'r')) { win.webContents.reload(); event.preventDefault(); return; }
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // 导出统计 JSON 之类：弹保存对话框
  session.defaultSession.on('will-download', (_event, item) => {
    try {
      item.setSaveDialogOptions({ title: '保存文件', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    } catch { /* 记不住就算了 */ }
  });

  win.on('close', () => saveWindowState(win));
  win.webContents.on('did-finish-load', () => { if (SMOKE) runSmokeTest(win); });
  if (DEVTOOLS && !SMOKE) win.webContents.openDevTools({ mode: 'detach' });

  boot(win);
  return win;
}

/** --smoke：等页面跑起来，把结论写进 smoke-result.json 后退出（Windows 的 GUI 进程没有控制台）。 */
function runSmokeTest(win) {
  const resultFile = path.join(path.dirname(process.execPath), 'smoke-result.json');
  if (fs.existsSync(resultFile)) return; // 只测第一次
  const done = (code, payload) => {
    try {
      fs.writeFileSync(resultFile, JSON.stringify({
        at: new Date().toISOString(), server: SERVER, assets: HAS_ASSETS, proxy: proxyUrl, ...payload,
      }, null, 2));
    } catch { /* ignore */ }
    setTimeout(() => app.exit(code), 200);
  };
  process.on('uncaughtException', (err) => done(1, { ok: false, error: String((err && err.stack) || err) }));
  setTimeout(() => done(3, { ok: false, error: '冒烟超时（30 秒）' }), 30000);
  setTimeout(async () => {
    try {

      const info = await win.webContents.executeJavaScript(`(() => ({
        title: document.title,
        url: location.href,
        sp: typeof globalThis.__SP__ !== 'undefined',
        store: !!(globalThis.__SP__ && globalThis.__SP__.store),
        connection: globalThis.__SP__ && globalThis.__SP__.store ? globalThis.__SP__.store.get().connection.status : null,
        draws: document.querySelectorAll('canvas, svg').length,
        // 跨启动持久化探针：第一次写入时间戳，之后每次读回上一次的值
        probe: (() => {
          try {
            const k = 'sp.probe';
            const v = localStorage.getItem(k);
            if (!v) localStorage.setItem(k, new Date().toISOString());
            return v || 'just-set';
          } catch (e) { return 'error'; }
        })(),
        savedName: (() => { try { return localStorage.getItem('sp.name') || ''; } catch (e) { return ''; } })(),
        enteredFlag: (() => { try { return sessionStorage.getItem('sp.entered'); } catch (e) { return 'err'; } })(),
        titleShown: !!document.querySelector('#title-asset-import-hint') || !!document.querySelector('input[placeholder*="代号"]'),
      }))()`);
      const ok = !!(info.sp && info.store && ['online', 'connected', 'connecting'].includes(String(info.connection)));
      done(ok ? 0 : 1, { ok, page: info, requests: { ...counts } });
    } catch (err) {
      done(1, { ok: false, error: String((err && err.message) || err), requests: { ...counts } });
    }
  }, 7000);
}

app.setName(APP_NAME);

// 配置/缓存默认放在 %APPDATA%\<应用名>。绿色版更适合把 userData 放在程序目录里（拷走就带走设置），
// 也避开一部分机器上「未知程序不能写 AppData」的限制（实测有些杀软/策略会拦，导致开窗前就崩）。
// 程序目录只读时（装进 Program Files / asar 里）退回默认的 %APPDATA%。
try {
  const portable = app.isPackaged ? path.join(path.dirname(process.execPath), 'userdata') : path.join(ROOT, 'userdata');
  fs.mkdirSync(portable, { recursive: true });
  fs.accessSync(portable, fs.constants.W_OK);
  app.setPath('userData', portable);
  try { app.setPath('sessionData', portable); } catch { /* 老版本没有这个 path */ }
} catch {
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); } catch { /* 让 Electron 自己报错 */ }
}

// 内容同步器：把服务器上的素材/插件镜像到 <userData>\content，之后启动只补缺、只换改过的（client/sync.js）。
// 装安装包里自带的文件不复制进缓存，靠包内清单（bundle-index.json）的哈希判定，所以升级包后只下真正变过的那部分。
try {
  const cacheDir = path.join(app.getPath('userData'), 'content');
  fs.mkdirSync(cacheDir, { recursive: true });
  contentSync = createContentSync({
    dir: cacheDir,
    server: SERVER,
    app: String((readJson(path.join(ROOT, 'package.json'), {}) || {}).version || ''),
    bundle: {
      assetsDir: HAS_ASSETS ? ASSET_DIR : null,
      pluginsDir: HAS_PLUGINS ? PLUGIN_DIR : null,
      indexFile: BUNDLE_INDEX,
    },
    log: (line) => console.log(line),
  });
} catch (err) {
  console.error('[sync] 初始化失败（继续用安装包自带的素材）', err);
}

/** 后台跑一次内容同步；失败不影响开窗（游戏会自动回落到网络素材）。 */
async function runContentSync({ quiet = false } = {}) {
  if (!contentSync) return null;
  try {
    const r = await contentSync.run();
    if (!quiet && r) console.log(`[sync] ${JSON.stringify(r)}`);
    return r;
  } catch (err) {
    console.error('[sync] 失败', err);
    return null;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('protocol.stronghold.client');
    if (SYNC_ONLY) { // --content-sync：只同步一次然后退出（打包机/运维脚本用）
      const r = await runContentSync();
      console.log(`[sync] ${JSON.stringify(r)}`);
      app.exit(r && r.ok ? 0 : 2);
      return;
    }
    const server = await startProxy();
    proxyPort = server.address().port;
    proxyUrl = `http://127.0.0.1:${proxyPort}`;
    console.log(`[client] server=${SERVER} proxy=${proxyUrl} assets=${HAS_ASSETS ? 'bundled' : 'network'} sync=${contentSync ? 'on' : 'off'}`);
    createWindow();
    // 开窗之后才补素材/插件：不挡首屏，换过的文件只下改动的那部分
    setTimeout(() => { runContentSync({ quiet: true }); }, 1500);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch((err) => {
    console.error('[client] 启动失败', err);
    if (SMOKE) {
      try {
        fs.writeFileSync(path.join(ROOT, 'smoke-result.json'), JSON.stringify({ ok: false, error: String((err && err.stack) || err) }, null, 2));
      } catch { /* ignore */ }
      app.exit(1);
      return;
    }
    dialog.showErrorBox('启动失败', String((err && err.stack) || err));
    app.exit(1);
  });

  app.on('window-all-closed', () => app.quit());
}
