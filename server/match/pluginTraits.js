// server/match/pluginTraits.js — plugin 特质的运行时诊断（一次对局只报一次）
//
// 插件带来的 garrison（特质）记录，effectKey 可能是两类：
//   1) 本引擎已实现的键（server/sim/content/garrisons/meta.js 的 H.*，如 SERVER_ADD_BOND_METHOD）；
//   2) 只有插件自己的服务端代码才懂的键（COL_*、custom_*、act*_gar_*、以及别的工作室版本才有的 SERVER_*）。
// 第 2 类在本仓库里没有任何实现，抽卡界面照常显示特质文字，但不会有效果——以前是静默的，这里在对局开始时
// 按插件统计一次并写进日志，管理员能直接从 journalctl 看到「哪些特质本版本跑不了」。

/** import-forge 给插件记录加的命名空间：`garrison_x_<包>_<原名>`、`chess_x_<包>_…`、`bond_x_…`。 */
const PLUGIN_RECORD_ID = /^[a-z]+_x_/;

/** garrison ids 与效果键（插件带来的记录用 id 前缀区分，见 constants）。 */
function pluginGarrisons(gd) {
  const out = [];
  const table = gd && gd.garrisons && typeof gd.garrisons === 'object' ? gd.garrisons : {};
  for (const id of Object.keys(table)) {
    if (!PLUGIN_RECORD_ID.test(id)) continue;
    const g = table[id];
    if (g && typeof g.effectKey === 'string' && g.effectKey) out.push([id, g]);
  }
  return out;
}

/**
 * 统计本对局数据里「插件特质有文字、但引擎没有实现」的效果键，按键分组写一行日志。
 * @returns {string[]} 没有实现的键（排序后）
 */
export function unimplementedTraitKeys(registry, gd) {
  const missing = new Map();
  for (const [id, g] of pluginGarrisons(gd)) {
    if (!registry || !registry.has(`garrison:${g.effectKey}`)) {
      const list = missing.get(g.effectKey) ?? [];
      list.push(id);
      missing.set(g.effectKey, list);
    }
  }
  return [...missing.keys()].sort();
}

/** 对局开始时调用一次：日志里给出「N 个插件特质、M 个效果键本版本没有实现」。 */
export function reportUnimplementedTraits({ registry, gd, log } = {}) {
  const keys = unimplementedTraitKeys(registry, gd);
  if (!keys.length) return keys;
  const say = typeof log === 'function' ? log : typeof log?.info === 'function' ? (m) => log.info(m) : null;
  if (say) say(`[sim] ${keys.length} plugin trait effect key(s) have no engine implementation: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}`);
  return keys;
}

export default { unimplementedTraitKeys, reportUnimplementedTraits };
