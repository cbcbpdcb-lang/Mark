// 用 Playwright 打开产品页面，在页面里调用产品自己的函数（PRESETS、evaluate 等），不改浏览器端代码。
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');
export const INTERNAL_PAGE = join(REPO, 'index.html');          // 内部版：真实品牌名
export const PUBLIC_APP_PAGE = join(REPO, 'dist', 'app', 'index.html');   // build_public.py 生成的公开版 /app/

const HINT = '需要 Playwright：在 experiments/rag_eval 里运行 npm install，再运行 npx playwright install chromium';

// 先找本目录 npm install 装的 playwright，找不到再找全局安装的
export async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {}
  try {
    const root = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return createRequire(join(root, 'noop.js'))('playwright').chromium;
  } catch {}
  throw new Error(HINT);
}

export async function launch() {
  const chromium = await loadChromium();
  const opts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
  try {
    return await chromium.launch(opts);
  } catch (e) {
    throw new Error(`Chromium 启动失败：${String(e.message).split('\n')[0]}\n${HINT}`);
  }
}

// 打开一个产品页面：清掉浏览器里保存的状态，切到品牌 A（direct_a）预设
export async function openApp(browser, file) {
  if (!existsSync(file)) throw new Error(`找不到 ${file}`);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(file).href);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('echorank-welcome-seen', '1'); });
  await page.reload();
  await page.waitForFunction(() => typeof evaluate === 'function' && typeof PRESETS === 'object' && PRESETS.direct_a);
  await page.evaluate(() => applyPreset('direct_a'));
  if (errors.length) throw new Error(`页面脚本出错：${errors.join(' | ')}`);
  return page;
}
