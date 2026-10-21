// server/aiTakeover.js — 观战者接替 AI（「AI 协作」；上游 PR #691 的移植）。休整期里，观战者可以申请坐上一名 AI 队友的
// 席位：同组当前在线、没有托管（autoplay）的真人队友严格过半同意才交接；没有这样的队友时由在线房主决定。
//
// 交接的语义（面板 public/js/ui/aiTakeover.js 把这几条写给玩家）：
//   * 保留 AI 的资金、阵容、席位与库存——只有座位上的人换了；
//   * 申请者原来的会话令牌不变：playerId 换成 AI 的，`welcome.takeoverFrom` 让客户端知道这是接管而不是新会话
//     （public/js/main.js onWelcome），随后照常做房间/对局重同步；
//   * 请求 30 秒失效；同一申请者、同一 AI 同时只能有一个请求；投票可以改，反对过半即关闭；
//   * 插件隔离房间（`room.modded`）与跑在宿主进程里的对局（`m.hosted`）不支持：它们的内容与席位由别处拥有；
//   * 不提供管理员写入，也不改资源——交接只是把一个观战者放进已有的席位。
//
// 规则 [ASSUMED]：这是重制版自己的多人协作规则（docs/PLAYING.md「AI 协作」），不是官方战斗规则，不影响 golden。

import { ERR } from '../shared/constants.js';

/** 一次申请的有效期（ms）。 */
const REQUEST_TTL = 30_000;

/** @typedef {{ id: string, applicantId: string, applicantName: string, botId: string, match: any, expiresAt: number,
 *   yes: Set<string>, no: Set<string>, timer?: NodeJS.Timeout }} Vote */

/** Per-room pending requests (not part of room.state; `room.aiTakeoverVotes` is the broadcast projection). */
/** @type {WeakMap<object, Map<string, Vote>>} */
const pending = new WeakMap();

const fail = (detail) => ({ error: ERR.BAD_TARGET, detail });

/** Forget every pending request of a room (match started/failed/ended, room disposed). @param {any} room */
export function resetAiTakeover(room) {
  const votes = pending.get(room);
  if (votes) {
    for (const vote of votes.values()) clearTimeout(vote.timer);
    votes.clear();
  }
  room.aiTakeoverVotes = [];
}

/**
 * Who decides: the online, non-autoplay human teammates of the AI's group; the online host when there are none.
 * @param {any} room @param {string} botId @returns {string[]}
 */
export function takeoverVoters(room, botId) {
  const m = room.match;
  const seats = room.seats.filter((s) => s && !s.isBot && !s.left && s.connected);
  const ids = seats.filter((s) => !m.players.get(s.playerId)?.autoplay).map((s) => s.playerId);
  if (!ids.length && room.seatOf(room.hostId)?.connected) ids.push(room.hostId);
  return ids;
}

/**
 * The handover itself: the applicant's session takes the AI player over, keeping its funds, lineup, seat and inventory.
 * @param {any} lobby @param {any} room @param {string} applicantId @param {string} botId
 */
export function transferAiSeat(lobby, room, applicantId, botId) {
  const m = room.match;
  const session = lobby.registry.byId(applicantId);
  const spectator = room.spectatorOf(applicantId);
  const ps = m?.players?.get(botId);
  const seat = room.seatOf(botId);
  if (!session?.connected || !session.ws || !spectator || !ps?.isBot || ps.left || !ps.alive || !seat
    || m.phase !== 'PREP' || m.ended || m.disposed) return fail('AI handover unavailable');
  if (room.modded || m.hosted) return fail('AI handover is unavailable in isolated plugin matches');
  if (lobby.registry.byId(botId)) return fail('AI seat already has a session');
  const conn = lobby.network.conns.get(session.ws);
  if (!conn || conn.closing) return fail('connection unavailable');
  lobby.removeMember(room, applicantId); // frees the spectator seat (and tells the match)
  lobby.clearResync(applicantId);
  lobby.registry.byPlayerId.delete(applicantId);
  session.playerId = botId;
  lobby.registry.byPlayerId.set(botId, session);
  session.roomCode = room.code;
  session.notice = null;
  session.pendingResult = null;
  session.resyncAt = -Infinity;
  // the AI's rehearsal script (server/match/match/botPrep.js) must not drive this seat any more
  ps._botPrepToken = (ps._botPrepToken || 0) + 1;
  Object.assign(ps, { isBot: false, autoplay: false, connected: true, ready: false, name: session.name });
  Object.assign(seat, { isBot: false, connected: true, left: false, ready: false, name: session.name });
  m.loneHuman = m.order.filter((p) => !p.isBot && !p.left).length === 1;
  session.aiTakeoverFrom = applicantId;
  m.markPublic();
  ps.dirty();
  // the same socket says hello again: it gets `welcome` (with takeoverFrom) and the ordinary resync of room + match
  lobby.network.onHelloMsg(conn, { t: 'hello', version: 1, name: session.name, token: session.token }, Date.now());
  lobby.broadcastState(room);
  return { ok: true };
}

/**
 * `room.aiRequest { botId }` / `room.aiVote { voteId, approve }`.
 * @param {any} lobby @param {any} session @param {any} msg
 */
export function aiTakeover(lobby, session, msg) {
  const room = lobby.roomOf(session);
  const m = room?.match;
  if (!room || !m || m.hosted || room.modded || m.phase !== 'PREP' || m.ended || m.disposed) {
    return fail('AI handover requires preparation in an original-content match');
  }
  let votes = pending.get(room);
  if (!votes) pending.set(room, votes = new Map());
  // forget what cannot be acted on any more: another match, an expired request, an applicant who left
  for (const [id, v] of votes) {
    if (v.match !== m || v.expiresAt <= Date.now() || !room.spectatorOf(v.applicantId)) votes.delete(id);
  }
  const sync = () => {
    room.aiTakeoverVotes = [...votes.values()].map((v) => ({
      id: v.id,
      applicantId: v.applicantId,
      applicantName: v.applicantName,
      botId: v.botId,
      expiresAt: v.expiresAt,
      eligible: takeoverVoters(room, v.botId),
      yes: [...v.yes],
      no: [...v.no],
    }));
    lobby.broadcastState(room);
  };

  if (msg.t === 'room.aiRequest') {
    const bot = m.players.get(msg.botId);
    if (!room.spectatorOf(session.playerId) || !session.connected || !bot?.isBot || bot.left || !bot.alive) {
      return fail('a spectator must select an active AI');
    }
    if ([...votes.values()].some((v) => v.applicantId === session.playerId || v.botId === msg.botId)) {
      return fail('request already pending');
    }
    const id = String(room.aiTakeoverSeq = (room.aiTakeoverSeq || 0) + 1);
    const vote = {
      id,
      applicantId: session.playerId,
      applicantName: session.name,
      botId: msg.botId,
      match: m,
      expiresAt: Date.now() + REQUEST_TTL,
      yes: new Set(),
      no: new Set(),
    };
    votes.set(id, vote);
    const timer = setTimeout(() => {
      if (votes.get(id) !== vote) return;
      votes.delete(id);
      sync();
    }, REQUEST_TTL);
    vote.timer = timer;
    timer.unref?.();
    sync();
    return { ok: true };
  }

  const vote = votes.get(msg.voteId);
  if (!vote || vote.match !== m || Date.now() >= vote.expiresAt) return fail('request expired');
  const eligible = takeoverVoters(room, vote.botId);
  if (!eligible.includes(session.playerId)) return fail('only online human teammates can vote');
  (msg.approve ? vote.no : vote.yes).delete(session.playerId);
  (msg.approve ? vote.yes : vote.no).add(session.playerId);
  const need = Math.floor(eligible.length / 2) + 1;
  if (eligible.filter((id) => vote.no.has(id)).length >= need) {
    votes.delete(vote.id);
    clearTimeout(vote.timer);
    sync();
    return { ok: true };
  }
  if (eligible.filter((id) => vote.yes.has(id)).length >= need) {
    votes.delete(vote.id);
    clearTimeout(vote.timer);
    const result = transferAiSeat(lobby, room, vote.applicantId, vote.botId);
    sync();
    return result;
  }
  sync();
  return { ok: true };
}
