// 页面脚本运行之前执行（Electron preload）。
//
// 游戏的标题页是「进入游戏」的入口，它用 sessionStorage 里的 `sp.entered` 记录“这个标签页已经过标题页”。
// 浏览器里这没问题（标签页关掉 sessionStorage 就没了），但在桌面客户端里，Chromium 的 profile 是持久的，
// 某些情况下这个标记会被恢复，于是下次启动直接进大厅、跳过标题页。
//
// 客户端的约定：**每次启动都停在标题页**（昵称 sp.name 保留，标题页会自动预填，按一下开始即可）。
// 所以这里在页面脚本之前把这个标记清掉；只清 `sp.entered`，别的存储一概不动。
try {
  window.sessionStorage.removeItem('sp.entered');
} catch {
  /* 存储被禁用时忽略：那种情况下游戏本来也会停在标题页 */
}
