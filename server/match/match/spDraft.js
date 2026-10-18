// server/match/match/spDraft.js — Match methods: the 机变 draft (SP_DRAFT: turn order, timers, AI picks, the card applied
// by choices.js applyCard), the personal bounty choice of the Art 教鞭 (offerBountyChoice / pickPersonalChoice /
// autoPickPersonalChoice: held by the player inside PREP — no phase, no timer of its own) and the rolls the meta effects
// ask for — bounties (addBounty), item ids (rollItemId) and choices.json pools (rollPool).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { generateDraft, applyCard, bountyBattles, isMultiRoundBounty, bountyCard } from '../choices.js';
import { onPickCard } from '../botEmotes.js';
import { weightedPick } from '../waves.js';
import { botPickCard } from '../bot.js';
import { OK, fail, DELAYS } from './common.js';

/** Cards of the personal choice (PRTS 卫戍协议：盟约 下半 §法术 教鞭: "于3个战术特训的悬赏任务中选择一项"). */
const PERSONAL_OFFER_SIZE = 3;

/**
 * Whether this 机变 step runs one six-card page per fixed card-pool group. `groups` is absent on a plain fixture (and
 * on a room of five players or fewer, where the original single room-wide page applies), so every reader asks here.
 * @param {any} sp
 */
const spGrouped = (sp) => !!(sp && Array.isArray(sp.groups) && sp.groups.length);

export class MatchSpDraft {
  enterSpDraft() {
    // A personal 教鞭 reward: the item gate follows the receiver's own group stock as the turn moves, so one group
    // running out of an item cannot offer it to another group's seat.
    const draft = generateDraft(this.gd, this.rngDraft, this.round, { stageId: this.stageId, bondAvailable: (bondId) => this.bondLive(bondId), itemAvailable: id => this.itemPool.canGain(id) });
    const alive = this.alivePlayers();
    if (!draft || !alive.length) { this.beforePrepOffers(); return; }
    this.phase = PHASE.SP_DRAFT;
    let order = alive.map((p) => p.playerId);
    if (!this.isSolo) this.rngDraft.shuffle(order);
    // 「AI 队友最后选择」 (GitHub #338): humans before AI seats, after the same shuffle (MatchPhases.humansFirst)
    order = this.humansFirst(order);
    // untimed: solo and any single-human match (soloUntimed); the co-op order / 6 cards stay
    const untimed = this.soloUntimed;
    this.sp = {
      ...draft, order, idx: 0, picks: {}, taken: {}, untimed, turnDeadline: 0,
      /** per fixed card-pool group: its own six-card page and who took which position (see _initSpGroups) */
      groups: [], groupOf: new Map(), groupTaken: new Map(), cursor: 0, cursorOf: new Map(),
    };
    this._initSpGroups();
    this.setDeadline(0);
    this.startSpTurn();
    this.markPublic();
    // the seat's own page reaches it in m.private (spGroup): every seat needs its page's taken map and its own turn
    for (const ps of this.order) this.markPrivate(ps);
  }

  /**
   * One 机变 page per fixed card-pool group. A room of six or more splits into the same groups the shared pools use
   * (server/match/pool.js createPoolGroups), each drawing its OWN six cards of the round's family: the whole room rolls
   * the event type once, then every group gets an independent page. That is the difference from the strategy draft
   * (MatchPhases.bandTaken), which stays room-wide.
   *
   * Why: one room-wide page of six cards cannot serve twenty seats — the taken positions run out after six picks and
   * the remaining seats have nothing to choose. With a page per group every seat always has six options, a card a
   * group-mate took is the only one it cannot repeat, and two groups may take the same card (owner's rule 2026-10-12:
   * 「机变分类就行」). A room of five or fewer keeps the original single page.
   */
  _initSpGroups() {
    const s = this.sp;
    if (!s || this.isSolo) return;
    const groups = Array.isArray(this.poolGroups) ? this.poolGroups : [];
    if (groups.length <= 1) return;
    for (const g of groups) {
      const page = this.spPageFor(g);
      s.groups.push(page);
      for (const pid of g.playerIds) s.groupOf.set(pid, page);
    }
    for (const page of s.groups) s.groupTaken.set(page.id, {});
  }

  /**
   * Build a group's page: the same round and family, cards drawn independently (unwrapped from the room's own draft,
   * whose family the whole room shares). Falls back to the room's cards when a group's page comes out empty.
   */
  spPageFor(group) {
    const base = this.sp;
    const drawn = generateDraft(this.gd, this.rngDraft, this.round, {
      stageId: this.stageId, family: base.family,
      bondAvailable: (bondId) => this.bondLive(bondId),
      itemAvailable: id => this.itemPoolFor(group.playerIds[0]).canGain(id),
    });
    const cards = drawn && drawn.cards && drawn.cards.length ? drawn.cards : base.cards;
    return { id: group.id, playerIds: group.playerIds.slice(), cards };
  }

  /** The 机变 page a seat chooses from: its group's own page, or the single room-wide one. */
  spPageOf(playerId) {
    const s = this.sp;
    if (!spGrouped(s)) return s;
    return s.groupOf.get(playerId) || s.groups[0];
  }

  /** The positions already taken on `page`. */
  spTakenOf(page) {
    const s = this.sp;
    if (!page || !spGrouped(s)) return s.taken;
    return s.groupTaken.get(page.id) || {};
  }

  spTurn() {
    const s = this.sp;
    if (!s) return null;
    // grouped pages: the first page's own position (the room order's index `cursor` is the flat view's). A reader that
    // needs "whose turn is it on THIS seat's page" asks spTurnOf(ps) / spAheadOf(ps), the per-page cursors.
    if (spGrouped(s)) {
      const first = s.order[Number.isInteger(s.cursor) ? s.cursor : 0] ?? null;
      const page = s.groups.find((g) => g.playerIds.includes(first)) || s.groups[0];
      return this.spTurnOf(page);
    }
    return s.order[s.idx] ?? null;
  }

  /**
   * Whose turn it is on `page`: the next member of the page's group in the ROOM order that has not picked, starting at
   * that page's own cursor. Every page has its own cursor for exactly this: when a page has no page-member left that
   * still needs to pick, the room order moves on FOR THAT PAGE ONLY — the other pages stay on the seat they are at.
   * @param {any} page s.groups[i], or s itself for the single-page room
   */
  spTurnOf(page) {
    const s = this.sp;
    if (!s || !page) return null;
    if (!spGrouped(s)) return s.order[s.idx] ?? null;
    for (let at = Number.isInteger(s.cursorOf.get(page.id)) ? s.cursorOf.get(page.id) : 0; at < s.order.length; at++) {
      const pid = s.order[at];
      if (page.playerIds.includes(pid) && s.picks[pid] == null && this.players.get(pid)?.alive) return pid;
    }
    return null;
  }

  /**
   * The seats of `page` still to pick, in room order, from its own cursor on — what the client lists behind the
   * picker. Its first entry IS the page's picker (spTurnOf): a seat reads `ahead[0]` as "whose turn is it here".
   */
  spAheadOf(page) {
    const s = this.sp;
    if (!s || !page) return [];
    if (!spGrouped(s)) return this.spTurn() ? [this.spTurn()] : [];
    const out = [];
    for (let at = Number.isInteger(s.cursorOf.get(page.id)) ? s.cursorOf.get(page.id) : 0; at < s.order.length; at++) {
      const pid = s.order[at];
      if (page.playerIds.includes(pid) && s.picks[pid] == null && this.players.get(pid)?.alive) out.push(pid);
    }
    return out;
  }

  /** Whether `card` can still be taken: by `ps` when given (its own group's page), else on any group's page. */
  spCardAvailable(card) { return !!card && (card.kind !== 'item' || this.itemPool.canGain(card.id)); }

  /**
   * Whether `ps` may still take position `idx` of its page: free on ITS group's page (a group-mate already took it ⇒
   * no) and, for an equipment card, affordable from that group's stock.
   */
  spCardOpen(ps, idx) {
    const s = this.sp;
    if (!s || !ps) return false;
    const page = this.spPageOf(ps.playerId);
    const card = page && page.cards ? page.cards[idx] : null;
    if (!card) return false;
    if (this.spTakenOf(page)[idx] != null) return false;
    return this.spCardAvailable(card);
  }

  /** Every group's live picker, each on its own page and its own cursor — they pick in PARALLEL. */
  spActors() {
    const s = this.sp;
    if (!s) return [];
    const out = [];
    if (!spGrouped(s)) {
      const pid = s.order[s.idx];
      const ps = pid ? this.players.get(pid) : null;
      if (ps && ps.alive && s.picks[ps.playerId] == null) out.push(ps);
      return out;
    }
    for (const page of s.groups) {
      const pid = this.spTurnOf(page);
      const ps = pid ? this.players.get(pid) : null;
      if (ps && ps.alive && s.picks[ps.playerId] == null) out.push(ps);
    }
    return out;
  }

  startSpTurn() {
    const s = this.sp;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    if (!s) { this.finishSpDraft(); return; }
    const grouped = spGrouped(s);
    // Advance the cursors to a position that still needs a pick. A grouped room advances EVERY page that has nothing
    // left where it stands — never another page's position, which is what used to strand a group behind its own room:
    // the cursor a page runs out of work at is that page's own, so it alone moves on (see spTurnOf).
    for (let guard = 0; guard <= s.order.length + 1; guard++) { // loop-cap: the room order plus one, see the guard
      if (grouped) {
        let moved = false;
        for (const page of s.groups) {
          let at = Number.isInteger(s.cursorOf.get(page.id)) ? s.cursorOf.get(page.id) : 0;
          const at0 = at;
          while (at < s.order.length) { // loop-cap: draft order, one page position a pass
            const pid = s.order[at];
            const ps = this.players.get(pid);
            if (page.playerIds.includes(pid) && ps && ps.alive && s.picks[pid] == null) break;
            at++;
          }
          if (at === at0) continue; // this page is at its picker: it stays (it does not wait for the other pages')
          s.cursorOf.set(page.id, at);
          moved = true;
        }
        if (!moved) break;
      } else {
        while (s.idx < s.order.length) { // loop-cap: draft order
          const ps = this.players.get(s.order[s.idx]);
          if (ps && ps.alive && s.picks[ps.playerId] == null) break;
          s.idx++;
        }
        break;
      }
    }
    const actors = this.spActors();
    const anyOpen = actors.some((ps) => this.spPageOf(ps.playerId).cards.some((_c, i) => this.spCardOpen(ps, i)));
    if (!actors.length || !anyOpen) {
      if (grouped && s.groups.some((page) => (s.cursorOf.get(page.id) ?? 0) < s.order.length)) {
        // nothing left to pick on any page that still has room: close those pages and look again
        for (const page of s.groups) if ((s.cursorOf.get(page.id) ?? 0) < s.order.length) s.cursorOf.set(page.id, s.order.length);
        this.startSpTurn();
        return;
      }
      this.setDeadline(0);
      this.later(0, () => this.finishSpDraft());
      return;
    }
    // the flat `cursor` mirrors the first page's own position (the client reads its own turn per page)
    if (grouped) s.cursor = Math.min(...s.groups.map((page) => Number.isInteger(s.cursorOf.get(page.id)) ? s.cursorOf.get(page.id) : 0));
    const token = ++this._turnToken;
    if (!s.untimed) {
      const first = (grouped ? s.cursor : s.idx) === 0;
      const secs = first ? this.gd.timer('spFirst') : this.gd.timer('spTurn');
      this.setDeadline(secs, () => {
        if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken) return;
        for (const ps of this.spActors()) this._autoCard(ps);
      });
      s.turnDeadline = this.deadline;
    } else {
      this.setDeadline(0);
    }
    for (const ps of this.spActors()) if (ps.botControlled) this.scheduleSpBot(ps);
    // a page's taken map and its own turn live in the seat's m.private (spGroup): refresh them for every seat whose
    // page state can have changed (the pageless room reads m.public.sp alone and skips this)
    if (grouped) for (const ps of this.order) this.markPrivate(ps);
    this.markPublic();
  }

  /** A turn that ran out: take a random still-open position of the seat's own page. */
  _autoCard(ps) {
    const page = this.spPageOf(ps.playerId);
    const open = page.cards.map((_c, i) => i).filter((i) => this.spCardOpen(ps, i));
    if (!open.length) return;
    this._applyCard(ps, open[Math.floor(this.rngDraft() * open.length)]);
  }

  scheduleSpBot(who = null) {
    const token = this._turnToken;
    this.later(this.scaled(DELAYS.BOT_ACTION), () => {
      if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken || !this.sp) return;
      const ps = who || this.players.get(this.spTurn());
      if (!ps || !ps.botControlled) return;
      const page = this.spPageOf(ps.playerId);
      const avail = page.cards.map((_c, i) => i).filter((i) => this.spCardOpen(ps, i));
      if (!avail.length) return;
      this._applyCard(ps, botPickCard(this, ps, page.cards, avail));
    });
  }

  pickCard(ps, idx) {
    if (this.phase !== PHASE.SP_DRAFT || !this.sp) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.sp.picks[ps.playerId] != null) return fail(ERR.ALREADY);
    const page = this.spPageOf(ps.playerId);
    // the turn is the seat's OWN page's (spTurnOf): every group picks in parallel, so a seat is not held back by
    // another group still deciding at its own position
    if (this.spTurnOf(page) !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (!Number.isInteger(idx) || idx < 0 || idx >= page.cards.length) return fail(ERR.BAD_TARGET);
    if (!this.spCardOpen(ps, idx)) return fail(ERR.SOLD_OUT);
    this._applyCard(ps, idx);
    return OK;
  }

  _applyCard(ps, idx) {
    const s = this.sp;
    if (!s || s.picks[ps.playerId] != null) return;
    const page = this.spPageOf(ps.playerId);
    const card = page && page.cards ? page.cards[idx] : null;
    if (!card || this.spTakenOf(page)[idx] != null) return;
    if (!this.spCardAvailable(card)) return;
    s.picks[ps.playerId] = idx;
    if (spGrouped(s)) {
      s.groupTaken.get(page.id)[idx] = ps.playerId;
      // this page's position is decided: its own cursor moves past the seat (never another page's — they keep theirs)
      const at = Number.isInteger(s.cursorOf.get(page.id)) ? s.cursorOf.get(page.id) : 0;
      for (let i = Math.max(0, at); i < s.order.length; i++) {
        if (s.order[i] === ps.playerId) { s.cursorOf.set(page.id, i + 1); break; }
      }
    } else s.taken[idx] = ps.playerId;
    try { applyCard(this, ps, card); } catch (e) { this.reportError(`applyCard ${card.id}`, e); }
    this.markPrivate(ps);
    this.markPublic();
    onPickCard(this, ps, card); // AI bots say "思考" when they take a bounty (enabled by default; SP_BOT_EMOTES=0 silences it)
    this.startSpTurn();
  }

  finishSpDraft() {
    if (this.phase !== PHASE.SP_DRAFT) return;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    this.beforePrepOffers();
  }

  /**
   * 教鞭 (content/items/meta.js, ctx.offerBountyChoice): the Art opens a PERSONAL choice (act2autochess choice event
   * `hunter_band_1`, choiceType PERSONAL_CHOOSE) between up to three of `candidates` — drawn once from the meta rng, kept in
   * `ps.personalChoice` (m.private only) until the owner confirms one with `g.choice { idx, choiceId }`. It lives inside
   * PREP: no phase of its own and no timer — the prep's deadline resolves it (prepDeadline), Ready is refused while it is
   * pending (PlayerPrep.setReady). Refused — before an rng draw or an id is used, so the Art stays in the hand — when it
   * is not the player's PREP, a choice is already open or no card is left to offer.
   * @param {import('../PlayerState.js').PlayerState} ps @param {any[]} candidates cards.bounty entries
   * @param {string} sourceItemId the Art
   */
  offerBountyChoice(ps, candidates, sourceItemId) {
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (ps.ready) return fail(ERR.WRONG_PHASE, 'ready');
    if (ps.personalChoice) return fail(ERR.BAD_TARGET, '请先完成当前教鞭选择'); // i18n-ignore: developer error detail
    if (!candidates.length) return fail(ERR.BAD_TARGET, '当前没有可用的战术特训'); // i18n-ignore: developer error detail
    const cards = this.rngMeta.shuffle(candidates.slice()).slice(0, PERSONAL_OFFER_SIZE);
    ps.personalChoice = { id: `${this.battlePrefix}.choice.${this.nextUid()}`, round: this.round, sourceItemId, cards };
    ps.dirty();
    return OK;
  }

  /** g.choice { idx, choiceId }: the owner's pick of its open personal choice — the card becomes a bounty on its next battles. */
  pickPersonalChoice(ps, idx, choiceId) {
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (ps.ready) return fail(ERR.WRONG_PHASE, 'ready');
    const pending = ps.personalChoice;
    if (!pending || pending.id !== choiceId || pending.round !== this.round) return fail(ERR.BAD_TARGET);
    if (!Number.isInteger(idx) || idx < 0 || idx >= pending.cards.length) return fail(ERR.BAD_TARGET);
    if (!this.addBounty(ps, pending.cards[idx])) return fail(ERR.BAD_TARGET);
    ps.personalChoice = null;
    ps.dirty();
    return OK;
  }

  /**
   * The pick made for a player who did not make it. 'bot': an AI seat or a human under AI 托管 — the bounty scorer of the
   * 机变 draft (bot.js botPickCard: the expected pay minus the expected LP lost against the own board, the bots' seeded rng
   * only breaks ties); 'random': the prep's deadline and a seat the engine finishes by other means — one of the cards at
   * random from the meta rng, like a 机变 turn that runs out. Nothing pending: nothing happens, no rng draw.
   */
  autoPickPersonalChoice(ps, mode) {
    const pending = ps.personalChoice;
    if (!pending) return undefined;
    const indices = pending.cards.map((c, i) => i);
    const idx = mode === 'bot'
      ? botPickCard(this, ps, pending.cards.map((c) => bountyCard(this.gd, c)), indices)
      : this.rngMeta.pick(indices);
    return this.pickPersonalChoice(ps, idx, pending.id);
  }

  addBounty(ps, card) {
    if (!ps || !card || !this.gd.enemy(card.enemyKey)) return null;
    // a multi-round card lasts MULTI_ROUND_BOUNTY_BATTLES battles (choices.js; the user's call after playtest #6)
    const rounds = bountyBattles(card);
    const b = {
      id: `bounty:${this.nextUid()}`,
      card: { effectId: card.effectId ?? card.id ?? null, name: card.name ?? '悬赏', desc: card.desc ?? '', tier: card.tier ?? 1, coin: Math.max(0, Math.trunc(Number(card.coin) || 0)), payout: card.payout === 'perfect' ? 'perfect' : 'kill', rounds, multiRound: isMultiRoundBounty(card), enemyKey: card.enemyKey, count: Math.max(1, Math.min(20, Number.isInteger(card.count) ? card.count : 1)) }, // i18n-ignore: a data-less card's fallback name
      roundsLeft: rounds,
    };
    ps.bounties.push(b);
    ps.dirty();
    return b.id;
  }

  /**
   * Random item id: a choices.json server pool ({ pool }), a tier, or ≤ maxTier shop-eligible items.
   * `player` selects the receiver's fixed-group equipment stock (a whole-room utility like 战术决策 falls back to the
   * first group) — a支援 granted to one seat must respect the stock of the group that seat belongs to.
   * `also` (pool_equip_kathe: 突变细胞) joins the draw even though it is shopExcluded. The shop item slot does not
   * read it. `pick` still drops ids that `canGain` refuses, so an empty shop item stays out and an uncapped `also`
   * id can still be drawn. `exclude` removes ids before sampling (Cathy's match-long allowance / distinct choices). */
  rollItemId({ pool = null, tier = null, maxTier = 6, shopLevel = 6, player = null, exclude = [] } = {}) {
    const stock = player ? this.itemPoolFor(player) : this.itemPool;
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof pool === 'string' && Object.hasOwn(pools, pool) ? pools[pool] : null;
    const rng = this.rngMeta;
    const pick = (ids, weights = null) => this.itemPool.pick(rng, ids.filter((id) => !exclude.includes(id)), weights);
    const tierList = (lo, hi) => { const out = []; for (let t = lo; t <= hi; t++) for (const id of this.gd.shopItemsByTier[t] || []) out.push(id); return out; };
    const also = p && Array.isArray(p.also) ? p.also.filter((id) => typeof id === 'string' && this.gd.item(id)) : [];
    const withAlso = (list) => {
      const out = list.slice();
      for (const id of also) if (!out.includes(id)) out.push(id);
      return out;
    };
    if (p && p.kind === 'equip') {
      if (Array.isArray(p.weighted) && p.weighted.length) {
        const pairs = p.weighted.filter((x) => Array.isArray(x) && this.gd.item(x[0]) && stock.canGain(x[0]));
        for (const id of also) if (!pairs.some((x) => x[0] === id)) pairs.push([id, 1]);
        return pick(pairs.map(x => x[0]), new Map(pairs));
      }
      if (Array.isArray(p.items) && p.items.length) {
        const items = p.items.filter((id) => this.gd.item(id));
        return pick(withAlso(items));
      }
      let list;
      if (Array.isArray(p.tiers) && p.tiers.length) list = p.tiers.flatMap((t) => this.gd.shopItemsByTier[t] || []);
      else list = tierList(1, p.maxTier === 'shopLevel' ? Math.max(1, Math.min(6, shopLevel)) : 6);
      return pick(withAlso(list));
    }
    const list = Number.isInteger(tier) ? tierList(tier, tier) : tierList(1, Math.max(1, Math.min(6, maxTier)));
    return pick(list);
  }

  /**
   * Roll a choices.json pool (ctx.rollPool). Equip pools → rollItemId. Chess pools: an `items` (uniform) or `weighted`
   * list — only chess with a free pool copy (or outside the pool) qualify — else a copy-weighted draw from the shared
   * pool filtered by `tier` / `minTier` / `maxTier` (number or 'shopLevel') / `bond`; `golden: true` yields the elite id.
   * `extra` (the drawing player's 自选 stock, player/diy.js diyStockEntries) joins that shared-pool draw, `chessOf` reads the
   * bonds (the player's data view: a slotted slot's operator) — 0.2.0 WE2. `player` selects the receiver's fixed
   * card-pool group, so a支援 drawn for one seat never spends another group's copies or equipment stock.
   * @returns {{ kind: 'item'|'chess', id: string, golden?: boolean } | null}
   */
  rollPool(poolId, { shopLevel = 6, extra = null, chessOf = null, player = null, exclude = [] } = {}) {
    const pool = player ? this.poolFor(player) : this.pool;
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof poolId === 'string' && Object.hasOwn(pools, poolId) ? pools[poolId] : null;
    if (!p || typeof p !== 'object') return null;
    const lvl = Math.max(1, Math.min(6, Number.isInteger(shopLevel) ? shopLevel : 6));
    if (p.kind === 'equip') {
      const id = this.rollItemId({ pool: poolId, shopLevel: lvl, player, exclude });
      return id ? { kind: 'item', id } : null;
    }
    if (p.kind !== 'chess') return null;
    const rng = this.rngMeta;
    const free = (id) => {
      if (typeof id !== 'string' || !this.gd.chess(id)) return false;
      const base = this.gd.baseIdOf(id);
      return !pool.has(base) || pool.left(base) > 0;
    };
    let id = null;
    if (Array.isArray(p.weighted) && p.weighted.length) {
      const pairs = p.weighted.filter((x) => Array.isArray(x) && free(x[0]));
      id = pairs.length ? weightedPick(rng, pairs) : null;
    } else if (Array.isArray(p.items) && p.items.length) {
      const list = p.items.filter(free);
      id = list.length ? list[Math.floor(rng() * list.length)] : null;
    } else {
      const maxTier = p.maxTier === 'shopLevel' ? lvl : Number.isInteger(p.maxTier) ? p.maxTier : 6;
      const minTier = Number.isInteger(p.minTier) ? p.minTier : 1;
      const bond = typeof p.bond === 'string' ? p.bond : null;
      const recOf = typeof chessOf === 'function' ? chessOf : (cid) => this.gd.chess(cid);
      id = pool.roll(rng, {
        tier: Number.isInteger(p.tier) ? p.tier : null,
        maxTier,
        filter: (cid, e) => e.tier >= minTier && (!bond || (Array.isArray(recOf(cid)?.bonds) && recOf(cid).bonds.includes(bond))),
        extra,
      });
    }
    if (!id) return null;
    const golden = !!p.golden;
    return { kind: 'chess', id: golden ? this.gd.goldenIdOf(id) || id : id, golden };
  }
}