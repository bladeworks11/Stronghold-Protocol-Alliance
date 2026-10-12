// server/sim/content/kits/ops/op-ela.js — 艾拉 (char_4123_ela) 自选 operator kit: 6★ 陷阱师 (特种), a 联动 operator of the
// tier-5 and tier-6 自选 slots; every skill, both talents, the trait and its module at every form.
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// 本机自用：艾拉是上游因版权排除的 7 名联动干员之一（tools/build-data.mjs DIY_INCLUDED_COLLABS、NOTICE.md §2）。
// 仅供本机个人非商业使用；不要公开分发，也不要向上游提 PR。
//
// Forms (data/backups.json units.char_4123_ela): normal = E2 Lv1 rank 4 no module; elite = E2 Lv60 rank 7, TRP-D at
// stage 1 (tier 5) / 3 (tier 6). Sources: the official skill / talent texts and blackboards as built into backups.json
// (every number is read from the blackboard), plus the token record `token_10033_ela_grzmot` (`tokens[].bySkill`).
// - Trait (陷阱师) "可以使用陷阱来协助作战，但陷阱无法放置于敌人已在的格子中": the profession's trap rules; her 雷鸣地雷 are
//   hand pieces the player places (data `placeable`), handed out by the match (server/match/player/diy.js).
// - T1 雷鸣地雷 "可以使用N个雷鸣地雷（最多拥有M个），经过周围的第一个敌人会触发其效果，撤退时以自身为中心触发一次雷鸣地雷效果"
//   (PRTS 备注 "陷阱部署上限与最多拥有数量相同；雷鸣地雷触发半径1.35，效果影响半径1.7；以任何方式离场均可触发本天赋"):
//   the pieces' deploy limit is the token variant's `stats.deployLimit` (4), and each piece triggers `sk tok_ela_*` —
//   the variant's skill for the pick's skill index (`bySkill[i].skill`: sktok_ela_1 停顿 + 命中率, 2 晕眩, 3 停顿 + 脆弱).
//   The trigger is the shared contact rule: the first selectable ground enemy whose body reaches the piece's tile,
//   oldest first (the 多萝西 RESONATOR pattern, content/tokens.js champagne). 撤退时: leaving the field by ANY means
//   (retreat, knock-out, sale) sets one more blast off centred on HER — implemented in this kit's trait.
// - T2 “正中靶心” "攻击有30%几率造成相当于攻击力150%的物理伤害，对受到雷鸣地雷效果影响的目标必定触发" (`atk_scale` / `prob`;
//   TRP-Δ stage 2+ raises both to 40 %/160 % and stage 3 to 50 %/170 %, read from the module's talent change): every
//   normal attack rolls `prob` and deals `atk_scale` × ATK instead of 1 ×; a target carrying a 雷鸣地雷 effect (the
//   marker buff this kit puts on every victim of a blast) always takes it. A final multiplier on that attack (`dmgMul`).
// - TRP-Δ “社会期望背包” "自身可以额外部署在近战位，陷阱可以额外部署在远程位" (PRTS: "携带进入战斗后，将自身部署类型改为
//   全部位"): a placement rule the match and prep own, not the kit; its ATK / DEF are in the stats and its talent change
//   is read above.
// - S1 眩目阻滞 (AUTO): 被动 — a blast also 停顿 `sluggish` s and cuts the physical / arts hit rate of every enemy around
//   it by |`damage_hitrate_physical` / `damage_hitrate_magical`| (PRTS 命中率: one roll per attack when it starts, the
//   whole attack misses). 主动 — one more mine at once (the official "立即获得一个陷阱" is ONE trap per cast, while the
//   token's own `count` is the 最多拥有数量, not a grant).
// - S2 震荡坚守 (MANUAL, 20 s): 被动 — a blast 晕眩 `stun` s instead. 主动 — 防御力 +`def` × 100 % (the text says +250 %,
//   the blackboard carries 2.5), her attack range narrows to the skill's own grid, and each attack splashes
//   `attack@projectile_range` tiles around its target (PRTS 备注 "普通攻击溅射半径1.1") and ignores `def_penetrate_fixed`
//   DEF. 技能结束时获得一个陷阱.
// - S3 “博萨克风暴” (MANUAL, ammo `attack@trigger_time` 40): 被动 — a blast 停顿 `sluggish` s and gives 脆弱
//   (`damage_scale` − 1, e.g. 25 % at rank 7) for `weak[limit]` s. 主动 — ATK +`atk`, attack interval −|`base_attack_time`|,
//   and her attacks prefer an enemy carrying the 雷鸣地雷 marker. 技能结束时获得 `cnt` 陷阱.
//
// The 命中率 机制 follows 阿斯卡纶's kit (ops/op-ascln.js `installMiss`): one roll per attack, keyed by its `attackId`
// so every hit of one attack shares the result, taken on the `hit` hook. It is a private copy here because that one is
// local to op-ascln.js.

import { num, talentBb, moduleBb, traitBb, moduleOn, skillRec, up } from '../shared/tier1.js';
import { canTargetEnemy } from '../../../targeting.js';
import { bodyOnTile } from '../../../body.js';
import { COLS } from '../../../constants.js';

const S1 = 'skchr_ela_1';
const S2 = 'skchr_ela_2';
const S3 = 'skchr_ela_3';
/** The 雷鸣地雷 token (data/backups.json tokens; its variants are keyed by the owner's form). */
const GRZMOT = 'token_10033_ela_grzmot';
/** A ground enemy that may set a trap off (never an unrevealed 隐匿 one — the shared contact-trap rule). */
const GROUND = Object.freeze({ canHitFly: false, groundOnly: true });
/** 命中率 cut: the roll's priority (before the damage is computed — the 阿斯卡纶 kit convention). */
const MISS_PRIORITY = 400;
/** The marker a blast leaves on its victims: "受到雷鸣地雷效果影响" (T2's guaranteed trigger). */
const MARK = 'ela:grzmot';
/** A blast's 溅射 radius around the piece [PRTS 备注 "雷鸣地雷…效果影响半径1.7"]. */
const BLAST_RADIUS = 1.7;

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};
const count = (v, d = 1) => Math.max(1, Math.floor(num(v, d)));

export default {
  char_4123_ela: (bb, chess) => {
    const t0 = talentBb(chess, 0);          // 雷鸣地雷: cnt (the deploy limit)
    const t1 = talentBb(chess, 1);          // “正中靶心”: atk_scale, prob (TRP-D stage 2+ raises them)
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
    const mod = moduleOn(chess) ? (chess.modules ?? []).find((m) => m && m.uniEquipId === chess.module.id) ?? null : null;
    const t1mod = (mod?.talentChanges ?? []).find((t) => t && t.talentIndex === 1)?.bb ?? {};
    const critScale = num(t1mod.atk_scale, num(t1.atk_scale, 1.6));
    const critProb = num(t1mod.prob, num(t1.prob, 0.3));
    /** The skill the piece's variant carries for the pick's skill index (`bySkill[i].skill`), else its default. */
    const tokenSkill = (def) => def?.skill ?? null;

    return {
      skills: {
        // S1 眩目阻滞 (AUTO): 主动 — one more mine.
        [S1]: { kind: 'instant', trigger: 'SP_FULL', onStart({ battle, unit }) { grant(battle, unit, 1); } },
        // S2 震荡坚守 (MANUAL, 20 s): DEF +def × 100 %, the skill's narrowed range, splash + fixed DEF ignore.
        [S2]: {
          kind: 'duration', duration: Math.max(0.01, num(skillRec(chess, S2)?.duration, 20)),
          mods: { defPct: num(b2.def) },
          targeting: { rangeGrid: skillRec(chess, S2)?.rangeGrid ?? null },
          attack: {
            splashRadius: num(b2['attack@projectile_range'], 1.1),
            defIgnoreFlat: num(b2.def_penetrate_fixed),
          },
          onEnd({ battle, unit }) { grant(battle, unit, 1); },
        },
        // S3 “博萨克风暴” (MANUAL, ammo): ATK +atk, a faster interval, her attacks prefer a marked enemy.
        [S3]: {
          kind: 'ammo',
          ammo: count(b3['attack@trigger_time'], 40),
          mods: { atkPct: num(b3.atk), batPct: num(b3.base_attack_time) / (num(chess?.stats?.bat, 1) || 1) },
          targeting: { priority: 'marked' },
          onEnd({ battle, unit }) { grant(battle, unit, count(b3.cnt, 2)); },
        },
      },
      talents: [
        { install(battle, unit) { // 雷鸣地雷: the pieces' kit and the 撤退时 blast centred on her
          unit.mem.ela = { mines: new Map() };
          installPieceKits(battle, unit);
          // the same pool of pieces the match handed out: a new deployment re-registers any piece it added since
          battle.on('deploy', (c) => {
            if (c.unit !== unit || c.move) return;
            installPieceKits(battle, unit);
          }, { owner: unit });
          // 撤退时以自身为中心触发一次雷鸣地雷效果 — on leaving the field (retreat / knock-out / sale), one blast at her
          battle.on('death', (c) => {
            if (c.unit !== unit) return;
            detonateAtOwner(battle, unit);
          }, { owner: unit, priority: -5 });
        } },
        { install(battle, unit) { // “正中靶心”: the roll its trait's dmgMul reads (×atk_scale, always vs a marked target)
          const scale = critScale, prob = critProb;
          if (!(scale > 1)) return;
          unit.mem.elaCrit = { scale, prob };
        } },
      ],
      trait: {
        // “正中靶心” "攻击有prob几率造成相当于攻击力atk_scale的物理伤害，对受到雷鸣地雷效果影响的目标必定触发":
        // a final multiplier on her own attack (the same key serves the trait's other lines, none of which she has).
        dmgMul: (battle, unit, target) => {
          const c = unit.mem?.elaCrit;
          if (!c || !(c.scale > 1)) return 1;
          if (target && typeof target.findBuff === 'function' && target.findBuff(MARK)) return c.scale;
          return battle.rng() < c.prob ? c.scale : 1;
        },
      },
      install(battle, unit) {
        installHitrate(battle, unit);
      },
    };

    /** Hand one mine's worth of stock back to the player (S1 / S2 / S3's "获得一个陷阱"). */
    function grant(battle, unit, n) {
      if (!(n > 0)) return;
      unit.mem.elaGrant = (unit.mem.elaGrant ?? 0) + n;
      // the stock itself is the match's (PlayerState.diyStock / the hand piece); a kit cannot push a hand piece, so the
      // piece's own deploy limit is raised by what the skill grants [ASSUMED: the sim side of "获得一个陷阱"].
      const limit = num(unit.trait?.elaLimit, num(t0.cnt, 4)) + unit.mem.elaGrant;
      unit.trait.elaLimit = limit;
      battle.fx('buff', { x: unit.x, y: unit.y, id: unit.id, kind: 'ela:mine' });
    }

    /** Give every one of her pieces its trigger kit (the 多萝西 RESONATOR pattern: `battle._setupUnit(t, kit)`). */
    function installPieceKits(battle, unit) {
      for (const t of battle.allyUnits) {
        if (!t || t.defId !== GRZMOT || t.ownerUnit !== unit) continue;
        if (t.mem?.elaKit) continue;
        t.mem.elaKit = true;
        battle._setupUnit(t, pieceKit(unit));
      }
    }

    /** 雷鸣地雷's kit: the contact trigger and the blast (`unit` = 艾拉, `t` = the piece). */
    function pieceKit(unit) {
      return {
        skill: null,
        trait: { noAttack: true },
        install(battle, t) {
          battle.on('tick', () => {
            if (!t.alive || !t.deployed || t.mem.elaFired) return;
            let hit = null;
            for (const e of battle.enemies) {
              if (!canTargetEnemy(t, e, GROUND)) continue;
              // "经过周围" — the pieces are 接触 traps: the enemy's centre has to reach the tile's centre (the 多萝西 /
              // 琳琅诗怀雅 rule in content/tokens.js), so a body spanning several tiles is caught on any of them.
              const on = e.hitArea ? bodyOnTile(e, t.tileR, t.tileC)
                : Math.abs(e.x - t.tileC) <= 0.5 && Math.abs(e.y - t.tileR) <= 0.5;
              if (on && (!hit || e.spawnSeq < hit.spawnSeq)) hit = e;
            }
            if (!hit) return;
            t.mem.elaFired = true;
            blast(battle, unit, t.x, t.y, t);
            battle.retreat(t, { reason: 'expired', permanent: true });
          }, { owner: t });
        },
      };
    }

    /** The effect of the piece's own skill (`sk tok_ela_*`) on the enemies around (x, y) + the T2 marker. */
    function blast(battle, unit, x, y, piece) {
      const sk = tokenSkill(piece?.def?.skill ? piece.def : piece?.def?.raw ?? piece?.def);
      const sb = sk?.bb ?? {};
      const stun = num(sb.stun);
      const slug = num(sb.sluggish);
      const weakTime = num(sb['weak[limit]']);
      const weak = weakTime > 0 ? num(sb.damage_scale, 1) - 1 : 0;
      // the whole effect's lifetime: the marker T2 reads lasts exactly as long as what the blast applied.
      const life = Math.max(stun, slug, weakTime, num(sb.duration), 0.5);
      battle.fx('aoe', { x, y, radius: BLAST_RADIUS, id: piece?.id ?? unit.id, skill: 'ela:grzmot' });
      for (const e of battle.foesInRadius(x, y, BLAST_RADIUS, true)) {
        if (stun > 0) battle.applyStatus(e, 'stun', { duration: stun, source: unit });
        if (slug > 0) battle.applyStatus(e, 'sluggish', { duration: slug, source: unit });
        if (weak > 0) battle.applyStatus(e, 'fragile', { duration: weakTime, value: weak, source: unit });
        // the marker T2's "对受到雷鸣地雷效果影响的目标" reads — for as long as the blast's own effect runs
        battle.addBuff(e, { key: MARK, duration: life, source: unit, refresh: 'extend' });
        // the 命中率 cut (S1's 被动): a stat on the enemy, read by installHitrate on her side
        unit.mem.elaMiss = unit.mem.elaMiss ?? new Map();
        const phys = Math.abs(num(sb.damage_hitrate_physical)), arts = Math.abs(num(sb.damage_hitrate_magical));
        if (phys > 0 || arts > 0) unit.mem.elaMiss.set(e, { phys, arts, until: battle.time + life });
      }
    }

    /** 撤退时: one blast with the CURRENT skill's effect, centred on her own position. */
    function detonateAtOwner(battle, unit) {
      if (!unit.mem?.ela) return;
      const ix = Math.round(unit.x ?? unit.tileC), iy = Math.round(unit.y ?? unit.tileR);
      const sk = unit.def?.skill ?? null;
      const sb = sk?.bb ?? {};
      battle.fx('aoe', { x: ix, y: iy, radius: BLAST_RADIUS, id: unit.id, skill: 'ela:grzmotSelf' });
      for (const e of battle.foesInRadius(ix, iy, BLAST_RADIUS, true)) {
        const stun = num(sb.stun), slug = num(sb.sluggish);
        if (stun > 0) battle.applyStatus(e, 'stun', { duration: stun, source: unit });
        if (slug > 0) battle.applyStatus(e, 'sluggish', { duration: slug, source: unit });
        const weak = num(sb['weak[limit]']) ? num(sb.damage_scale, 1) - 1 : 0;
        if (weak > 0) battle.applyStatus(e, 'fragile', { duration: num(sb['weak[limit]']), value: weak, source: unit });
      }
    }

    /**
     * 命中率 cut (S1's 被动; 阿斯卡纶's mechanism): an attack of a cut damage type rolls once when it starts and misses
     * as a whole. Keyed by `attackId` so every hit of one attack shares the roll.
     */
    function installHitrate(battle, ownerUnit) {
      const last = new WeakMap();
      battle.on('hit', (c) => {
        const st = ownerUnit.mem?.elaMiss;
        if (!st || !st.size) return;
        const e = c.source, d = c.dmg;
        if (!e || !d || e.side !== 'enemy' || !d.isAttack || d.cancel) return;
        const rec = st.get(e);
        if (!rec || battle.time > rec.until) return;
        const cut = d.type === 'arts' ? rec.arts : d.type === 'phys' ? rec.phys : 0;
        if (!(cut > 0)) return;
        let miss;
        const prev = last.get(e);
        if (prev && d.attackId && prev.id === d.attackId) miss = prev.miss;
        else {
          miss = battle.rng() < cut;
          if (d.attackId) last.set(e, { id: d.attackId, miss });
        }
        if (!miss) return;
        d.cancel = true;
        d.amount = 0;
        battle.fx('dodge', { x: c.target?.x ?? e.x, y: c.target?.y ?? e.y, id: c.target?.id ?? e.id });
      }, { priority: MISS_PRIORITY });
    }
  },
};
