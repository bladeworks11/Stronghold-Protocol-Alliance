// test/ui/emote-bubble-fit.e2e.test.js — the emote bubble of the LEFT TEAM PANEL must not be clipped when the roster
// scrolls.
//
// Why this file exists (owner report 2026-10-12): a bubble is a fixed 1.08rem official sprite anchored just past a
// row's right edge. The team panel scrolls once a room has more rows than fit the screen, and an element with
// `overflow-y: auto` forces `overflow-x` to auto — so the bubble landed OUTSIDE the panel's scroll box, was clipped,
// and showed up as a horizontal scrollbar in game. The panel therefore keeps its overflow on an inner `.team__scroll`
// wrapper and reserves `.team__scroll { padding-right }` for the bubble.
//
// The existing test/ui/emotes.e2e.test.js checks the bubble's geometry in a FOUR-seat mock, which never scrolls — it
// passed even while the bug was live. This one drives a roster large enough to scroll and asserts the thing that broke:
// no horizontal overflow, and every bubble fully inside the scroll box.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/index.js';

// this file lives in test/ui/, so the repository root is three levels up (…/game)
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const HAS_ART = existsSync(path.join(ROOT, 'public/assets/local/emoticon/fooldoctor'));
const OUT = path.join(ROOT, 'test', 'artifacts');

describe('the team panel emote bubble survives a scrolling roster', { skip: !ENABLED && 'set SP_E2E=1 and CHROME_PATH to run' }, () => {
  let browser = null;
  let srv = null;
  let puppeteer = null;
  before(async () => {
    puppeteer = (await import('puppeteer-core')).default;
    mkdirSync(OUT, { recursive: true });
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
  });
  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  test('20-seat roster: no horizontal overflow, every bubble inside the scroll box', { skip: !HAS_ART && 'no official emote art' }, async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(`http://127.0.0.1:${srv.port}/dev/game-mock.html?shot=1&render=fallback&phase=PREP&variant=emote`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!globalThis.__MOCK__ && !!document.querySelector('.screen:not(.gload)'), { timeout: 15000 });
    await page.waitForSelector('.team__row');

    // Grow the roster to a full twenty-seat room. The longest allowed name (NAME_MAX_LEN = 12) is used on purpose: a
    // wider row pushes the bubble further right, which is the worst case for this layout.
    await page.evaluate(() => {
      const M = globalThis.__MOCK__;
      M.mutate((S) => {
        const extra = [];
        for (let i = S.pub.players.length; i < 20; i++) {
          extra.push({
            playerId: `x${i}`, seat: i, name: 'WWWWWWWWWWWW', isBot: i % 2 === 1, bandId: 'band_bldsk',
            alive: true, lp: 20 - i, boardCount: 3, bonds: [], status: 'acting', connected: true, autoplay: false,
          });
        }
        S.pub.players.push(...extra);
      });
      M.pushPublic();
    });
    await page.waitForFunction(() => document.querySelectorAll('.team__row').length >= 20, { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 1200));

    const report = await page.evaluate(() => {
      const panel = document.querySelector('.team');
      const scroll = document.querySelector('.team__scroll');
      if (!scroll) throw new Error('the .team__scroll wrapper is missing');
      const sb = scroll.getBoundingClientRect();
      const bubbles = [...document.querySelectorAll('.team__row')]
        .filter((r) => r.querySelector('.team__bubble'))
        .map((r) => {
          const b = r.querySelector('.team__bubble').getBoundingClientRect();
          return {
            width: Math.round(b.width),
            insideBox: b.left >= sb.left - 1 && b.right <= sb.right + 1,
            pastRight: Math.round(b.right - sb.right),
          };
        });
      return {
        rows: document.querySelectorAll('.team__row').length,
        // the SCROLLER must own the overflow; the panel itself must stay `visible` or an overflow-y:auto on it would
        // force overflow-x to auto and clip the bubble again
        panelOverflowY: panel ? getComputedStyle(panel).overflowY : null,
        scrollOverflowY: getComputedStyle(scroll).overflowY,
        scrollWidth: scroll.scrollWidth,
        clientWidth: scroll.clientWidth,
        verticalScrollable: scroll.scrollHeight > scroll.clientHeight + 1,
        bubbles,
      };
    });

    assert.equal(report.rows, 20, 'a twenty-seat roster is rendered');
    assert.equal(report.panelOverflowY, 'visible', '.team itself must NOT scroll (it would clip the bubble horizontally)');
    assert.equal(report.scrollOverflowY, 'auto', 'the inner wrapper is the scroller');
    assert.ok(report.verticalScrollable, 'a twenty-seat roster can be scrolled');
    assert.ok(report.scrollWidth <= report.clientWidth + 1, `no horizontal overflow (${report.scrollWidth} <= ${report.clientWidth})`);
    assert.ok(report.bubbles.length >= 1, 'at least one emote bubble is on screen');
    for (const b of report.bubbles) {
      assert.ok(b.insideBox, `bubble fully inside the scroll box (past right edge by ${b.pastRight}px)`);
      assert.ok(b.width > 40, `a real emote bubble (width ${b.width})`);
    }
    await page.screenshot({ path: path.join(OUT, 'emote-bubble-20p.png') });
    await page.close();
  });
});
