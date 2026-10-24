// 生成「包内清单」（bundle-index.json）：客户端把这个文件放到安装包里，启动时的内容同步据此判断
// 「服务器上的这个文件我包里已经有一份一样字节的」→ 不用下载。
//
//   node build/make-bundle-index.mjs --assets <dir> --fonts <dir> --plugins <dir> --out <file> [--app 0.3.1]
//
// 字段与服务端的 /sync/manifest.json 对齐：
//   assets  → { 'assets/<相对路径>': 内容 SHA-256 前 16 位 }，fonts 同理用 'fonts/' 前缀
//   plugins → { '<插件 id>': { files: { '<相对插件的路径>': 完整 SHA-256 } } }
// 没有包内清单的旧安装包仍能同步（客户端会对包内文件懒校验一次），只是第一次多读一遍盘。

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set(['_template', '_replaced', '.git']);

function parseArgs(argv) {
  const out = { assets: '', fonts: '', plugins: '', out: '', app: '', jobs: 8 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    if (key in out) out[key] = key === 'jobs' ? Number(value) || 8 : value;
  }
  return out;
}

/** 递归列出目录里的文件（返回绝对路径，目录不存在时返回空）。 */
async function listFiles(root) {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  };
  await walk(root);
  return out;
}

function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(abs)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** 并发跑一组异步任务（保持结果顺序）。 */
async function pool(items, jobs, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.out) {
  console.error('用法: node make-bundle-index.mjs --assets <dir> [--fonts <dir>] [--plugins <dir>] --out <file> [--app 0.3.1]');
  process.exit(2);
}

const started = Date.now();
const assets = {};
const plugins = {};
let assetFiles = [];

for (const [root, prefix] of [[args.assets, 'assets/'], [args.fonts, 'fonts/']]) {
  if (!root) continue;
  const files = await listFiles(root);
  assetFiles = assetFiles.concat(files.map((abs) => ({ abs, rel: prefix + path.relative(root, abs).split(path.sep).join('/') })));
}

await pool(assetFiles, args.jobs, async ({ abs, rel }) => {
  try {
    const hex = await sha256File(abs);
    assets[rel] = hex.slice(0, 16);
  } catch (err) {
    console.warn(`跳过 ${rel}: ${err.message}`);
  }
});

if (args.plugins) {
  let ids = [];
  try { ids = (await fs.readdir(args.plugins, { withFileTypes: true })).filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name)).map((d) => d.name); } catch { ids = []; }
  ids.sort();
  for (const id of ids) {
    const dir = path.join(args.plugins, id);
    const files = await listFiles(dir);
    if (!files.length) continue;
    const rels = files.map((abs) => ({ abs, rel: path.relative(dir, abs).split(path.sep).join('/') }));
    const hashes = await pool(rels, args.jobs, async ({ abs, rel }) => {
      try { return [rel, await sha256File(abs)]; } catch (err) { console.warn(`跳过 ${id}/${rel}: ${err.message}`); return null; }
    });
    const table = {};
    for (const pair of hashes) if (pair) table[pair[0]] = pair[1];
    if (Object.keys(table).length) plugins[id] = { files: table };
  }
}

const doc = {
  v: 1,
  app: args.app || '',
  at: new Date().toISOString(),
  counts: { assets: Object.keys(assets).length, plugins: Object.keys(plugins).length },
  assets,
  plugins,
};
await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
await fs.writeFile(args.out, JSON.stringify(doc), 'utf8');
const mb = (JSON.stringify(doc).length / 1048576).toFixed(1);
console.log(`包内清单：${doc.counts.assets} 个素材文件、${doc.counts.plugins} 个插件 → ${args.out}（${mb} MB，${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
