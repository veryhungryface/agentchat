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

  // Capture console errors
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const results = [];

  try {
    // Step 2: Navigate to starting URL
    const startUrl = plan.url || 'https://www.google.com';
    onScreenshot?.({ image: '', label: `🌐 ${startUrl} 접속 중...` });
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
    await page.waitForTimeout(1500);
    await snap(page, `🌐 ${page.title() || startUrl} 로드 완료`, onScreenshot);

    // Step 3: Execute each planned step
    for (const step of (plan.steps || [])) {
      try {
        if (step.action === 'goto' && step.url) {
          await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await page.waitForTimeout(1000);
          await snap(page, `🌐 ${step.url} 이동`, onScreenshot);

        } else if (step.action === 'search' && step.query) {
          // Find search input adaptively
          const searchInput = await findSearchInput(page);
          if (searchInput) {
            await searchInput.fill('');
            await searchInput.fill(step.query);
            await page.waitForTimeout(300);
            await searchInput.press('Enter');
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(2000);
            await snap(page, `🔍 "${step.query}" 검색 완료`, onScreenshot);
          } else {
            // Fallback: try URL-based search
            const currentUrl = page.url();
            const searchUrl = `${currentUrl}${currentUrl.includes('?') ? '&' : '?'}q=${encodeURIComponent(step.query)}`;
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
            await page.waitForTimeout(2000);
            await snap(page, `🔍 "${step.query}" URL 검색`, onScreenshot);
          }

        } else if (step.action === 'login') {
          await handleLogin(page, step, onScreenshot);

        } else if (step.action === 'click' && step.target) {
          await handleClick(page, step.target, model, onScreenshot);

        } else if (step.action === 'scroll') {
          await page.evaluate(() => window.scrollBy(0, 600));
          await page.waitForTimeout(800);
          await snap(page, '📜 스크롤', onScreenshot);

        } else if (step.action === 'wait') {
          await page.waitForTimeout(step.ms || 1500);

        } else if (step.action === 'extract') {
          const extracted = await extractPageData(page, step.what || plan.goal, model);
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
      const finalData = await extractPageData(page, plan.goal || lastUserMsg, model);
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
  // Find and fill username
  const userSelectors = ['input[name="username"]', 'input[name="email"]', 'input[name="id"]', 'input[name="userId"]', 'input[type="email"]', 'input[type="text"]'];
  for (const sel of userSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.fill(step.id || '');
        break;
      }
    } catch { /* next */ }
  }

  // Find and fill password
  const pwEl = page.locator('input[type="password"]').first();
  if (await pwEl.isVisible({ timeout: 500 }).catch(() => false)) {
    await pwEl.fill(step.pw || '');
  }

  await snap(page, '🔐 로그인 정보 입력', onScreenshot);

  // Click login button
  const loginBtnSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("로그인")', 'button:has-text("Login")', 'button:has-text("Sign in")'];
  for (const sel of loginBtnSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click();
        break;
      }
    } catch { /* next */ }
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await snap(page, '🔐 로그인 시도 완료', onScreenshot);
}

async function handleClick(page, target, model, onScreenshot) {
  // Use LLM to find the right selector based on page context
  const ctx = await getPageContext(page);
  const result = await generateJSON(model, [
    { role: 'user', content: `On this page, I need to click: "${target}"\n\nPage title: ${ctx.title}\nAvailable elements:\n${ctx.elements.map((e, i) => `${i}. <${e.tag}> text="${e.text}" selector="${e.selector}" href="${e.href}"`).join('\n')}\n\nRespond with JSON: {"index": <element index to click>, "selector": "<CSS selector>"}` },
  ], { temperature: 0.1, maxTokens: 200 });

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
