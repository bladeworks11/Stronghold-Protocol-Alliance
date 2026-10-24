// 把图标和版本信息写进 exe 的资源里（资源管理器/任务栏看到的图标、右键属性里的版本）。
//   node build/set-exe-info.cjs <exe> <icon.ico> <版本, 如 0.3.0> <产品名>
// 注意：这会改掉 Electron 官方 exe 的签名（便携版本来就没有我们自己的证书），不影响运行。
const path = require('node:path');
const rcedit = require('rcedit').rcedit || require('rcedit');

const [exe, icon, version, product] = process.argv.slice(2);
if (!exe || !icon || !version || !product) {
  console.error('用法: node build/set-exe-info.cjs <exe> <icon.ico> <version> <product>');
  process.exit(2);
}
const four = /^\d+\.\d+\.\d+$/.test(version) ? `${version}.0` : version;

rcedit(exe, {
  icon,
  'version-string': {
    FileDescription: product,
    ProductName: product,
    InternalName: product.replace(/\s+/g, ''),
    OriginalFilename: path.basename(exe),
    CompanyName: 'Stronghold Protocol (fan project)',
    LegalCopyright: 'GPL-3.0-or-later, game art (c) Hypergryph / Yostar',
  },
  'file-version': four,
  'product-version': four,
})
  .then(() => console.log(`rcedit: ${path.basename(exe)} icon + version ${four} ok`))
  .catch((err) => {
    console.error('rcedit failed:', (err && err.message) || err);
    process.exit(1);
  });
