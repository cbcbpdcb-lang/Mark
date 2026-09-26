#!/usr/bin/env node
// 给 results/ 里每一次采集打分，输出各次复测的对比表。
//
//   node experiments/dogfood/score.mjs                  读 results/*.json
//   node experiments/dogfood/score.mjs a.json b.json    只算指定文件
//
// 输出（都在 experiments/dogfood/ 下，Excel 可直接打开）：
//   summary.csv       每次采集 × 每个模型：提到、引用官网、说对 / 说错 / 未提及、说对的事实数，距基线天数，和上一次比的变化
//   by_question.csv   每道题在每次采集里说对几次，对照 FAQ 逐条看
//   details.csv       每条回答的判定和依据句
//
// 判定规则（facts.json，写法和产品里的事实键一致）：
//   说错：回答提到 EchoRank，且某句命中一条事实键的 wrong（前后没有“不是”“不会”之类的否定）
//   说对：没说错，且说到了这道题对应的事实键（数字、条件、网址，不看话题关键词）
//   未提及：其余，包括没提到 EchoRank 的回答

import { readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compileFacts, pct, readJSON, toCSV, verdictFor, wilson } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    results: { type: 'string', default: join(HERE, 'results') },
    facts: { type: 'string', default: join(HERE, 'facts.json') },
    questions: { type: 'string', default: join(HERE, 'questions.json') },
    'out-dir': { type: 'string', default: HERE },
  },
});

const compiled = compileFacts(readJSON(args.facts));
const qdoc = readJSON(args.questions);
const qById = new Map(qdoc.questions.map(q => [q.id, q]));

const files = positionals.length
  ? positionals
  : readdirSync(args.results).filter(f => /\.json$/.test(f)).sort().map(f => join(args.results, f));
if (!files.length) {
  console.error(`${relative(process.cwd(), args.results) || args.results} 里还没有采集结果。先运行 node experiments/dogfood/run.mjs`);
  process.exit(1);
}

const MODEL_ORDER = ['kimi', 'qwen', 'doubao', 'deepseek'];
const byModel = (a, b) => (MODEL_ORDER.indexOf(a) + 1 || 99) - (MODEL_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b);

const summary = [];
const details = [];
const perQuestion = new Map(); // qid -> Map(round -> {right, n})
const rounds = [];
const dayOf = (doc, round) => Date.parse((doc.date || round).slice(0, 10) + 'T00:00:00Z');
let baseDay = null;

files.forEach((file, i) => {
  const doc = readJSON(file);
  const round = basename(file, '.json');
  const label = i === 0 ? '基线' : `第 ${i} 次复测`;
  rounds.push(round);
  if (i === 0) baseDay = dayOf(doc, round);
  const days = Number.isNaN(dayOf(doc, round) - baseDay) ? '' : Math.round((dayOf(doc, round) - baseDay) / 86400000);
  const searchOf = new Map((doc.models || []).map(m => [m.model, m.search]));
  const scored = doc.records.map(r => {
    const q = qById.get(r.question_id);
    const v = r.status === 'ok' ? verdictFor(r, q, compiled) : null;
    details.push([
      round, r.model, r.channel || 'API', r.model_version || '', r.question_id, r.question || q?.text || '', r.attempt, r.status === 'ok' ? '成功' : '失败',
      v ? (v.mentioned ? '是' : '否') : '', r.status === 'ok' ? (r.cites_site ? '是' : '否') : '', v ? v.verdict : '',
      v ? v.ownRight.map(x => x.claim_id).join(' ') : '', v ? v.right.map(x => x.claim_id).join(' ') : '', v ? v.wrong.map(x => x.claim_id).join(' ') : '',
      v ? v.wrong.map(x => x.sentence).join(' | ') : '', (r.links || []).join(' '), r.error || '',
    ]);
    if (v) {
      const m = perQuestion.get(r.question_id) || new Map();
      const c = m.get(round) || { right: 0, wrong: 0, n: 0 };
      c.n++;
      if (v.verdict === '说对') c.right++;
      if (v.verdict === '说错') c.wrong++;
      m.set(round, c);
      perQuestion.set(r.question_id, m);
    }
    return { r, v };
  });

  const models = [...new Set(doc.records.map(r => r.model))].sort(byModel);
  const groups = [...models.map(m => [m, searchOf.get(m) || '', scored.filter(x => x.r.model === m)]), ['全部', '', scored]];
  for (const [model, search, rows] of groups) {
    const ok = rows.filter(x => x.v);
    const n = ok.length;
    const count = f => ok.filter(f).length;
    const right = count(x => x.v.verdict === '说对');
    const wrong = count(x => x.v.verdict === '说错');
    const [lo, hi] = wilson(right, n);
    summary.push({
      round, label, days, model, search, n, failed: rows.length - n,
      mentioned: count(x => x.v.mentioned), cited: count(x => x.r.cites_site),
      right, wrong, none: n - right - wrong, keyRight: count(x => x.v.keyRight),
      facts: ok.reduce((sum, x) => sum + x.v.right.length, 0),
      ci: n ? `${Math.round(lo * 100)}–${Math.round(hi * 100)}%` : '',
    });
  }
  for (const s of doc.skipped || []) {
    summary.push({ round, label, days, model: s.model, search: '', n: 0, failed: 0, mentioned: 0, cited: 0, right: 0, wrong: 0, none: 0, keyRight: 0, facts: 0, ci: '', skipped: s.reason });
  }
});

// 和同一个模型的上一次采集比，说对率变了多少个百分点
const last = new Map();
const summaryRows = summary.map(s => {
  const rate = s.n ? pct(s.right, s.n) : null;
  const prev = last.get(s.model);
  const delta = rate != null && prev != null ? rate - prev : '';
  if (rate != null) last.set(s.model, rate);
  return [
    s.label, s.round, s.days, s.model, s.search, s.n, s.failed,
    s.mentioned, s.n ? pct(s.mentioned, s.n) : '', s.cited, s.n ? pct(s.cited, s.n) : '',
    s.right, rate ?? '', s.ci, s.wrong, s.none, s.facts, s.keyRight,
    delta === '' ? '' : (delta > 0 ? '+' : '') + delta, s.skipped || '',
  ];
});

const outDir = args['out-dir'];
const write = (name, header, rows) => {
  writeFileSync(join(outDir, name), toCSV(header, rows));
  return relative(process.cwd(), join(outDir, name)) || name;
};

const f1 = write('summary.csv', [
  '轮次', '采集', '距基线天数', '模型', '联网方式', '有效回答', '失败', '提到 EchoRank', '提到率 %', '引用官网', '引用率 %',
  '说对', '说对率 %', '说对率 95% 区间', '说错', '未提及', '说对的事实数', '说对关键事实', '说对率较上次（百分点）', '说明',
], summaryRows);

const f2 = write('by_question.csv', ['问题编号', '问题', '对应事实键', ...rounds.flatMap(r => [`${r} 说对`, `${r} 说错`, `${r} 有效`])],
  qdoc.questions.map(q => [q.id, q.text, (q.facts || []).join(' '), ...rounds.flatMap(r => {
    const c = perQuestion.get(q.id)?.get(r);
    return c ? [c.right, c.wrong, c.n] : ['', '', ''];
  })]));

const f3 = write('details.csv', [
  '采集', '模型', '渠道', '模型版本', '问题编号', '问题', '第几次', '状态', '提到 EchoRank', '引用官网', '结论',
  '本题说对的事实键', '说对的全部事实键', '说错的事实键', '说错原句', '链接', '错误信息',
], details);

console.log('采集        模型       有效  提到  引用官网  说对  说错  未提及  说对率');
for (const s of summary) {
  if (s.skipped) { console.log(`${s.round.padEnd(11)} ${s.model.padEnd(9)}  跳过：${s.skipped}`); continue; }
  console.log(`${s.round.padEnd(11)} ${s.model.padEnd(9)} ${String(s.n).padStart(4)} ${String(s.mentioned).padStart(5)} ${String(s.cited).padStart(9)} ${String(s.right).padStart(5)} ${String(s.wrong).padStart(5)} ${String(s.none).padStart(7)}  ${s.n ? pct(s.right, s.n) + '%' : '-'}${s.ci ? '（' + s.ci + '）' : ''}`);
}
console.log(`\n已写入 ${f1}、${f2}、${f3}`);
