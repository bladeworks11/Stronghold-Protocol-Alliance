// server/sim/content/kits/ops/op-ash.js — 灰烬 (char_456_ash) 自选 operator kit: 6★ 速射手 (狙击), a 联动 operator of the
// tier-5 and tier-6 自选 slots; every skill, both talents, the trait and both modules at every form.
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// 本机自用：灰烬是上游因版权排除的 7 名联动干员之一（tools/build-data.mjs DIY_INCLUDED_COLLABS、NOTICE.md §2）。
// 仅供本机个人非商业使用；不要公开分发，也不要向上游提 PR。
//
// Forms (data/backups.json units.char_456_ash, the DIY slot statuses): normal = E2 Lv1, skills at rank 4, no module;
// elite = E2 Lv60, rank 7, the picked module at stage 1 (tier 5) or 3 (tier 6). Full potential.
// Sources: character_table / skill_table / battle_equip_table (zh_CN, as built into backups.json) and the official
// skill texts in those same records — every number is read from the blackboard, never written down here.
// - Trait (速射手) "优先攻击空中单位": the profession default (professions.js fastshot) — air units first, both reachable.
// - T1 辅助装备 "部署后立即对攻击范围内一个敌人投掷闪光弹，使其和周围敌人晕眩4秒" (PRTS 备注 "攻击范围内无可选目标时，
//   无法触发本天赋；闪光弹影响半径为1"): on deployment one targetable enemy of her range gets the flash; it and the
//   enemies within 1.0 of it are stunned `stun` s. MAR-X stage 2+ raises the stun (talent change 5 / 6 s) and adds
//   "且N秒内灰烬对这些敌人造成的物理伤害提升scale_duration%": the flashed enemies take her PHYSICAL damage
//   ×(1 + `damage_scale`) for `scale_duration` s (the same enemies the stun hit).
// - T2 突击手 "首次部署时部署费用-3，部署后立即获得20（+3）技力": the deployment is free in this mode, so `runtime_cost`
//   has no effect [ASSUMED, as 推进之王's SOL-Y and 德克萨斯's elite note]; PRTS 备注 "费用减少效果于战斗开始后生效至
//   待部署区的灰烬自己，于灰烬首次部署后失效" agrees that it is a deployment-cost effect, which this mode does not charge.
//   The +`sp` SP on every deployment applies.
// - MAR-Y “破墙榴弹战术收纳包” "范围内存在地面敌人时攻击速度+8" (hidden talent change `attack_speed`): ASPD `aspd` +8 while a
//   ground enemy stands in her range — a conditional buff kept exactly while the condition holds (toggleBuff).
// - MAR-X “刺针式合金爆破弹” "攻击空中单位时攻击力提升至110%" (trait bb `atk_scale`, stage 2+): ×`atk_scale` on her own
//   attack damage against an airborne target.
// - S1 支援射击 (AUTO, 持续时间无限, SP_INCREASE_WITH_TIME): ATK +`atk` and each attack becomes `attack@times` hits.
// - S2 突击战术 (MANUAL, 弹药 31 发, SP_INCREASE_WITH_TIME): attack interval −|`base_attack_time`| (PRTS "-80%" — her
//   1.0 s base × 0.2 = 0.2 s), the first talent's flash at once, and every hit on a 晕眩 target is dealt at
//   `ash_s_2[atk_scale].atk_scale` × ATK instead of 1 × ("攻击被晕眩目标时攻击力提高至210%"). A final multiplier, so
//   the rest of the damage pipeline is unchanged. PRTS 备注 carries an original-game quirk the data does not:
//   "因弹药数打完而导致当次技能自动结束后，下次开启技能时装有的弹药数将少1发（变为30/31发弹药）" — the magazine keeps
//   one round in the chamber, so a skill that ENDED BY SPENDING ITS LAST BULLET arms the next one with 30; a skill
//   stopped by hand keeps 31 (implemented in the ammo bookkeeping below).
// - S3 攻坚榴弹 (MANUAL, SP_INCREASE_WITH_TIME 25 SP, skill range 4-1, "每次部署只能释放2次"): a 破墙弹 flies along her
//   facing. PRTS 备注 "破墙弹推动半径1.2（碰撞箱判定），爆炸半径1.5（中点判定）；破墙弹由地面地形飞向高台或者地图边界时，
//   在地块边界中点上爆炸；没有任何阻挡的情况下，将在自身面前第4格的中心处爆炸" — so the shell runs 4 tiles (the centre of
//   the tile ahead of the 4th) and pushes with 力度 `force` in a 1.2 radius, hitting for `atk_scale` × ATK physical;
//   the detonation is 1.5 around its end point for `not_hitwall_scale` (or `hitwall_scale` against a 高台 edge).
//   The wall case needs the shell to stop at a 高台 boundary, which the sim's projectile has no terrain collision for —
//   that one branch is NOT implemented [ASSUMED: reported as the remaining fidelity gap]. "每次部署只能释放2次" has no
//   blackboard key either, so the casts are not capped [ASSUMED: the SP cost is the only limit].

import { num, talentBb, traitBb, moduleBb, skillRec, up, toggleBuff } from '../shared/tier1.js';

const S1 = 'skchr_ash_1';
const S2 = 'skchr_ash_2';
const S3 = 'skchr_ash_3';
/** T1 辅助装备: the flash's 溅射 radius [PRTS 备注 "闪光弹影响半径为1"]. */
const FLASH_RADIUS = 1.0;
/** T1 辅助装备: how long after a deployment with no target yet the flash looks again (the spawn phase of step 1). */
const FLASH_DELAY = 0.1;
/**
 * S2 突击战术: the bullets it holds. "攻击装有31发子弹" is in the skill text only — no level of the official
 * skill_table record carries it in the blackboard (checked: every level lists `base_attack_time` and
 * `ash_s_2[atk_scale].atk_scale` and nothing else), so it cannot be read from the data like every other number here
 * [the one hard-coded value of this kit; the same situation as 蕾缪安's S3 cadence, op-lemuen.js].
 */
const S2_AMMO = 31;
/** S2's quirk (PRTS 备注): a skill that ran out of bullets arms the next one with one round fewer. */
const S2_AMMO_SPENT = 30;
/** S3 攻坚榴弹: 爆炸半径 [PRTS 备注 "爆炸半径1.5（中点判定）"]. */
const S3_BLAST_RADIUS = 1.5;
/** S3: the shell's push radius [PRTS 备注 "破墙弹推动半径1.2（碰撞箱判定）"] — not the blast radius. */
const S3_PUSH_RADIUS = 1.2;
/** S3: "没有任何阻挡的情况下，将在自身面前第4格的中心处爆炸" — the tile ahead of the 4th (0-indexed offset 4). */
const S3_TILES = 4;
/** S3: "每次部署只能释放2次" — the count is in the text only, so it is a constant of this kit. */
const S3_CASTS = 2;
/** S3's shell speed in tiles/s [ASSUMED: the engine's bomb speed is the convention for a 破墙弹]. */
const S3_SPEED = 8;
/** The mark the flashed enemies carry: MAR-X's "N秒内灰烬对这些敌人造成的物理伤害提升". */
const FLASH_MARK = 'ash:flashMark';

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};
const count = (v, d = 1) => Math.max(1, Math.floor(num(v, d)));

/** 晕眩 of the catalogue (the client's STUNNED: not 冻结 / 浮空 — as 维什戴尔's kit reads it). */
const stunned = (e) => !!e && (typeof e.hasBuff === 'function' ? e.hasBuff('stun') : false);

/** The flash: `stun` s on the enemies within FLASH_RADIUS of (x, y), plus MAR-X's physical-damage mark on them. */
function flash(battle, unit, x, y, stun, mark) {
  battle.fx('aoe', { x, y, radius: FLASH_RADIUS, id: unit.id, skill: 'ash:flash' });
  for (const e of battle.foesInRadius(x, y, FLASH_RADIUS, true)) {
    if (!e.alive) continue;
    if (stun > 0) battle.applyStatus(e, 'stun', { duration: stun, source: unit });
    // MAR-X stage 2+: "且scale_duration秒内灰烬对这些敌人造成的物理伤害提升damage_scale" — on the same enemies.
    if (mark && mark.duration > 0 && mark.scale > 0) {
      battle.addBuff(e, { key: FLASH_MARK, duration: mark.duration, source: unit, refresh: 'extend', data: mark });
    }
  }
}

/** The one enemy the flash is thrown at: the first targetable enemy of her range ("攻击范围内一个敌人"). */
function flashTarget(battle, unit) {
  const keys = unit.rangeKeys ?? [];
  const foes = battle.enemiesInKeys(keys, unit, { canHitFly: true });
  return foes.length ? foes[0] : null;
}

export default {
  char_456_ash: (bb, chess) => {
    const t0 = talentBb(chess, 0);            // 辅助装备: stun (MAR-X stage 2+ raises it)
    const t1 = talentBb(chess, 1);            // 突击手: runtime_cost (no effect here), sp
    const tb = traitBb(chess);                // MAR-X: atk_scale against airborne targets
    const hidden = moduleBb(chess);           // MAR-Y: the hidden talent change's attack_speed
    const b1 = bbOf(chess, S1);
    const s2 = skillRec(chess, S2);
    const b2 = s2?.bb ?? {};
    const b3 = bbOf(chess, S3);
    const airScale = num(tb.atk_scale, 1);
    const asMod = num(hidden.attack_speed);
    const flashStun = num(t0.stun);
    // MAR-X stage 2+ (the module's talent change, already merged into `talents[0].bb` by build-data): the flash's
    // "且scale_duration秒内灰烬对这些敌人造成的物理伤害提升至damage_scale" — damage_scale is a MULTIPLIER (1.1 = ×1.1).
    const flashMarkScale = num(t0.damage_scale, 1);
    const flashMark = { duration: num(t0.scale_duration), scale: flashMarkScale > 1 ? flashMarkScale : 0 };
    /**
     * S2's magazine (PRTS 备注): a skill that ran out of bullets arms the next one with 30, one stopped by hand keeps
     * 31. The flag is set by the skill's own end reason.
     */
    const ammoFor = (u) => (u?.mem?.ashSpent ? S2_AMMO_SPENT : S2_AMMO);

    /** 辅助装备 on every deployment (the initial one and any re-deployment). */
    const throwFlash = (battle, unit) => {
      // At the battle's start the deployment runs BEFORE the spawn phase (battle/lifecycle.js start(): initial
      // deployments, `battleStart`, then step 1's spawns), so the opening deployment has no enemy to aim at yet. The
      // official flash is thrown as the deployment finishes, so one deferred look is enough; a mid-battle
      // re-deployment finds its target at once and never comes here.
      const seq = unit.deploySeq;
      const at = (delay) => battle.after(delay, () => {
        if (!up(unit) || unit.deploySeq !== seq) return;
        const target = flashTarget(battle, unit);
        if (!target) return;
        flash(battle, unit, target.x, target.y, flashStun, flashMark);
      }, { owner: unit });
      const target = flashTarget(battle, unit);
      if (target) { flash(battle, unit, target.x, target.y, flashStun, flashMark); return; }
      at(FLASH_DELAY);
    };

    return {
      skills: {
        // S1 支援射击: ATK +atk, every attack attack@times hits, 持续时间无限.
        [S1]: {
          kind: 'duration', duration: Infinity,
          mods: { atkPct: num(b1.atk) },
          attack: { hits: count(b1['attack@times'], 1) },
        },
        // S2 突击战术: an ammo skill (31 bullets, 30 after one ran dry), −80 % interval, a flash at once, and the
        // higher scale on a stunned target.
        [S2]: {
          kind: 'ammo',
          ammo: S2_AMMO,   // the opening magazine; a run-dry ending lowers the next one (onStart below)
          mods: { batPct: num(b2.base_attack_time) / (num(chess?.stats?.bat, 1) || 1) },
          attack: {
            // "攻击被晕眩目标时攻击力提高至210%": a final multiplier on the attack already being dealt.
            dmgMul: (_b, u, t) => (t && stunned(t) ? num(b2['ash_s_2[atk_scale].atk_scale'], 1) : 1),
          },
          onStart({ battle, unit: u, skill }) {
            // "因弹药数打完而导致当次技能自动结束后，下次开启技能时装有的弹药数将少1发（变为30/31发弹药）"
            const n = ammoFor(u);
            if (skill && n !== S2_AMMO) { skill.ammoLeft = n; skill.ammoMax = n; }
            throwFlash(battle, u);
          },
          onEnd({ unit: u, reason }) { u.mem.ashSpent = reason === 'ammo'; },
        },
        // S3 攻坚榴弹: one shell along her facing; everyone it passes is pushed and hit, then it detonates at the
        // centre of the 4th tile ahead (no terrain collision: the wall case is not implemented — see the header).
        // "每次部署只能释放2次" — the count is in the text only, so it is a kit constant, reset on each deployment.
        [S3]: {
          kind: 'instant',
          onStart({ battle, unit: u }) {
            // "每次部署只能释放2次": once the two are spent no further shell is fired. The skill itself is left to the
            // engine (its SP is drained, and SP does not regenerate while a timed skill runs, so it cannot re-cast);
            // what this kit stops is the EFFECT, which is what the official line limits.
            if ((u.mem.ashS3Left ?? S3_CASTS) <= 0) return;
            u.mem.ashS3Left = (u.mem.ashS3Left ?? S3_CASTS) - 1;
            u.mem.ashS3Fired = (u.mem.ashS3Fired ?? 0) + 1;
            const [fr, fc] = u.fwd;
            const tiles = Math.max(1, (u.def?.skill?.rangeGrid ?? []).reduce((m, [, c]) => Math.max(m, c + 1), S3_TILES));
            const from = { x: u.x, y: u.y };
            const end = { x: u.x + fc * tiles, y: u.y + fr * tiles };
            const force = num(b3.force);
            const scale = num(b3.atk_scale, 1);
            const radius = num(b3.range_radius, 1.5);
            battle.addProjectile({
              from: u, to: end, speed: S3_SPEED, visual: 'bomb', source: u,
              onHit: () => {
                // the flight (1.2 push radius, 碰撞箱判定) — each enemy on the way is pushed and takes atk_scale
                for (const e of battle.foesInRadius(end.x, end.y, S3_PUSH_RADIUS, true)) {
                  if (force > 0) battle.push(e, force, { from, dir: u.fwd });
                  battle.dealDamage(u, e, { amount: u.s.atk * scale, type: 'phys', isSkill: true, tags: ['skill', 'ash:s3'] });
                }
                // the detonation (1.5, 中点判定)
                battle.fx('aoe', { x: end.x, y: end.y, radius, id: u.id, skill: 'ash:s3blast' });
                for (const e of battle.foesInRadius(end.x, end.y, radius, true)) {
                  battle.dealDamage(u, e, {
                    amount: u.s.atk * num(b3.not_hitwall_scale, scale), type: 'phys', isSkill: true, isSplash: true,
                    tags: ['skill', 'ash:s3blast'],
                  });
                }
              },
            });
          },
        },
      },
      talents: [
        { install(battle, unit) { // 辅助装备: the flash and S3's per-deployment cast count on every deployment
          battle.on('deploy', (c) => {
            if (c.unit !== unit || c.move) return;
            unit.mem.ashS3Left = S3_CASTS;   // "每次部署只能释放2次"
            throwFlash(battle, unit);
          }, { owner: unit });
        } },
        { install(battle, unit) { // 突击手: +sp SP on deployment (runtime_cost has no effect: the deployment is free)
          const sp = num(t1.sp);
          if (!(sp > 0)) return;
          battle.on('deploy', (c) => {
            if (c.unit !== unit || c.move || !unit.skill) return;
            unit.skill.gainSp(sp, 'init');
          }, { owner: unit });
        } },
      ],
      install(battle, unit) {
        // MAR-Y “破墙榴弹战术收纳包”: ASPD +attack_speed while a ground enemy stands in her range.
        if (asMod > 0) {
          toggleBuff(battle, unit, 'ash:aspd', () => {
            const keys = unit.rangeKeys ?? [];
            return battle.enemiesInKeys(keys, unit, { canHitFly: false }).length > 0;
          }, { aspd: asMod });
        }
        // MAR-X “刺针式合金爆破弹”: ×atk_scale on her attack damage against an airborne target, and — stage 2+ —
        // ×damage_scale on her PHYSICAL damage against an enemy the flash marked (the same enemies it stunned).
        if (airScale !== 1 || flashMark.scale > 0) {
          battle.on('hit', (c) => {
            if (c.source !== unit || !c.dmg || !c.dmg.isAttack || !c.target) return;
            if (airScale !== 1 && c.target.motion === 'FLY') c.dmg.amount *= airScale;
            if (flashMark.scale > 0 && c.dmg.type === 'phys' && c.target.findBuff?.(FLASH_MARK)) {
              c.dmg.amount *= flashMark.scale;
            }
          }, { owner: unit });
        }
      },
    };
  },
};
