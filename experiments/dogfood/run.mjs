#!/usr/bin/env node
// EchoRank 自我监测：用 questions.json 里的问题问 Kimi、通义千问、豆包、DeepSeek，每题每个模型问 2 次，
// 结果存成 results/YYYY-MM-DD.json，再用 score.mjs 打分。
//
// 用法（在仓库根目录）：
//   cp .env.example .env，填好密钥后 source .env
//   node experiments/dogfood/run.mjs --dry-run      只看计划，不调用接口
//   node experiments/dogfood/run.mjs                正式运行
//
// 选项：--only kimi,qwen   只跑这几家       --limit 3   只跑前 3 题
//       --repeats 2        每题问几次       --out 路径  另存文件      --force  覆盖已有文件

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { citesSite, extractLinks, mentionsBrand, readJSON, todayCN } from './lib.mjs';
import { authFailed, getProviders, retryable } from './providers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAUSE_MS = Number(process.env.DOGFOOD_PAUSE_MS ?? 1000);
const RETRY_WAIT_MS = Number(process.env.DOGFOOD_RETRY_WAIT_MS ?? 5000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    only: { type: 'string' },
    limit: { type: 'string' },
    repeats: { type: 'string', default: '2' },
    questions: { type: 'string', default: join(HERE, 'questions.json') },
    out: { type: 'string' },
    force: { type: 'boolean', default: false },
  },
});

const qdoc = readJSON(args.questions);
const questions = args.limit ? qdoc.questions.slice(0, Number(args.limit)) : qdoc.questions;
const repeats = Math.max(1, Number(args.repeats) || 2);
const date = todayCN();
const out = args.out || join(HERE, 'results', `${date}.json`);
const show = p => relative(process.cwd(), p) || p;

let providers = getProviders();
if (args.only) {
  const want = new Set(args.only.split(',').map(s => s.trim()).filter(Boolean));
  const unknown = [...want].filter(id => !providers.some(p => p.id === id));
  if (unknown.length) {
    console.error(`不认识的模型：${unknown.join('、')}。可选：${providers.map(p => p.id).join(', ')}`);
    process.exit(1);
  }
  providers = providers.filter(p => want.has(p.id));
}
const ready = providers.filter(p => !p.skip);
const skipped = providers.filter(p => p.skip).map(p => ({ model: p.id, reason: p.skip }));

console.log(`问题集 ${qdoc.version}：${questions.length} 题 × 每题 ${repeats} 次`);
for (const p of providers) {
  const state = p.skip ? `跳过：${p.skip}` : `${p.model} · ${p.search} · 密钥 ${p.keyName} 已设置`;
  console.log(`  ${p.label}：${state}`);
}
console.log(`计划调用 ${ready.length * questions.length * repeats} 次，结果写到 ${show(out)}`);

if (args['dry-run']) process.exit(0);

if (!ready.length) {
  console.error(`
没有可用的密钥，没有调用任何接口。请先设置环境变量（只放在本机，不要写进代码）：
  KIMI_API_KEY        Kimi，开启内置联网搜索
  DASHSCOPE_API_KEY   通义千问（阿里云百炼），开启 enable_search
  ARK_API_KEY         豆包（火山方舟），另需 ARK_BOT_ID：控制台里配了联网插件的应用 ID
  DEEPSEEK_API_KEY    DeepSeek，不联网，作对照组
做法：cp .env.example .env，填好后 source .env，再运行本脚本。先看计划可以加 --dry-run。`);
  process.exit(1);
}
if (existsSync(out) && !args.force) {
  console.error(`${show(out)} 已经存在。要覆盖加 --force，或者用 --out 另存。`);
  process.exit(1);
}

// 报错信息里万一带了密钥，一律换成 ***
const secrets = ready.map(p => p.key).filter(k => k && k.length >= 6);
const redact = s => secrets.reduce((acc, k) => acc.split(k).join('***'), String(s));

const doc = {
  created_at: new Date().toISOString(),
  date,
  questions_version: qdoc.version,
  repeats,
  models: ready.map(p => ({ model: p.id, label: p.label, requested_model: p.model, search: p.search, endpoint: new URL(p.baseUrl).host })),
  skipped,
  records: [],
};

mkdirSync(dirname(out), { recursive: true });
const partial = out + '.partial';
const save = path => writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');

async function ask(p, q, attempt) {
  const started = new Date();
  const base = {
    date, started_at: started.toISOString(), model: p.id, model_version: null, search: p.search, search_used: null,
    question_id: q.id, question: q.text, attempt, status: 'ok', answer: '',
    mentions_echorank: false, cites_site: false, links: [], sources: [], latency_ms: null, usage: null, error: null,
  };
  if (p.stopped) return { ...base, status: 'error', error: p.stopped };
  let lastErr;
  for (let tryNo = 0; tryNo < 2; tryNo++) {
    const t0 = Date.now();
    try {
      const r = await p.call(p, p.key, q.text);
      const links = extractLinks(r.answer, r.sources);
      return {
        ...base,
        model_version: r.model_version + (r.system_fingerprint ? ` (${r.system_fingerprint})` : ''),
        search_used: r.search_used,
        answer: r.answer,
        mentions_echorank: mentionsBrand(r.answer),
        cites_site: citesSite(links),
        links,
        sources: r.sources,
        latency_ms: Date.now() - t0,
        usage: r.usage,
      };
    } catch (e) {
      lastErr = e;
      if (authFailed(e)) {
        p.stopped = `前面收到 HTTP ${e.status}，密钥或权限有问题，这一家后面没有再调用`;
        break;
      }
      if (tryNo === 0 && retryable(e)) await sleep(RETRY_WAIT_MS);
      else break;
    }
  }
  return { ...base, status: 'error', error: redact(lastErr?.message || lastErr) };
}

// 每家一个队列，家与家之间并行；同一家按顺序问，中间停一下避免限流
async function worker(p) {
  for (const q of questions) {
    for (let attempt = 1; attempt <= repeats; attempt++) {
      const rec = await ask(p, q, attempt);
      doc.records.push(rec);
      save(partial);
      const tag = rec.status === 'ok'
        ? `ok ${(rec.latency_ms / 1000).toFixed(1)}s${rec.mentions_echorank ? ' · 提到 EchoRank' : ''}${rec.cites_site ? ' · 引用官网' : ''}`
        : `失败：${rec.error.slice(0, 120)}`;
      console.log(`[${p.id}] ${q.id} 第 ${attempt} 次 ${tag}`);
      if (!p.stopped) await sleep(PAUSE_MS);
    }
  }
}

await Promise.all(ready.map(worker));

const order = new Map(providers.map((p, i) => [p.id, i]));
const qorder = new Map(questions.map((q, i) => [q.id, i]));
doc.records.sort((a, b) => order.get(a.model) - order.get(b.model) || qorder.get(a.question_id) - qorder.get(b.question_id) || a.attempt - b.attempt);
doc.finished_at = new Date().toISOString();
save(partial);
renameSync(partial, out);
rmSync(partial, { force: true });

console.log('');
for (const p of ready) {
  const rs = doc.records.filter(r => r.model === p.id);
  const ok = rs.filter(r => r.status === 'ok');
  console.log(`${p.label}：${ok.length}/${rs.length} 成功，提到 EchoRank ${ok.filter(r => r.mentions_echorank).length}，引用官网 ${ok.filter(r => r.cites_site).length}`);
}
for (const s of skipped) console.log(`${s.model}：跳过，${s.reason}`);
console.log(`共 ${doc.records.length} 条记录，已写入 ${show(out)}。下一步：node experiments/dogfood/score.mjs`);
if (doc.records.some(r => r.status !== 'ok')) process.exitCode = 2;
