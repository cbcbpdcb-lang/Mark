#!/usr/bin/env node
// 给 Dify 应用的回答打分：用 Playwright 打开本地构建的产品页 /app/，在页面里调用产品自己的 evaluate()，
// 事实底账用品牌 A 的（PRESETS.direct_a），不改浏览器端代码。检索召回、编造和拒答在这里按 gold_sources.json 判。
//
//   node experiments/rag_eval/score.mjs                        读 results/ 里最新的一次采集
//   node experiments/rag_eval/score.mjs results/a.json b.json  合并几次采集一起算
//
// 输出（默认在 experiments/rag_eval/）：summary.csv、failures.csv、compare.png
// 产品页默认是 dist/app/index.html（公开版），没有就先运行 build_public.py 生成；--page index.html 可改用内部版。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pct, readJSON, toCSV, wilson } from '../dogfood/lib.mjs';
import { HERE, INTERNAL_PAGE, PUBLIC_APP_PAGE, REPO, launch, openApp } from './browser.mjs';
import { autoAttribution, goldSpecs, hasRetrieval, isRefusal, quoteFragments, recallHit, topK, unsupportedSpecifics } from './rag_lib.mjs';
import { renderChart } from './chart.mjs';

const APPS = ['A0', 'B', 'C1', 'C2'];
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    page: { type: 'string', default: PUBLIC_APP_PAGE },
    internal: { type: 'string', default: INTERNAL_PAGE },
    gold: { type: 'string', default: join(HERE, 'gold_sources.json') },
    results: { type: 'string', default: join(HERE, 'results') },
    'out-dir': { type: 'string', default: HERE },
  },
});
const show = p => relative(process.cwd(), p) || p;

const files = positionals.length
  ? positionals
  : readdirSync(args.results).filter(f => /\.json$/.test(f)).sort().slice(-1).map(f => join(args.results, f));
if (!files.length) {
  console.error(`${show(args.results)} 里还没有采集结果。先运行 node experiments/rag_eval/run.mjs`);
  process.exit(1);
}
const all = files.flatMap(f => readJSON(f).runs || []).map(r => ({ ...r, app: r.app || r.engine || '未命名' }));
const gold = readJSON(args.gold);
const K = gold.top_k || 4;

if (!existsSync(args.page) && resolve(args.page) === PUBLIC_APP_PAGE) {
  console.log('没有找到 dist/app/index.html，先运行 build_public.py 生成公开版。');
  execFileSync('python3', [join(REPO, 'build_public.py')], { cwd: REPO, stdio: 'inherit' });
}

const ok = all.filter(r => r.status === 'SUCCESS');
const browser = await launch();
let verdicts, quotes, isPublic;
try {
  const internal = await openApp(browser, args.internal);
  const app = resolve(args.page) === resolve(args.internal) ? internal : await openApp(browser, args.page);
  isPublic = await app.evaluate(() => PUBLIC_BUILD);
  const rawQuotes = await internal.evaluate(() => {
    const T = PRESETS.direct_a.truth;
    return Object.fromEntries([...T.capabilities, ...(T.prohibited_claims || [])].filter(c => c.claim_id).map(c => [c.claim_id, c.source_quote || '']));
  });
  quotes = Object.fromEntries(Object.entries(rawQuotes).map(([k, q]) => [k, quoteFragments(q)]));
  // 公开版的事实底账已经匿名（品牌名是“品牌 A”），回答原文先用内部版同一套规则匿名，品牌才对得上；内部版直接用原文
  const texts = ok.map(r => r.raw);
  const raws = isPublic ? await internal.evaluate(ts => { const f = maskerFor('direct_a'); return ts.map(f); }, texts) : texts;
  verdicts = await app.evaluate(runs => {
    const d = presetData('direct_a');
    return runs.map(r => {
      const e = evaluate(r, { truth: d.truth, competitors: d.competitors });
      if (!e.valid) return { valid: false };
      const wrong = isWrongRun(r, e);
      return {
        valid: true, mentioned: e.mentioned, wrong, pending: isPendingRun(r, e),
        verifiable: !!finalOf(r, e).v && !wrong, layer: rightLayer(e),
        wrongIssues: e.issues.filter(i => WRONG_TYPES.includes(i.type)).map(i => `${i.label}：${i.text}`),
        pendingIssues: e.issues.filter(i => i.type === 'numeric_conflict').map(i => i.text),
      };
    });
  }, ok.map((r, i) => ({ run_id: r.run_id, query_id: r.query_id, engine: r.engine, repeat: r.repeat, status: 'SUCCESS', raw: raws[i] })));
} finally {
  await browser.close();
}

const qText = new Map();
try { for (const q of readJSON(join(HERE, 'questions.json')).queries) qText.set(q.id, q.text); } catch {}

// ---------- 每条回答 ----------
const rows = ok.map((r, i) => {
  const v = verdicts[i];
  const entry = gold.questions?.[r.query_id] || {};
  const blank = !!entry.blank;
  const hit = recallHit(r, entry, quotes, K);
  const judgeable = hasRetrieval(r);
  const fab = judgeable ? unsupportedSpecifics(r.raw, r.retriever_resources) : null;
  const refusal = isRefusal(r.raw);
  const grounded = blank && !refusal && hit === true && fab?.length === 0;
  const properRefusal = blank && refusal && hit !== true;
  const keyRight = v.verifiable && v.layer === 'key';
  const problems = [];
  if (v.wrong) problems.push(['说错', v.wrongIssues.join('；')]);
  if (v.pending) problems.push(['待确认', v.pendingIssues.join('；')]);
  if (fab?.length) problems.push(['编造', fab.map(x => `${x.kind} ${x.text}`).join('；')]);
  if (blank && !grounded && !properRefusal) problems.push(['空白题不当回答', refusal ? '检索到了标准段落却拒答' : '官网没有口径，回答没有依据也没有拒答']);
  if (!blank && !v.wrong && !v.pending && !v.verifiable) problems.push(['没说对官方口径', v.mentioned ? '' : '回答里没点品牌名，产品规则按“没有提到”算']);
  return { r, v, entry, blank, hit, judgeable, fab, refusal, grounded, properRefusal, keyRight, problems };
});

// ---------- 汇总 ----------
const present = APPS.filter(a => all.some(r => r.app === a)).concat([...new Set(all.map(r => r.app))].filter(a => !APPS.includes(a)));
const rate = (k, n) => (n ? k / n : null);
const summary = present.map(app => {
  const rs = rows.filter(x => x.r.app === app);
  const n = rs.length;
  const cnt = f => rs.filter(f).length;
  const blankRs = rs.filter(x => x.blank);
  const fabRs = rs.filter(x => x.judgeable);
  const recRs = rs.filter(x => x.hit !== null);
  const s = {
    app, n, failed: all.filter(r => r.app === app && r.status !== 'SUCCESS').length,
    mentioned: cnt(x => x.v.mentioned), wrong: cnt(x => x.v.wrong), pending: cnt(x => x.v.pending),
    verifiable: cnt(x => x.v.verifiable), key: cnt(x => x.keyRight),
    blankN: blankRs.length, grounded: cnt(x => x.grounded), refused: cnt(x => x.properRefusal),
    fabN: fabRs.length, fab: fabRs.filter(x => x.fab.length).length,
    recN: recRs.length, rec: recRs.filter(x => x.hit).length,
  };
  s.rates = {
    说错率: rate(s.wrong, n), 待确认率: rate(s.pending, n), 关键事实说对率: rate(s.key, n),
    空白题有依据回答率: rate(s.grounded, s.blankN), 编造率: rate(s.fab, s.fabN), 恰当拒答率: rate(s.refused, s.blankN),
    [`检索召回率（前 ${K} 段）`]: rate(s.rec, s.recN),
  };
  return s;
});

const ci = (k, n) => { if (!n) return ''; const [lo, hi] = wilson(k, n); return `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`; };
const p = (k, n) => (n ? pct(k, n) : '');
const outDir = args['out-dir'];
const write = (name, header, data) => { writeFileSync(join(outDir, name), toCSV(header, data)); return show(join(outDir, name)); };

const f1 = write('summary.csv', [
  '应用', '有效回答', '调用失败', '提到品牌',
  '说错', '说错率 %', '待确认', '待确认率 %', '说对且有依据', '关键事实说对', '关键事实说对率 %', '关键事实说对率 95% 区间',
  '空白题回答', '空白题有依据', '空白题有依据回答率 %', '恰当拒答', '恰当拒答率 %',
  '可判编造的回答', '编造', '编造率 %', '有标准段落的回答', `前 ${K} 段召回`, `检索召回率（前 ${K} 段）%`,
], summary.map(s => [
  s.app, s.n, s.failed, s.mentioned,
  s.wrong, p(s.wrong, s.n), s.pending, p(s.pending, s.n), s.verifiable, s.key, p(s.key, s.n), ci(s.key, s.n),
  s.blankN, s.grounded, p(s.grounded, s.blankN), s.refused, p(s.refused, s.blankN),
  s.fabN, s.fab, p(s.fab, s.fabN), s.recN, s.rec, p(s.rec, s.recN),
]));

const failures = rows.filter(x => x.problems.length).map(x => {
  const top = topK(x.r.retriever_resources, K);
  const auto = autoAttribution(x.hit);
  const hint = x.hit === null
    ? (goldSpecs(x.entry).length ? '这条回答没有检索记录，无法预判' : x.blank ? `官网没有这条口径（${x.entry.topic || ''}）：可能是口径缺失，请人工判断` : '没有标准段落，请人工判断')
    : '';
  return [
    x.r.app, x.r.query_id, qText.get(x.r.query_id) || '', x.r.repeat, x.problems.map(y => y[0]).join('、'),
    x.problems.map(y => y[1]).filter(Boolean).join(' | '),
    x.hit === null ? '无标准段落或无检索记录' : x.hit ? '是' : '否',
    auto, hint, '',
    top.map(t => `${t.position ?? ''}. ${t.document_name || ''}`).join(' | '),
    x.r.raw.replace(/\s+/g, ' ').slice(0, 300),
    x.r.run_id,
  ];
});
const f2 = write('failures.csv', [
  '应用', '问题编号', '问题', '第几次', '问题类型', '详情', `前 ${K} 段召回标准段落`,
  '归因（脚本预判）', '归因提示', '归因（人工：口径缺失 / 口径有歧义）', `前 ${K} 段检索`, '回答摘录', 'run_id',
], failures);

const png = join(outDir, 'compare.png');
await renderChart(summary, png, { note: `${ok.length} 条有效回答 · 采集 ${files.map(f => basename(f, '.json')).join('、')} · 事实底账：品牌 A（${isPublic ? '公开版' : '内部版'}）` });

console.log(`产品页：${show(args.page)}（${isPublic ? '公开版，回答先按同一规则匿名' : '内部版'}）`);
console.log('应用   有效  说错  待确认  关键事实  空白题有依据  恰当拒答  编造  召回');
for (const s of summary) {
  const f = (k, n) => (n ? `${k}/${n}` : '-');
  console.log(`${s.app.padEnd(5)} ${String(s.n).padStart(4)} ${String(s.wrong).padStart(5)} ${String(s.pending).padStart(7)} ${f(s.key, s.n).padStart(9)} ${f(s.grounded, s.blankN).padStart(13)} ${f(s.refused, s.blankN).padStart(9)} ${f(s.fab, s.fabN).padStart(5)} ${f(s.rec, s.recN).padStart(5)}`);
}
console.log(`\n已写入 ${f1}、${f2}（${failures.length} 条）、${show(png)}`);
