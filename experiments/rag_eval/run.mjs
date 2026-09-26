#!/usr/bin/env node
// 用 questions.json 的 30 个问题问 4 个 Dify 应用（A0 / B / C1 / C2），每题问 2 次，
// 保存回答原文和检索到的段落（metadata.retriever_resources），格式和 collect.py 的运行记录一致，可以直接交给 evaluate() 打分。
//
//   node experiments/rag_eval/run.mjs --dry-run    只看计划
//   node experiments/rag_eval/run.mjs              正式运行，写到 results/YYYY-MM-DD.json
//
// 选项：--only A0,C1  只跑这几个应用    --limit 3  只跑前 3 题    --repeats 2  每题问几次
//       --out 路径    另存              --force    覆盖已有文件

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { probe, readJSON, relaunchWithProxy, todayCN } from '../dogfood/lib.mjs';
import { HERE } from './browser.mjs';

relaunchWithProxy();

const APPS = ['A0', 'B', 'C1', 'C2'];
const TIMEOUT_MS = 180_000;
const PAUSE_MS = Number(process.env.RAG_PAUSE_MS ?? 500);
const RETRY_WAIT_MS = Number(process.env.RAG_RETRY_WAIT_MS ?? 5000);
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

if (!existsSync(args.questions)) {
  console.error(`找不到 ${args.questions}。先运行 node experiments/rag_eval/export_questions.mjs`);
  process.exit(1);
}
const qdoc = readJSON(args.questions);
const queries = args.limit ? qdoc.queries.slice(0, Number(args.limit)) : qdoc.queries;
const repeats = Math.max(1, Number(args.repeats) || 2);
const date = todayCN();
const out = args.out || join(HERE, 'results', `${date}.json`);
const show = p => relative(process.cwd(), p) || p;
const baseUrl = (process.env.DIFY_BASE_URL || '').replace(/\/+$/, '');

let apps = APPS.map(id => {
  const keyName = `DIFY_KEY_${id}`;
  const key = process.env[keyName] || '';
  return { id, keyName, key, skip: key ? null : `没有设置 ${keyName}` };
});
if (args.only) {
  const want = new Set(args.only.split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
  const unknown = [...want].filter(id => !APPS.includes(id));
  if (unknown.length) {
    console.error(`不认识的应用：${unknown.join('、')}。可选：${APPS.join(', ')}`);
    process.exit(1);
  }
  apps = apps.filter(a => want.has(a.id));
}
const ready = apps.filter(a => !a.skip);
const skipped = apps.filter(a => a.skip).map(a => ({ app: a.id, reason: a.skip }));

console.log(`问题集：${queries.length} 题 × 每题 ${repeats} 次；Dify 地址：${baseUrl || '（没有设置 DIFY_BASE_URL）'}`);
for (const a of apps) console.log(`  ${a.id}：${a.skip ? '跳过，' + a.skip : `密钥 ${a.keyName} 已设置`}`);
console.log(`计划调用 ${ready.length * queries.length * repeats} 次，结果写到 ${show(out)}`);
if (args['dry-run']) {
  if (baseUrl) console.log(`网络检查（不带密钥）：${new URL(baseUrl).host}：${await probe(baseUrl)}`);
  process.exit(0);
}

if (!baseUrl || !ready.length) {
  console.error(`
${!baseUrl ? '没有设置 DIFY_BASE_URL' : '没有可用的应用密钥'}，没有调用任何接口。请先设置环境变量（只放在本机，不要写进代码）：
  DIFY_BASE_URL   Dify 的 API 地址，例如 https://api.dify.ai/v1 或自部署的 http://你的服务器/v1
  DIFY_KEY_A0     应用 A0 的 API 密钥（应用 → 访问 API → API 密钥）
  DIFY_KEY_B      应用 B 的 API 密钥
  DIFY_KEY_C1     应用 C1 的 API 密钥
  DIFY_KEY_C2     应用 C2 的 API 密钥
做法：cp .env.example .env，填好后 source .env，再运行本脚本。先看计划可以加 --dry-run。`);
  process.exit(1);
}
if (existsSync(out) && !args.force) {
  console.error(`${show(out)} 已经存在。要覆盖加 --force，或者用 --out 另存。`);
  process.exit(1);
}

class HttpError extends Error {
  constructor(status, body) { super(`HTTP ${status}：${String(body).slice(0, 300)}`); this.status = status; }
}
const secrets = ready.map(a => a.key).filter(k => k.length >= 6);
const redact = s => secrets.reduce((acc, k) => acc.split(k).join('***'), String(s));

// Dify chat-messages，阻塞模式；每次都开新会话，题与题、次与次互不影响
async function chat(app, query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(baseUrl + '/chat-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + app.key },
      body: JSON.stringify({ inputs: {}, query, response_mode: 'blocking', user: 'echorank-rag-eval', conversation_id: '' }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text);
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`超过 ${TIMEOUT_MS / 1000} 秒没有返回`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date()).replace(/[-:]/g, '').replace(' ', '-');
const doc = {
  source: 'echorank-rag-eval',
  created_at: new Date().toISOString(),
  date,
  query_set: `${qdoc.source || 'questions.json'} v${qdoc.query_set_version ?? ''}`.trim(),
  query_set_version: qdoc.query_set_version,
  apps: ready.map(a => a.id),
  skipped,
  runs: [],
};
mkdirSync(dirname(out), { recursive: true });
const partial = out + '.partial';
const save = path => writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');

async function ask(app, q, rep) {
  const rec = {
    run_id: `DIFY-${stamp}-${app.id}-${q.id}-${rep}`,
    engine: `dify_${app.id.toLowerCase()}`, app: app.id, query_id: q.id, repeat: rep,
    capture: 'DIFY_API', search: false, started_at: new Date().toISOString(), model: `dify:${app.id}`,
    status: 'ERROR', raw: '', latency_ms: 0, input_tokens: 0, output_tokens: 0, error: '',
    retriever_resources: [], message_id: '', conversation_id: '',
  };
  if (app.stopped) return { ...rec, error: app.stopped };
  let lastErr;
  for (let tryNo = 0; tryNo < 2; tryNo++) {
    const t0 = Date.now();
    try {
      const data = await chat(app, q.text);
      const answer = String(data.answer || '');
      const think = (answer.match(/<think>[\s\S]*?<\/think>/g) || []).join('\n');
      const usage = data.metadata?.usage || {};
      return {
        ...rec,
        status: 'SUCCESS',
        raw: answer.replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
        ...(think ? { think } : {}),
        latency_ms: Date.now() - t0,
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        retriever_resources: (data.metadata?.retriever_resources || []).map(r => ({
          position: r.position, score: r.score, dataset_name: r.dataset_name, document_name: r.document_name,
          document_id: r.document_id, segment_id: r.segment_id, content: r.content,
        })),
        has_retriever_resources: Array.isArray(data.metadata?.retriever_resources),
        message_id: data.message_id || data.id || '',
        conversation_id: data.conversation_id || '',
      };
    } catch (e) {
      lastErr = e;
      const status = e instanceof HttpError ? e.status : 0;
      if (status === 401 || status === 403) {
        app.stopped = `前面收到 HTTP ${status}，密钥或权限有问题，这个应用后面没有再调用`;
        break;
      }
      if (tryNo === 0 && (!status || status === 429 || status >= 500)) await sleep(RETRY_WAIT_MS);
      else break;
    }
  }
  const status = /超过 \d+ 秒/.test(lastErr?.message) ? 'TIMEOUT' : lastErr?.status === 429 ? 'RATE_LIMITED' : 'ERROR';
  return { ...rec, status, error: redact(lastErr?.message || lastErr) };
}

// 每个应用一个队列，应用之间并行
await Promise.all(ready.map(async app => {
  for (const q of queries) {
    for (let rep = 1; rep <= repeats; rep++) {
      const r = await ask(app, q, rep);
      doc.runs.push(r);
      save(partial);
      console.log(`[${app.id}] ${q.id} 第 ${rep} 次 ${r.status === 'SUCCESS' ? `完成 ${(r.latency_ms / 1000).toFixed(1)}s · 检索 ${r.retriever_resources.length} 段` : '失败：' + r.error.slice(0, 120)}`);
      if (!app.stopped) await sleep(PAUSE_MS);
    }
  }
}));

const order = new Map(APPS.map((id, i) => [id, i]));
const qorder = new Map(queries.map((q, i) => [q.id, i]));
doc.runs.sort((a, b) => order.get(a.app) - order.get(b.app) || qorder.get(a.query_id) - qorder.get(b.query_id) || a.repeat - b.repeat);
doc.finished_at = new Date().toISOString();
save(partial);
renameSync(partial, out);

console.log('');
for (const a of ready) {
  const rs = doc.runs.filter(r => r.app === a.id);
  const ok = rs.filter(r => r.status === 'SUCCESS');
  console.log(`${a.id}：${ok.length}/${rs.length} 成功`);
  if (ok.length && ok.every(r => !r.has_retriever_resources)) {
    console.log(`  注意：${a.id} 的回答里没有 retriever_resources。请在 Dify 应用的“功能”里打开“引用和归属”，否则检索召回率和编造判定没有依据。`);
  }
}
for (const s of skipped) console.log(`${s.app}：跳过，${s.reason}`);
console.log(`共 ${doc.runs.length} 条记录，已写入 ${show(out)}。下一步：node experiments/rag_eval/score.mjs`);
if (doc.runs.some(r => r.status !== 'SUCCESS')) process.exitCode = 2;
