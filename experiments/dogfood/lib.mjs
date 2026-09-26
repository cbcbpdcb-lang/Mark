// 监测脚本共用的函数：读配置、找链接、判定说对 / 说错 / 未提及、写 CSV。
// 只用 Node 自带模块，不需要安装依赖。

import { readFileSync } from 'node:fs';

export const SITE_HOST = 'echorank.markjcai.com';

export function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// 日期按北京时间算，同一天跑几次都落在同一个文件名上
export function todayCN(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(d);
}

// ---------- 链接 ----------

const URL_RE = /https?:\/\/[^\s<>"'`，。；、）】》「」]+/g;
const BARE_SITE_RE = /(?<![\w./-])(?:www\.)?echorank\.markjcai\.com(?:\/[^\s<>"'`，。；、）】》]*)?/gi;

// 去掉句尾标点、Markdown 符号和不成对的右括号
function trimUrl(u) {
  for (;;) {
    const last = u.slice(-1);
    const unbalanced = last === ')' && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length;
    if (!/[.,;:!?*_\]}>]/.test(last) && !unbalanced) return u;
    u = u.slice(0, -1);
  }
}

// 回答原文里的链接，加上接口单独返回的参考链接，去重后按出现顺序
export function extractLinks(text, extra = []) {
  const out = [];
  const seen = new Set();
  const add = u => {
    if (!u) return;
    const k = u.replace(/\/$/, '').toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(u);
  };
  const s = String(text || '');
  for (const m of s.matchAll(URL_RE)) add(trimUrl(m[0]));
  // 回答里只写了域名、没写 https:// 的，也算提到官网
  for (const m of s.replace(URL_RE, ' ').matchAll(BARE_SITE_RE)) add(trimUrl(m[0]));
  for (const u of extra) add(u);
  return out;
}

export function hostOf(u) {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function citesSite(links) {
  return links.some(u => {
    const h = hostOf(u);
    return h === SITE_HOST || h.endsWith('.' + SITE_HOST);
  });
}

export function mentionsBrand(text, brandRe = /echo\s*rank/i) {
  return brandRe.test(String(text || ''));
}

// ---------- 判定 ----------

// 按句切分。域名里的英文句点不切，所以只按中文句读、问叹号和换行切
export function sentences(text) {
  return String(text || '')
    .split(/[。！？!?\n；;]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function compileFacts(factsDoc) {
  const neg = new RegExp(factsDoc.negation || '不|没|非|无|别');
  const brand = new RegExp(factsDoc.brand_match || 'echo\\s*rank', 'i');
  const facts = factsDoc.facts.map(f => ({
    ...f,
    matchRe: new RegExp(f.match, 'i'),
    wrongRe: f.wrong ? new RegExp(f.wrong, 'i') : null,
    unlessRe: f.wrong_unless ? new RegExp(f.wrong_unless, 'i') : null,
  }));
  return { facts, neg, brand, byId: new Map(facts.map(f => [f.claim_id, f])) };
}

// 命中位置往前 8 个字到命中结尾之间有否定词（“不是”“并不代写”“首次体检不收费”），就不算说错
function negated(sentence, m, neg) {
  const from = Math.max(0, m.index - 8);
  return neg.test(sentence.slice(from, m.index + m[0].length));
}

// 一条回答对照全部事实键：哪些说对了、哪些说错了（附原句）
export function judgeAnswer(answer, compiled) {
  const { facts, neg, brand } = compiled;
  const mentioned = brand.test(String(answer || ''));
  const right = [];
  const wrong = [];
  if (!mentioned) return { mentioned, right, wrong };
  const ss = sentences(answer);
  for (const f of facts) {
    const hit = ss.find(s => f.matchRe.test(s));
    if (hit) right.push({ claim_id: f.claim_id, sentence: hit });
    if (!f.wrongRe) continue;
    // wrong_needs_brand：按逗号再切成小句，只看点了 EchoRank 名的小句，
    // “EchoRank 和代运营不同，代运营靠批量发内容”不算 EchoRank 说错
    const units = f.wrong_needs_brand ? ss.flatMap(s => s.split(/[，,：:]+/)) : ss;
    for (const s of units) {
      if (f.wrong_needs_brand && !brand.test(s)) continue;
      if (f.unlessRe && f.unlessRe.test(s)) continue;
      const re = new RegExp(f.wrongRe.source, f.wrongRe.flags.includes('g') ? f.wrongRe.flags : f.wrongRe.flags + 'g');
      const bad = [...s.matchAll(re)].find(m => !negated(s, m, neg));
      if (bad) {
        wrong.push({ claim_id: f.claim_id, sentence: s, hit: bad[0] });
        break;
      }
    }
  }
  return { mentioned, right, wrong };
}

// 一条记录的结论：说错优先；否则这道题对应的事实键说到了就算说对；其余都是未提及
export function verdictFor(record, question, compiled) {
  const j = judgeAnswer(record.answer, compiled);
  const own = new Set(question?.facts || []);
  const ownRight = j.right.filter(r => own.has(r.claim_id));
  let verdict = '未提及';
  if (j.wrong.length) verdict = '说错';
  else if (ownRight.length) verdict = '说对';
  const keyRight = ownRight.some(r => compiled.byId.get(r.claim_id)?.group === 'key');
  return { ...j, ownRight, verdict, keyRight: verdict === '说对' && keyRight };
}

// ---------- 统计 ----------

export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export const pct = (k, n) => (n ? Math.round((100 * k) / n) : 0);

// ---------- CSV ----------

function cell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 带 BOM，Excel 直接打开不乱码
export function toCSV(header, rows) {
  return '﻿' + [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
