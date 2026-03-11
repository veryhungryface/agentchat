import { generate, generateJSON } from '../../llm.js';
import { chromium } from 'playwright';

const VIEWPORT = { width: 1280, height: 800 };
const JPEG_QUALITY = 55;

const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
`;

async function snap(page, label, cb) {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY });
    cb?.({ image: buf.toString('base64'), label });
  } catch { /* skip */ }
}

/** Take periodic screenshots during long waits */
async function snapWait(page, label, ms, cb, interval = 1500) {
  let elapsed = 0;
  while (elapsed < ms) {
    const wait = Math.min(interval, ms - elapsed);
    await page.waitForTimeout(wait);
    elapsed += wait;
    await snap(page, label, cb);
  }
}

/** Take a screenshot after page settles (load + short wait) */
async function snapAfterLoad(page, label, cb) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, label, cb);
}

/**
 * Run an async function (typically an LLM call) while periodically taking screenshots.
 * This prevents long gaps in the screenshot stream during 5-15s LLM calls.
 */
async function withSnapshots(page, label, cb, asyncFn, interval = 2000) {
  let done = false;
  const loop = (async () => {
    while (!done) {
      await page.waitForTimeout(interval).catch(() => {});
      if (!done) await snap(page, label, cb);
    }
  })();
  try {
    const result = await asyncFn();
    done = true;
    await loop.catch(() => {});
    return result;
  } catch (err) {
    done = true;
    await loop.catch(() => {});
    throw err;
  }
}

/**
 * Extract a simplified view of the page for LLM decision-making.
 */
async function getPageContext(page) {
  return page.evaluate(() => {
    const url = location.href;
    const title = document.title;

    // Gather interactive elements
    const els = [];
    document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick]').forEach((el, i) => {
      if (i >= 60) return;
      const tag = el.tagName.toLowerCase();
      const text = (el.textContent || '').trim().slice(0, 80);
      const placeholder = el.getAttribute('placeholder') || '';
      const type = el.getAttribute('type') || '';
      const name = el.getAttribute('name') || '';
      const href = el.getAttribute('href') || '';
      const id = el.getAttribute('id') || '';
      const cls = el.getAttribute('class')?.split(' ').slice(0, 3).join(' ') || '';
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      let selector = tag;
      if (id) selector = `#${id}`;
      else if (name) selector = `${tag}[name="${name}"]`;
      else if (type && tag === 'input') selector = `input[type="${type}"]`;
      else if (placeholder) selector = `${tag}[placeholder="${placeholder}"]`;

      els.push({ tag, text: text.slice(0, 50), type, name, placeholder, href: href.slice(0, 100), selector, cls });
    });

    // Visible text summary
    const bodyText = (document.body?.innerText || '').slice(0, 2000);

    return { url, title, elements: els, bodyText };
  });
}

/**
 * Browser automation agent — navigates sites, interacts, extracts data.
 */
export async function runBrowserAgent(messages, model, onScreenshot) {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  // Step 1: Generate a browsing plan
  onScreenshot?.({ image: '', label: '🧠 브라우징 계획 생성 중...' });
  const plan = await generateJSON(model, [
    { role: 'user', content: lastUserMsg },
  ], {
    system: `You are a browser automation planner. Given a user request, generate a JSON plan for browser automation.

Response format:
{
  "url": "starting URL (best guess, e.g. https://www.coupang.com for 쿠팡)",
  "goal": "brief description of what to achieve",
  "steps": [
    { "action": "goto", "url": "..." },
    { "action": "search", "query": "search term to type" },
    { "action": "login", "id": "username", "pw": "password" },
    { "action": "click", "target": "description of what to click" },
    { "action": "extract", "what": "description of data to extract" },
    { "action": "scroll", "direction": "down" },
    { "action": "wait", "ms": 2000 }
  ]
}

Rules:
- For shopping sites (쿠팡, 11번가, etc.), start with the site URL and use their search.
- For login requests, include the login step with credentials from the message.
- Keep steps minimal (3-8 steps). Don't over-plan.
- For search on a site: goto → search → extract
- For login+test: goto → login → click menus → extract`,
    temperature: 0.3,
    maxTokens: 800,
  });
  onScreenshot?.({ image: '', label: '🧠 계획 생성 완료' });

  console.log('[browser] Plan:', JSON.stringify(plan, null, 2));

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

  // Listen for popup windows (login popups, OAuth, etc.)
  context.on('page', async (newPage) => {
    console.log('[browser] New popup/tab detected:', newPage.url());
    await newPage.addInitScript(STEALTH_SCRIPT);
  });

  // Capture console errors
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const results = [];
  let usedGoogleFallback = false;

  try {
    // Step 2: Navigate to starting URL
    const startUrl = plan.url || 'https://www.google.com';
    onScreenshot?.({ image: '', label: `🌐 ${startUrl} 접속 중...` });

    let blocked = false;
    try {
      const resp = await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
      await snap(page, `🌐 ${startUrl} 로딩 중...`, onScreenshot);
      await page.waitForTimeout(1500);
      blocked = (resp && (resp.status() === 403 || resp.status() === 401)) ||
        await page.evaluate(() => /access denied|403 forbidden|you don't have permission/i.test(document.body?.innerText?.slice(0, 500) || ''));
    } catch {
      blocked = true;
    }

    if (blocked) {
      // Fallback: search via Google with site: prefix
      const domain = new URL(startUrl).hostname.replace('www.', '');
      const searchQuery = (plan.steps || []).find((s) => s.action === 'search')?.query || plan.goal || '';
      const googleQuery = `site:${domain} ${searchQuery}`;
      onScreenshot?.({ image: '', label: `🔄 ${domain} 직접 접속 차단됨 — Google 검색으로 전환` });
      await page.goto(`https://www.google.com/search?hl=ko&q=${encodeURIComponent(googleQuery)}`, {
        waitUntil: 'domcontentloaded', timeout: 10000,
      });
      await snap(page, `🔍 Google 검색 로딩...`, onScreenshot);
      await page.waitForTimeout(1500);
      await snap(page, `🔍 Google에서 "${googleQuery}" 검색`, onScreenshot);
      usedGoogleFallback = true;

      // Extract Google results and visit first accessible one
      const googleResults = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('#search h3').forEach((h3) => {
          if (items.length >= 5) return;
          const a = h3.closest('a') || h3.parentElement?.querySelector('a[href^="http"]');
          if (!a) return;
          const s = h3.closest('[data-hveid]')?.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"]');
          items.push({ title: h3.textContent?.trim() || '', url: a.href || '', snippet: s?.textContent?.trim() || '' });
        });
        return items;
      });

      // Try visiting first Google result
      for (const gr of googleResults.slice(0, 3)) {
        try {
          const r = await page.goto(gr.url, { waitUntil: 'domcontentloaded', timeout: 8000 });
          if (r && (r.status() === 403 || r.status() === 401)) continue;
          await page.waitForTimeout(1500);
          const stillBlocked = await page.evaluate(() => /access denied|403 forbidden/i.test(document.body?.innerText?.slice(0, 500) || ''));
          if (stillBlocked) continue;
          await snap(page, `📖 "${gr.title.slice(0, 40)}" 열람`, onScreenshot);
          break;
        } catch { /* next */ }
      }

      // Extract data from wherever we ended up
      await snap(page, '📋 페이지 데이터 분석 중...', onScreenshot);
      const data = await withSnapshots(page, '📋 데이터 분석 중...', onScreenshot,
        () => extractPageData(page, plan.goal || '', model));
      results.push(data);
      await snap(page, '✅ 정보 수집 완료', onScreenshot);
    } else {
      await snap(page, `🌐 ${page.title() || startUrl} 로드 완료`, onScreenshot);
    }

    // Step 3: Execute planned steps (skip if we used Google fallback)
    const steps = usedGoogleFallback ? [] : (plan.steps || []);
    for (const step of steps) {
      try {
        if (step.action === 'goto' && step.url) {
          onScreenshot?.({ image: '', label: `🌐 ${step.url} 이동 중...` });
          await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await snap(page, `🌐 ${step.url} 로딩 중...`, onScreenshot);
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(800);
          await snap(page, `🌐 ${step.url} 로드 완료`, onScreenshot);

        } else if (step.action === 'search' && step.query) {
          onScreenshot?.({ image: '', label: `🔍 "${step.query}" 검색 중...` });
          const searchInput = await findSearchInput(page);
          if (searchInput) {
            await searchInput.fill('');
            await searchInput.fill(step.query);
            await snap(page, `🔍 "${step.query}" 입력`, onScreenshot);
            await page.waitForTimeout(300);
            await searchInput.press('Enter');
            await snap(page, `🔍 검색 요청 전송...`, onScreenshot);
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(1500);
            await snap(page, `🔍 "${step.query}" 검색 결과`, onScreenshot);
          } else {
            const curUrl = page.url();
            const searchUrl = `${curUrl}${curUrl.includes('?') ? '&' : '?'}q=${encodeURIComponent(step.query)}`;
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
            await snap(page, `🔍 검색 결과 로딩...`, onScreenshot);
            await page.waitForTimeout(1500);
            await snap(page, `🔍 "${step.query}" 검색 결과`, onScreenshot);
          }

        } else if (step.action === 'login') {
          await handleLogin(page, step, onScreenshot);

        } else if (step.action === 'click' && step.target) {
          onScreenshot?.({ image: '', label: `👆 "${step.target}" 클릭 중...` });
          await handleClick(page, step.target, model, onScreenshot);

        } else if (step.action === 'scroll') {
          await page.evaluate(() => window.scrollBy(0, 600));
          await page.waitForTimeout(600);
          await snap(page, '📜 스크롤 완료', onScreenshot);

        } else if (step.action === 'wait') {
          await snapWait(page, '⏳ 대기 중...', step.ms || 1500, onScreenshot, 1500);

        } else if (step.action === 'extract') {
          await snap(page, '📋 데이터 추출 중...', onScreenshot);
          const extracted = await withSnapshots(page, '📋 데이터 추출 중...', onScreenshot,
            () => extractPageData(page, step.what || plan.goal, model));
          results.push(extracted);
          await snap(page, '📋 데이터 추출 완료', onScreenshot);
        }
      } catch (err) {
        console.log(`[browser] Step "${step.action}" failed: ${err.message}`);
        await snap(page, `⚠️ ${step.action} 실패 — 계속 진행`, onScreenshot);
      }
    }

    // Step 4: Always extract final page data
    if (results.length === 0) {
      await snap(page, '📋 페이지 데이터 분석 중...', onScreenshot);
      const finalData = await withSnapshots(page, '📋 최종 데이터 분석 중...', onScreenshot,
        () => extractPageData(page, plan.goal || lastUserMsg, model));
      results.push(finalData);
      await snap(page, '✅ 정보 수집 완료', onScreenshot);
    }

  } catch (err) {
    console.error('[browser] Error:', err.message);
    await snap(page, `❌ 오류: ${err.message.slice(0, 60)}`, onScreenshot);
  } finally {
    await browser.close();
  }

  // Step 5: Compile results with LLM
  onScreenshot?.({ image: '', label: '🧠 수집 데이터 분석 중...' });
  const pageData = results.join('\n\n---\n\n');
  const errorLog = consoleErrors.length > 0 ? `\n\nConsole errors:\n${consoleErrors.slice(0, 5).join('\n')}` : '';

  const analysis = await generate(model, [
    ...messages,
    { role: 'assistant', content: `I browsed ${plan.url || 'the web'} and collected the following data:\n\n${pageData}${errorLog}` },
    { role: 'user', content: 'Based on the browsing results above, provide a comprehensive answer to my original request. Format the data clearly. Respond in the same language as the user.' },
  ], {
    system: 'You are a browser automation specialist. Present the collected data clearly and completely. Use markdown tables for lists. Include URLs where relevant.',
    temperature: 0.5,
    maxTokens: 3000,
  });

  onScreenshot?.({ image: '', label: '✅ 분석 완료' });
  return analysis;
}

async function findSearchInput(page) {
  const selectors = [
    'input[type="search"]',
    'input[name="q"]',
    'input[name="query"]',
    'input[name="keyword"]',
    'input[name="search"]',
    'input[name="searchKeyword"]',
    'input[placeholder*="검색"]',
    'input[placeholder*="search" i]',
    'input[placeholder*="찾기"]',
    'input[id*="search" i]',
    'input[class*="search" i]',
    'input[type="text"]:visible',
  ];

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) return el;
    } catch { /* next */ }
  }
  return null;
}

async function handleLogin(page, step, onScreenshot) {
  const uid = step.id || '';
  const pw = step.pw || '';

  async function waitForSPA(p, ms = 3000) {
    await p.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
    await p.waitForTimeout(1500); // extra time for React/Next.js hydration
  }

  async function findLoginForm(p) {
    // Check multiple input types that could be login fields
    const pwSelectors = [
      'input[type="password"]',
      'input[name*="pass" i]', 'input[name*="pw" i]',
      'input[placeholder*="비밀번호"]', 'input[placeholder*="password" i]',
      'input[autocomplete="current-password"]',
    ];
    for (const sel of pwSelectors) {
      if (await p.locator(sel).first().isVisible({ timeout: 300 }).catch(() => false)) return true;
    }
    return false;
  }

  // Phase 0: Try navigating directly to common login URLs
  const currentUrl = page.url();
  const baseUrl = new URL(currentUrl).origin;
  let hasLoginForm = await findLoginForm(page);

  if (!hasLoginForm) {
    const loginPaths = ['/login', '/signin', '/auth/login', '/auth/signin', '/member/login', '/account/login'];
    for (const path of loginPaths) {
      try {
        const loginUrl = baseUrl + path;
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
        await waitForSPA(page);
        await snap(page, `🔐 ${loginUrl} 접속`, onScreenshot);
        hasLoginForm = await findLoginForm(page);
        if (hasLoginForm) {
          console.log('[browser] Login form found at:', loginUrl);
          break;
        }
      } catch { /* next */ }
    }
  }

  // Phase 1: If still no form, click login trigger and catch popup/modal/navigation
  if (!hasLoginForm) {
    await snap(page, '🔐 로그인 버튼 찾는 중...', onScreenshot);
    const loginTriggers = [
      'a:has-text("로그인")', 'button:has-text("로그인")',
      'a:has-text("Login")', 'button:has-text("Login")',
      'a:has-text("Sign in")', 'button:has-text("Sign in")',
      'a:has-text("log in")', 'button:has-text("log in")',
      'a[href*="login"]', 'a[href*="signin"]', 'a[href*="auth"]',
      '[class*="login" i]:not(form)', '[id*="login" i]:not(form)',
    ];

    for (const sel of loginTriggers) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          // Set up popup listener BEFORE clicking
          const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);

          await el.click();
          await snap(page, '🔐 로그인 버튼 클릭', onScreenshot);

          // Wait for popup (window.open)
          const popupPage = await popupPromise;
          if (popupPage) {
            console.log('[browser] Login popup caught:', popupPage.url());
            await popupPage.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
            await waitForSPA(popupPage);
            await snap(popupPage, `🔐 로그인 팝업: ${popupPage.url().slice(0, 60)}`, onScreenshot);

            if (await findLoginForm(popupPage)) {
              await fillAndSubmitLogin(popupPage, uid, pw, onScreenshot);
              // Wait for popup to close or main page to update
              await popupPage.waitForEvent('close', { timeout: 10000 }).catch(() => {});
              await page.waitForTimeout(2000);
              await snap(page, '🔐 로그인 처리 완료', onScreenshot);
              return;
            }
            // Popup opened but no login form — might be OAuth redirect, wait longer
            await popupPage.waitForTimeout(3000);
            await snap(popupPage, '🔐 팝업 페이지 대기 중...', onScreenshot);
            if (await findLoginForm(popupPage)) {
              await fillAndSubmitLogin(popupPage, uid, pw, onScreenshot);
              await popupPage.waitForEvent('close', { timeout: 10000 }).catch(() => {});
              await page.waitForTimeout(2000);
              await snap(page, '🔐 로그인 처리 완료', onScreenshot);
              return;
            }
          }

          // No popup — wait for modal/navigation
          await waitForSPA(page);
          await snap(page, '🔐 로그인 폼 로딩 대기', onScreenshot);
          break;
        }
      } catch { /* next */ }
    }

    // Also check any already-open pages (tabs) in case popup was missed
    const allPages = page.context().pages();
    for (const p of allPages) {
      if (p === page || p.url() === 'about:blank') continue;
      console.log('[browser] Found extra page:', p.url());
      await waitForSPA(p);
      await snap(p, `🔐 팝업 페이지 확인: ${p.url().slice(0, 50)}`, onScreenshot);
      if (await findLoginForm(p)) {
        await fillAndSubmitLogin(p, uid, pw, onScreenshot);
        await p.waitForEvent('close', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);
        await snap(page, '🔐 로그인 처리 완료', onScreenshot);
        return;
      }
    }

    // Check modals/dialogs on main page
    const modalSelectors = [
      '[role="dialog"]', '[class*="modal" i]', '[class*="dialog" i]',
      '[class*="popup" i]', '[class*="overlay" i]', '[class*="layer" i]',
      '[id*="modal" i]', '[id*="dialog" i]', '[id*="popup" i]',
    ];
    for (const sel of modalSelectors) {
      try {
        const modal = page.locator(sel).first();
        if (await modal.isVisible({ timeout: 300 })) {
          if (await modal.locator('input[type="password"], input[placeholder*="비밀번호"], input[name*="pass" i]').count() > 0) {
            console.log('[browser] Login modal detected:', sel);
            await snap(page, '🔐 로그인 모달 감지', onScreenshot);
            await fillAndSubmitLogin(page, uid, pw, onScreenshot, modal);
            return;
          }
        }
      } catch { /* next */ }
    }

    // Check iframes
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        if (await findLoginForm(frame)) {
          console.log('[browser] Login iframe detected:', frame.url());
          await snap(page, '🔐 로그인 iframe 감지', onScreenshot);
          await fillAndSubmitLoginInFrame(frame, uid, pw);
          await page.waitForTimeout(3000);
          await snap(page, '🔐 로그인 처리 완료', onScreenshot);
          return;
        }
      } catch { /* skip */ }
    }

    // Final check after all clicks/navigations
    hasLoginForm = await findLoginForm(page);
  }

  if (hasLoginForm) {
    await fillAndSubmitLogin(page, uid, pw, onScreenshot);
  } else {
    await snap(page, '⚠️ 로그인 폼을 찾을 수 없음 — 페이지 구조 캡처', onScreenshot);
    console.log('[browser] Login form not found. Current URL:', page.url());
    console.log('[browser] Page title:', await page.title());
  }
}

async function fillAndSubmitLogin(pageOrFrame, uid, pw, onScreenshot, container) {
  const scope = container || pageOrFrame;

  // Fill username: try specific selectors first, then any visible text input before password
  const userSelectors = [
    'input[name="username"]', 'input[name="email"]', 'input[name="id"]',
    'input[name="userId"]', 'input[name="user_id"]', 'input[name="login"]',
    'input[name="account"]', 'input[name="memberId"]',
    'input[type="email"]', 'input[type="text"][autocomplete*="user"]',
  ];

  let filled = false;
  for (const sel of userSelectors) {
    try {
      const el = scope.locator(sel).first();
      if (await el.isVisible({ timeout: 300 })) {
        await el.fill(uid);
        filled = true;
        break;
      }
    } catch { /* next */ }
  }

  // Fallback: find the text input that appears right before the password field
  if (!filled) {
    try {
      const allInputs = scope.locator('input:visible');
      const count = await allInputs.count();
      for (let i = 0; i < count; i++) {
        const type = await allInputs.nth(i).getAttribute('type') || 'text';
        if (type === 'text' || type === 'email' || type === 'tel') {
          await allInputs.nth(i).fill(uid);
          filled = true;
          break;
        }
      }
    } catch { /* skip */ }
  }

  // Fill password
  try {
    const pwEl = scope.locator('input[type="password"]').first();
    await pwEl.fill(pw);
  } catch { /* skip */ }

  await snap(pageOrFrame, '🔐 로그인 정보 입력', onScreenshot);

  // Submit
  const submitSelectors = [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("로그인")', 'button:has-text("Login")', 'button:has-text("Sign in")',
    'button:has-text("확인")', 'button:has-text("Log in")',
    'a:has-text("로그인")',
    '[class*="login" i][class*="btn" i]', '[class*="submit" i]',
  ];

  for (const sel of submitSelectors) {
    try {
      const el = scope.locator(sel).first();
      if (await el.isVisible({ timeout: 300 })) {
        await el.click();
        break;
      }
    } catch { /* next */ }
  }

  await snap(pageOrFrame, '🔐 로그인 제출 중...', onScreenshot);
  await pageOrFrame.waitForLoadState?.('domcontentloaded', { timeout: 8000 }).catch(() => {});
  await pageOrFrame.waitForLoadState?.('networkidle', { timeout: 5000 }).catch(() => {});
  await (pageOrFrame.waitForTimeout || (() => new Promise((r) => setTimeout(r, 3000))))(2000);
  await snap(pageOrFrame, '🔐 로그인 시도 완료', onScreenshot);
}

async function fillAndSubmitLoginInFrame(frame, uid, pw) {
  const userSelectors = [
    'input[name="username"]', 'input[name="email"]', 'input[name="id"]',
    'input[type="email"]', 'input[type="text"]',
  ];
  for (const sel of userSelectors) {
    try {
      const el = frame.locator(sel).first();
      if (await el.isVisible({ timeout: 300 })) {
        await el.fill(uid);
        break;
      }
    } catch { /* next */ }
  }
  try {
    await frame.locator('input[type="password"]').first().fill(pw);
  } catch { /* skip */ }
  const submitSels = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("로그인")', 'button:has-text("Login")'];
  for (const sel of submitSels) {
    try {
      const el = frame.locator(sel).first();
      if (await el.isVisible({ timeout: 300 })) {
        await el.click();
        break;
      }
    } catch { /* next */ }
  }
}

async function handleClick(page, target, model, onScreenshot) {
  await snap(page, `👆 "${target}" 찾는 중...`, onScreenshot);
  const ctx = await getPageContext(page);
  const result = await withSnapshots(page, `👆 "${target}" 분석 중...`, onScreenshot, () =>
    generateJSON(model, [
      { role: 'user', content: `On this page, I need to click: "${target}"\n\nPage title: ${ctx.title}\nAvailable elements:\n${ctx.elements.map((e, i) => `${i}. <${e.tag}> text="${e.text}" selector="${e.selector}" href="${e.href}"`).join('\n')}\n\nRespond with JSON: {"index": <element index to click>, "selector": "<CSS selector>"}` },
    ], { temperature: 0.1, maxTokens: 200 }));

  const selector = result.selector || `text=${target}`;
  try {
    await page.locator(selector).first().click({ timeout: 3000 });
  } catch {
    // Fallback: try text-based click
    await page.locator(`text=${target}`).first().click({ timeout: 3000 });
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await snap(page, `👆 "${target}" 클릭`, onScreenshot);
}

async function extractPageData(page, goal, model) {
  const ctx = await getPageContext(page);

  const extraction = await generate(model, [
    { role: 'user', content: `Extract data from this page to answer: "${goal}"\n\nPage URL: ${ctx.url}\nPage title: ${ctx.title}\nPage content:\n${ctx.bodyText}\n\nExtract and organize the relevant information. If there are product listings, include name, price, and URL for each item.` },
  ], {
    system: 'Extract and organize data from the web page. Be thorough. Use markdown format. Include all relevant items found on the page.',
    temperature: 0.3,
    maxTokens: 2000,
  });

  return extraction;
}
