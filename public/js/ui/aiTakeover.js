// 「AI 协作」面板（server/aiTakeover.js；docs/PLAYING.md 的同一节）: during PREP, a spectator asks for an AI seat and the
// online, non-autoplay human teammates of the group vote; the request lives 30 s and a rejected request closes at once.
// The entry sits in the match screen's corner beside the gear buttons, so a player also opens it to vote.
//
// What the server does on approval is written in server/aiTakeover.js: the seat keeps the AI's funds, lineup and
// inventory; the applicant's own session token is rebound and the client reloads the seat through the ordinary resync.

import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal } from './components.js';
import { useStore } from '../store.js';
import { net } from '../net.js';
import { toastError } from './toasts.js';
import { t } from '../../../shared/i18n.js';

export function AiTakeoverPanel() {
  const room = useStore((s) => s.room);
  const pub = useStore((s) => s.match.public);
  const myId = useStore((s) => s.me.playerId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // solo rooms have no teammates to vote, and a gameplay-plugin room owns its seats (server/aiTakeover.js refuses both)
  if (!room || room.mode === 'solo' || (room.content && room.content.vanilla === false)) return null;
  const run = async (kind, body) => {
    if (busy) return;
    setBusy(true);
    try { await net.request(kind, body); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const spectator = !!room.spectators?.some((s) => s.playerId === myId);
  const prep = pub?.phase === 'PREP';
  const requests = room.aiTakeoverVotes || [];
  const bots = (pub?.players || []).filter((p) => p.isBot && p.alive && !p.left);
  const nameOf = (id) => (pub?.players || []).find((p) => p.playerId === id)?.name || id;
  return html`<button type="button" class="btn btn--secondary btn--sm ai-participation-entry"
      title=${t('观战者申请接替AI，同组在线真人过半同意后在休整期加入；同组无真人时由房主决定。')}
      onClick=${() => setOpen(true)}>${t('AI 协作')}${requests.length ? ` (${requests.length})` : ''}</button>
    <${Modal} open=${open} onClose=${() => setOpen(false)} title=${t('AI 协作')} width="min(46rem, 92vw)"
      actions=${html`<${Button} onClick=${() => setOpen(false)}>${t('关闭')}<//>`}>
      <p class="ai-hint">${t('观战者申请接替AI，同组在线真人过半同意后在休整期加入；同组无真人时由房主决定。')}</p>
      ${spectator && prep && bots.length ? html`<div class="ai-requests">${bots.map((p) => html`
        <${Button} size="sm" variant="ghost"
          disabled=${busy || requests.some((v) => v.botId === p.playerId || v.applicantId === myId)}
          onClick=${() => run('room.aiRequest', { botId: p.playerId })}>${t('申请接替')} P${p.seat + 1} · ${p.name}<//>`)}</div>` : null}
      ${requests.length ? html`<div class="ai-votes">${requests.map((v) => {
        const need = Math.floor(v.eligible.length / 2) + 1;
        const yes = v.yes.filter((id) => v.eligible.includes(id)).length;
        const no = v.no.filter((id) => v.eligible.includes(id)).length;
        return html`<div class="ai-vote">
          <strong>${v.applicantName} → ${nameOf(v.botId)}</strong>
          <span class="ai-vote__count">${yes}/${need}${no ? ` · ${t('不同意')} ${no}` : ''}</span>
          ${v.eligible.includes(myId) ? html`
            <${Button} size="sm" disabled=${busy || !prep} onClick=${() => run('room.aiVote', { voteId: v.id, approve: true })}>${t('同意')}<//>
            <${Button} size="sm" variant="danger" disabled=${busy || !prep} onClick=${() => run('room.aiVote', { voteId: v.id, approve: false })}>${t('不同意')}<//>` : null}
        </div>`;
      })}</div>` : html`<p class="ai-empty">${t('暂无投票')}</p>`}
    <//>`;
}
