/**
 * Playwright-based web search with Google (+ Bing fallback).
 * Includes stealth measures and reCAPTCHA auto-click.
 */
import { chromium } from 'playwright';

const VIEWPORT = { width: 1024, height: 680 };
const JPEG_QUALITY = 55;

const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  const origQuery = window.navigator.permissions?.query;
  if (origQuery) {
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Reflect.apply(origQuery, window.navigator.permissions, [params]).state })
        : Reflect.apply(origQuery, window.navigator.permissions, [params]);
  }
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
`;

async function screenshot(page, label, cb) {
  try {
    const buf = await page.screenshot({
      type: 'jpeg',
      quality: JPEG_QUALITY,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
    });
    cb?.({ image: buf.toString('base64'), label });
  } catch { /* skip */ }
}

async function trySolveCaptcha(page, cb) {
  const hasCaptcha = await page.evaluate(() => {
    const text = document.body.innerText;
    return (
      text.includes('로봇이 아닙니다') ||
      text.includes('비정상적인 트래픽') ||
      text.includes('사람인지 확인') ||
      text.includes('not a robot') ||
      text.includes('unusual traffic') ||
      !!document.querySelector('iframe[src*="recaptcha"]') ||
      !!document.querySelector('iframe[src*="challenge"]')
    );
  });

  if (!hasCaptcha) return true;

  await screenshot(page, '🤖 캡차 감지 — 자동 클릭 시도 중...', cb);

  for (let attempt = 0; attempt < 3; attempt++) {
    const recaptchaFrame = page.frames().find(
      (f) => f.url().includes('recaptcha/api2/anchor') || f.url().includes('recaptcha/enterprise/anchor'),
    );

    if (recaptchaFrame) {
      try {
        const checkbox = recaptchaFrame.locator('#recaptcha-anchor, .recaptcha-checkbox-border');
        await checkbox.waitFor({ state: 'visible', timeout: 3000 });
        await checkbox.click({ delay: 100 + Math.random() * 200 });
        await page.waitForTimeout(2000 + Math.random() * 1000);

        const bframe = page.frames().find(
          (f) => f.url().includes('recaptcha/api2/bframe') || f.url().includes('recaptcha/enterprise/bframe'),
        );
        if (bframe) return false;

        const checked = await recaptchaFrame.evaluate(() => {
          const anchor = document.querySelector('#recaptcha-anchor');
          return anchor?.getAttribute('aria-checked') === 'true';
        }).catch(() => false);

        if (checked) {
          const submit = page.locator('#captcha-form input[type="submit"], #captcha-form button[type="submit"]');
          if (await submit.isVisible({ timeout: 1000 }).catch(() => false)) {
            await submit.click();
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
          }
          return true;
        }
      } catch { /* retry */ }
    }

    const cfFrame = page.frames().find(
      (f) => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'),
    );
    if (cfFrame) {
      try {
        await cfFrame.click('input[type="checkbox"], .cb-i, label', { timeout: 3000 });
        await page.waitForTimeout(3000);
      } catch { /* retry */ }
    }

    for (const sel of ['input[type="checkbox"]', 'button:has-text("확인")', 'button:has-text("Verify")', 'button:has-text("Continue")']) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          await el.click({ delay: 100 });
          await page.waitForTimeout(2000);
          break;
        }
      } catch { /* next */ }
    }

    const stillBlocked = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes('로봇이 아닙니다') || text.includes('비정상적인 트래픽') || text.includes('unusual traffic');
    });
    if (!stillBlocked) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function withBrowser(fn) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: 'ko-KR',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  await page.addInitScript(STEALTH_SCRIPT);

  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/**
 * Search the web using a real browser.
 * @param {string} query
 * @param {function} onScreenshot - callback({ image, label })
 * @returns {Promise<{ query, results, pageContent, source }>}
 */
export async function playwrightSearch(query, onScreenshot) {
  return withBrowser(async (page) => {
    onScreenshot?.({ image: '', label: `🔍 "${query}" 검색 시작...` });

    await page.goto('https://www.google.com/search?hl=ko&q=' + encodeURIComponent(query), {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });

    await screenshot(page, `🔍 "${query}" 검색 중...`, onScreenshot);

    const captchaPassed = await trySolveCaptcha(page, onScreenshot);

    if (!captchaPassed) {
      await screenshot(page, '🔄 Google 차단됨 — Bing으로 전환...', onScreenshot);
      await page.goto('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=ko', {
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      });
      await trySolveCaptcha(page, onScreenshot);
      await page.waitForSelector('#b_results', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1000);

      const results = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('#b_results .b_algo').forEach((el, i) => {
          if (i >= 5) return;
          const t = el.querySelector('h2 a');
          const s = el.querySelector('.b_caption p, .b_lineclamp2');
          if (t) items.push({
            title: t.textContent?.trim() || '',
            snippet: s?.textContent?.trim() || '',
            url: t.href || '',
          });
        });
        return items;
      });

      await screenshot(page, '✅ 검색 완료 (Bing)', onScreenshot);
      return { query, results, pageContent: '', source: 'bing.com (fallback)' };
    }

    await page.waitForSelector('#search', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);

    await screenshot(page, '📄 Google 검색 결과', onScreenshot);

    // h3-based selector (Google DOM 변경 대응)
    const results = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('#search h3').forEach((h3) => {
        if (items.length >= 5) return;
        const container = h3.closest('[data-hveid]') || h3.closest('.g') || h3.parentElement?.parentElement?.parentElement;
        if (!container) return;
        const a = container.querySelector('a[href^="http"]') || h3.closest('a');
        if (!a) return;
        const s = container.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"]');
        items.push({
          title: h3.textContent?.trim() || '',
          snippet: s?.textContent?.trim() || '',
          url: a.href || '',
        });
      });
      return items;
    });

    // Visit first accessible result (skip bot-blocking sites)
    const BLOCKED_DOMAINS = /coupang\.com|naver\.com|daum\.net|tistory\.com|instagram\.com|facebook\.com|twitter\.com|x\.com/i;
    const ACCESS_DENIED_RE = /access denied|403 forbidden|you don't have permission|비정상적인 접근/i;

    for (const result of results.slice(0, 3)) {
      if (!result.url || BLOCKED_DOMAINS.test(result.url)) continue;
      try {
        const resp = await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 8000 });
        if (resp && (resp.status() === 403 || resp.status() === 401)) continue;

        await page.waitForTimeout(1500);

        const isBlocked = await page.evaluate((re) => new RegExp(re).test((document.title + ' ' + (document.body?.innerText || '').slice(0, 500))), ACCESS_DENIED_RE.source);
        if (isBlocked) continue;

        await screenshot(page, `📖 "${result.title.slice(0, 40)}" 열람 중...`, onScreenshot);

        const pageContent = await page.evaluate(() => {
          const el = document.querySelector('article') || document.querySelector('main') || document.querySelector('.content') || document.body;
          return (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 3000);
        });

        await screenshot(page, '✅ 정보 수집 완료', onScreenshot);
        return { query, results, pageContent, source: result.url };
      } catch { /* try next */ }
    }

    await screenshot(page, '✅ 검색 완료', onScreenshot);
    return { query, results, pageContent: '', source: 'google.com' };
  });
}
