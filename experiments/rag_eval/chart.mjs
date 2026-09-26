// A0 / B / C1 / C2 对比图：每个指标一组横条，画成 SVG，用 Playwright 截成 PNG（不需要额外的画图库）。
import { launch } from './browser.mjs';

const COLORS = { A0: '#9aa3ae', B: '#4c7ee8', C1: '#2a9d6f', C2: '#e0932b' };
const LOWER_IS_BETTER = new Set(['说错率', '待确认率', '编造率']);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function chartSVG(summary, { note = '' } = {}) {
  const apps = summary.map(s => s.app);
  const metrics = Object.keys(summary[0]?.rates || {});
  const W = 960, left = 210, right = 70, top = 96, barH = 14, gap = 4, groupGap = 22;
  const plotW = W - left - right;
  const groupH = apps.length * (barH + gap) - gap;
  const H = top + metrics.length * (groupH + groupGap) + 36;
  const x = v => left + v * plotW;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'PingFang SC','Noto Sans CJK SC','Microsoft YaHei','WenQuanYi Zen Hei',sans-serif">`);
  out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  out.push(`<text x="24" y="36" font-size="20" font-weight="600" fill="#1d1d1f">RAG 评测对比：${esc(apps.join(' / '))}</text>`);
  if (note) out.push(`<text x="24" y="60" font-size="12" fill="#6e6e73">${esc(note)}</text>`);
  // 图例
  let lx = W - right;
  for (const a of [...apps].reverse()) {
    lx -= 16 + a.length * 9 + 18;
    out.push(`<rect x="${lx}" y="26" width="12" height="12" rx="2" fill="${COLORS[a] || '#888'}"/><text x="${lx + 17}" y="37" font-size="13" fill="#1d1d1f">${esc(a)}</text>`);
  }
  // 网格
  const gridBottom = H - 36;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    out.push(`<line x1="${x(t)}" y1="${top - 10}" x2="${x(t)}" y2="${gridBottom}" stroke="${t === 0 ? '#c7c7cc' : '#ececf0'}"/>`);
    out.push(`<text x="${x(t)}" y="${gridBottom + 18}" font-size="11" fill="#8e8e93" text-anchor="middle">${t * 100}%</text>`);
  }
  metrics.forEach((m, gi) => {
    const y0 = top + gi * (groupH + groupGap);
    out.push(`<text x="${left - 14}" y="${y0 + groupH / 2}" font-size="14" fill="#1d1d1f" text-anchor="end">${esc(m)}</text>`);
    out.push(`<text x="${left - 14}" y="${y0 + groupH / 2 + 16}" font-size="11" fill="#8e8e93" text-anchor="end">${LOWER_IS_BETTER.has(m) ? '越低越好' : '越高越好'}</text>`);
    summary.forEach((s, ai) => {
      const y = y0 + ai * (barH + gap);
      const v = s.rates[m];
      if (v == null) {
        out.push(`<text x="${x(0) + 6}" y="${y + barH - 3}" font-size="11" fill="#8e8e93">${esc(s.app)} 无数据</text>`);
        return;
      }
      out.push(`<rect x="${x(0)}" y="${y}" width="${Math.max(1.5, v * plotW)}" height="${barH}" rx="2" fill="${COLORS[s.app] || '#888'}"/>`);
      out.push(`<text x="${x(v) + 6}" y="${y + barH - 3}" font-size="11" fill="#3a3a3c">${Math.round(v * 100)}%</text>`);
    });
  });
  out.push('</svg>');
  return out.join('\n');
}

export async function renderChart(summary, pngPath, opts = {}) {
  const svg = chartSVG(summary, opts);
  const browser = await launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 960, height: 600 } });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>${svg}</body></html>`);
    await page.locator('svg').screenshot({ path: pngPath });
  } finally {
    await browser.close();
  }
}
