// Browser check of the 同盟等待室 seat portraits (opt-in, ~40 s):
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/room-seat-fit.e2e.test.js
//
// The art box (.seat__art) is `flex: 1`, so a roster of two or more rows leaves it far shorter than the portrait frame
// inside it. The frame used to keep its design size (--av: 2.1rem, and even 1.4rem when compact) and the box's
// `overflow: hidden` then cut the portrait's head and feet off — a 16/20-seat room showed every operator cropped
// (user report, 2026-10-12: "这个界面每个人的头像显示不全"). screens/room.css now sizes the frame per row count
// (.seats--rows / .seats--tight, the class the room screen sets from the seat count) and the compact card drops the
// AI 队友 label so the portrait keeps the band to itself.
//
// The production component renders a synthetic room.state payload per size — no server match, no CSS override. The
// root scale (theme.css `html`: min(100vw / 19.2, 100svh / 10.8)) makes a 16:9-or-wider window the tightest case, so
// these two viewports cover the smallest art bands the layout can produce.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const OUT = fileURLToPath(new URL('../e2e/out/', import.meta.url));

/** A co-op room.state payload: seat 0 is the host (human), seats `occupied`.. are still empty. */
const roomState = (capacity, occupied = capacity) => ({
  code: 'TEST01', mode: 'coop', difficulty: 'NORMAL', capacity, hostId: 'p_0', aiPicksLast: false,
  seats: Array.from({ length: capacity }, (_, i) => (i < occupied ? {
    seat: i, playerId: i === 0 ? 'p_0' : `ai_${i}`, name: i === 0 ? 'bladeworks' : `AI·队友${i}`,
    isBot: i > 0, ready: i > 0, connected: true,
  } : null)),
  spectators: [],
});

describe('every seat portrait fits its art box', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv, browser, base;
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
    mkdirSync(OUT, { recursive: true });
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  for (const [width, height] of [[1600, 900], [1366, 768]]) for (const capacity of [4, 8, 10, 16, 20]) {
    test(`${capacity} seats at ${width}×${height}: every portrait is inside its art box`, async () => {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width, height });
        await page.goto(`${base}/`, { waitUntil: 'networkidle0', timeout: 60000 });
        await page.evaluate(async (room) => {
          const { render, h } = await import('/vendor/preact.module.js');
          const { RoomScreen } = await import('/js/screens/room.js');
          const { store } = await import('/js/store.js');
          store.set({ room, me: { playerId: 'p_0', name: 'bladeworks' }, connection: { status: 'online' } });
          render(h(RoomScreen, {}), document.getElementById('app'));
          await document.fonts.ready;
        }, roomState(capacity, capacity - 1));
        await page.waitForSelector('.seat__art .avatar', { timeout: 15000 });
        // the seats fade in one by one (seat-in, 60ms apart): wait before the screenshot, geometry is unaffected
        await new Promise((r) => setTimeout(r, 2400));
        await page.screenshot({ path: join(OUT, `room-seats-${capacity}-${width}.png`) });

        const { seats, rem } = await page.evaluate(() => ({
          rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
          seats: [...document.querySelectorAll('.seat')].map((seat) => {
            const art = seat.querySelector('.seat__art');
            const av = art && art.querySelector('.avatar');
            const rect = (e) => (e ? e.getBoundingClientRect() : null);
            const a = rect(art), r = rect(av), l = rect(art && art.querySelector('.seat__bot-label'));
            return {
              no: seat.querySelector('.seat__no')?.textContent ?? '',
              empty: seat.classList.contains('seat--empty'),
              art: a && { top: a.top, bottom: a.bottom, height: a.height },
              av: r && { top: r.top, bottom: r.bottom, width: r.width, height: r.height },
              label: l && l.height > 0 ? { top: l.top, bottom: l.bottom, height: l.height } : null,
            };
          }),
        }));

        assert.equal(seats.length, capacity, 'every seat rendered');
        assert.equal(seats[capacity - 1].empty, true, 'the last seat is the empty one');
        for (const s of seats) {
          if (s.empty) { assert.equal(s.av, null, `${s.no}: an empty seat shows the radar, not a portrait`); continue; }
          assert.ok(s.art && s.av, `${s.no}: a filled seat has a portrait`);
          const where = `${s.no} (art ${s.art.height.toFixed(1)}px, portrait ${(s.av.width / rem).toFixed(2)}rem)`;
          assert.ok(Math.abs(s.av.width - s.av.height) < 1, `${where}: the frame stays square`);
          assert.ok(s.av.top >= s.art.top - 0.6 && s.av.bottom <= s.art.bottom + 0.6,
            `${where}: the portrait is inside the art box (top ${s.av.top.toFixed(1)} vs ${s.art.top.toFixed(1)}, bottom ${s.av.bottom.toFixed(1)} vs ${s.art.bottom.toFixed(1)})`);
          assert.ok(s.av.width >= 0.9 * rem, `${where}: the portrait keeps a usable size`);
          if (s.label) assert.ok(s.label.top >= s.art.top - 0.6 && s.label.bottom <= s.art.bottom + 0.6,
            `${where}: the AI 队友 label is inside the art box too`);
        }
      } finally { await page.close(); }
    });
  }
});
