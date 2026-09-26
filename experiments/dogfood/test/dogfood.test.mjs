// node --test experiments/dogfood/test/
// 全部在本机跑：接口用 mock_api.mjs 模拟，不需要任何密钥，也不联网。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { citesSite, compileFacts, extractLinks, judgeAnswer, readJSON, sentences, toCSV, verdictFor, wilson } from '../lib.mjs';
import { FAKE_KEYS, startMockApi } from './mock_api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const run = promisify(execFile);
const facts = readJSON(join(ROOT, 'facts.json'));
const qdoc = readJSON(join(ROOT, 'questions.json'));
const compiled = compileFacts(facts);
const Q = id => qdoc.questions.find(q => q.id === id);

// 子进程只带我们给的变量，避免读到本机真实密钥
const KEY_VARS = ['KIMI_API_KEY', 'MOONSHOT_API_KEY', 'DASHSCOPE_API_KEY', 'ARK_API_KEY', 'ARK_BOT_ID', 'DEEPSEEK_API_KEY'];
function cleanEnv(extra = {}) {
  const env = { ...process.env, DOGFOOD_PAUSE_MS: '0', DOGFOOD_RETRY_WAIT_MS: '0' };
  for (const k of KEY_VARS) delete env[k];
  return { ...env, ...extra };
}
async function runScript(script, argv, env) {
  try {
    const r = await run(process.execPath, [join(ROOT, script), ...argv], { env, cwd: ROOT });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe('配置文件', () => {
  test('定稿 2.1 的 10 个问题，每题对应的事实键都存在', () => {
    assert.equal(qdoc.version, 'final-1');
    assert.equal(qdoc.questions.length, 10);
    assert.equal(new Set(qdoc.questions.map(q => q.id)).size, 10);
    assert.equal(qdoc.questions[1].text, 'echorank.markjcai.com 是做什么的？');
    for (const q of qdoc.questions) {
      assert.ok(q.facts?.length, `${q.id} 没有对应的事实键`);
      for (const f of q.facts) assert.ok(compiled.byId.has(f), `${q.id} 引用了不存在的 ${f}`);
    }
  });
  test('附录 A 的 10 条 FAQ 各有一条事实键，题目反查一致', () => {
    assert.equal(facts.version, 'final-1');
    assert.equal(facts.facts.length, 10);
    assert.equal(new Set(facts.facts.map(f => f.faq)).size, 10);
    for (const f of facts.facts) {
      assert.ok(['key', 'marketing'].includes(f.group));
      assert.ok(f.faq && f.source_quote);
      for (const qid of f.questions) assert.ok(Q(qid).facts.includes(f.claim_id), `${qid} 没有对应 ${f.claim_id}`);
    }
    for (const q of qdoc.questions) for (const fid of q.facts) assert.ok(compiled.byId.get(fid).questions.includes(q.id));
  });
  test('每条 FAQ 定稿原文自己能命中 match，也不会被判成说错', () => {
    for (const f of compiled.facts) {
      assert.ok(f.matchRe.test(f.source_quote), `${f.claim_id} 的 match 连定稿原文都命中不了`);
      const j = judgeAnswer(`EchoRank：${f.source_quote}`, compiled);
      assert.deepEqual(j.wrong, [], `${f.claim_id} 的定稿原文被判成了说错`);
    }
  });
});

describe('链接', () => {
  test('Markdown 链接、裸域名、接口参考链接都收进来并去重', () => {
    const links = extractLinks('详见[官网](https://echorank.markjcai.com/)，也可以看 echorank.markjcai.com/faq。另见 https://a.com/x).', ['https://echorank.markjcai.com', 'https://b.com']);
    assert.deepEqual(links, ['https://echorank.markjcai.com/', 'https://a.com/x', 'echorank.markjcai.com/faq', 'https://b.com']);
  });
  test('只有 echorank.markjcai.com 算引用官网', () => {
    assert.equal(citesSite(['https://echorank.markjcai.com/#faq']), true);
    assert.equal(citesSite(['echorank.markjcai.com']), true);
    assert.equal(citesSite(['https://markjcai.com/', 'https://echorank.com/']), false);
    assert.equal(citesSite(['https://echorank.markjcai.com.evil.cn/']), false);
  });
  test('按句切分时不切开域名', () => {
    assert.deepEqual(sentences('官网是 echorank.markjcai.com。免费！'), ['官网是 echorank.markjcai.com', '免费']);
  });
});

describe('判定', () => {
  const v = (answer, qid) => verdictFor({ answer }, Q(qid), compiled);
  test('没提到 EchoRank 一律未提及，哪怕句子碰巧命中事实键', () => {
    const r = v('这类服务一般逐句核对官网原文，首次体检免费。', 'Q05');
    assert.equal(r.mentioned, false);
    assert.equal(r.verdict, '未提及');
  });
  test('网址也算提到 EchoRank', () => {
    assert.equal(v('echorank.markjcai.com 是一项 AI 回答体检服务。', 'Q02').verdict, '说对');
  });
  test('说到本题的事实键算说对；说到别的题的事实不算本题说对', () => {
    assert.equal(v('EchoRank 目前检查 DeepSeek、Kimi、通义千问和豆包。', 'Q04').verdict, '说对');
    assert.equal(v('EchoRank 目前检查 DeepSeek、Kimi、通义千问和豆包。', 'Q09').verdict, '未提及');
    assert.equal(v('EchoRank 由独立产品经理 Jiacheng 设计和开发。', 'Q09').verdict, '说对');
    assert.equal(v('EchoRank 的报告有一句话结论和优先修改清单。', 'Q07').verdict, '说对');
    assert.equal(v('EchoRank 把回答逐句和品牌官网原文对照。', 'Q05').verdict, '说对');
    assert.equal(v('EchoRank 不是 SaaS，是面向企业的服务。', 'Q08').verdict, '说对');
    assert.equal(v('EchoRank 只做诊断，不在外部批量发布内容。', 'Q06').verdict, '说对');
    assert.equal(v('GEO 是在外部发内容，EchoRank 只做诊断，建议品牌在自己的官方页面补上事实。', 'Q10').verdict, '说对');
  });
  test('只聊到话题不算说对', () => {
    assert.equal(v('EchoRank 会检查主流大模型。', 'Q04').verdict, '未提及');
    assert.equal(v('EchoRank 的报告内容很丰富。', 'Q07').verdict, '未提及');
    assert.equal(v('EchoRank 是一个小团队做的。', 'Q09').verdict, '未提及');
  });
  test('说错优先于说对', () => {
    const r = v('EchoRank 是一款 SEO 关键词排名工具，会检查 DeepSeek 和 Kimi。', 'Q04');
    assert.equal(r.verdict, '说错');
    assert.deepEqual(r.wrong.map(w => w.claim_id), ['f_what']);
  });
  test('否定句不算说错', () => {
    assert.equal(v('EchoRank 不是 SEO 工具，而是 AI 回答体检服务。', 'Q01').verdict, '说对');
    assert.equal(v('EchoRank 不是 SaaS 产品。', 'Q08').verdict, '说对');
    assert.equal(v('EchoRank 不会帮品牌往 AI 里投放内容。', 'Q06').verdict, '说对');
    assert.equal(v('EchoRank 首次体检不收费。', 'Q01').verdict, '未提及');
  });
  test('各条 wrong 规则', () => {
    assert.equal(v('EchoRank 是一款 SaaS 工具。', 'Q08').verdict, '说错');
    assert.equal(v('EchoRank 会帮品牌批量发布软文。', 'Q06').verdict, '说错');
    assert.equal(v('EchoRank 可以替品牌投放内容，影响 AI 的回答。', 'Q10').verdict, '说错');
    assert.equal(v('EchoRank 由北京某某科技公司开发。', 'Q09').verdict, '说错');
    assert.equal(v('EchoRank 检查 ChatGPT 和 Gemini 的回答。', 'Q04').verdict, '说错');
    assert.equal(v('EchoRank 靠全网共识判断对错。', 'Q05').verdict, '说错');
    assert.equal(v('EchoRank 首次体检收费 999 元。', 'Q01').verdict, '说错');
    assert.equal(v('EchoRank 检查 DeepSeek、豆包、元宝、Kimi、千问。', 'Q04').verdict, '说对');
  });
  test('需要同句提到品牌的 wrong：别人投放内容不算 EchoRank 说错', () => {
    assert.equal(v('GEO 服务商会帮品牌批量发布软文。EchoRank 只做诊断。', 'Q10').verdict, '说对');
    assert.equal(v('和 GEO 不同，GEO 会批量发布内容，EchoRank 只做诊断。', 'Q10').verdict, '说对');
    assert.equal(v('和别的工具不同，EchoRank 不看 ChatGPT，只看 DeepSeek、豆包、Kimi。', 'Q04').verdict, '说对');
  });
  test('联系方式是宣传语一类，不算关键事实', () => {
    assert.equal(v('EchoRank 目前检查 DeepSeek、Kimi。', 'Q04').keyRight, true);
    assert.equal(compiled.byId.get('f_contact').group, 'marketing');
  });
});

describe('工具函数', () => {
  test('Wilson 区间', () => {
    const [lo, hi] = wilson(76, 240);
    assert.equal(Math.round(lo * 100), 26);
    assert.equal(Math.round(hi * 100), 38);
    assert.deepEqual(wilson(0, 0), [0, 0]);
  });
  test('CSV 带 BOM，逗号和引号转义', () => {
    assert.equal(toCSV(['a', 'b'], [['x,y', 'say "hi"']]), '﻿a,b\r\n"x,y","say ""hi"""\r\n');
  });
});

describe('run.mjs', () => {
  let api;
  let dir;
  before(async () => {
    api = await startMockApi();
    dir = mkdtempSync(join(tmpdir(), 'dogfood-'));
  });
  after(async () => {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const mockEnv = extra => cleanEnv({
    ...FAKE_KEYS,
    KIMI_BASE_URL: api.base + '/kimi',
    DASHSCOPE_NATIVE_BASE_URL: api.base + '/qwen',
    ARK_BASE_URL: api.base + '/ark',
    DEEPSEEK_BASE_URL: api.base + '/deepseek',
    ...extra,
  });

  test('不带密钥：退出码 1，列出要设置的环境变量，不写文件', async () => {
    const out = join(dir, 'none.json');
    const r = await runScript('run.mjs', ['--out', out], cleanEnv());
    assert.equal(r.code, 1);
    for (const k of ['KIMI_API_KEY', 'DASHSCOPE_API_KEY', 'ARK_API_KEY', 'ARK_BOT_ID', 'DEEPSEEK_API_KEY']) assert.match(r.stderr, new RegExp(k));
    assert.equal(existsSync(out), false);
  });

  test('--dry-run 不调用接口', async () => {
    const r = await runScript('run.mjs', ['--dry-run', '--out', join(dir, 'dry.json')], mockEnv());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /计划调用 60 次/); // 没有 ARK_BOT_ID，豆包跳过：10 × 3 × 2
    assert.equal(api.seen.kimiRounds, 0);
  });

  test('四家都有密钥：10 题 × 4 家 × 2 次 = 80 条，字段齐全，密钥不落盘', async () => {
    const out = join(dir, 'full.json');
    const r = await runScript('run.mjs', ['--out', out], mockEnv({ ARK_BOT_ID: 'bot-test-001' }));
    assert.equal(r.code, 0, r.stderr);
    const text = readFileSync(out, 'utf-8');
    for (const k of Object.values(FAKE_KEYS)) {
      assert.ok(!text.includes(k), '结果文件里出现了密钥');
      assert.ok(!r.stdout.includes(k) && !r.stderr.includes(k), '输出里出现了密钥');
    }
    const doc = JSON.parse(text);
    assert.equal(doc.records.length, 80);
    assert.deepEqual(doc.skipped, []);
    assert.equal(existsSync(out + '.partial'), false);
    const fields = ['date', 'model', 'model_version', 'question_id', 'attempt', 'answer', 'mentions_echorank', 'cites_site', 'links'];
    for (const rec of doc.records) for (const f of fields) assert.ok(f in rec, `缺字段 ${f}`);

    const kimi = doc.records.find(x => x.model === 'kimi');
    assert.equal(kimi.status, 'ok');
    assert.equal(kimi.search_used, true);
    assert.equal(kimi.model_version, 'kimi-k2.6-0925');
    assert.equal(kimi.mentions_echorank, true);
    assert.equal(kimi.cites_site, true);
    assert.deepEqual(kimi.links, ['https://echorank.markjcai.com/']);
    assert.equal(api.seen.kimiRounds, 40); // 每次两轮：先要搜索，再回答

    const qwen = doc.records.find(x => x.model === 'qwen');
    assert.equal(qwen.cites_site, true); // 来自 search_info
    assert.equal(qwen.model_version, 'qwen-plus');
    assert.equal(qwen.search_used, true);
    assert.deepEqual(qwen.links, ['https://echorank.markjcai.com/#faq']);
    assert.ok(api.seen.qwenBodies.every(b => b.parameters.enable_search === true && b.parameters.search_options.enable_source === true));

    const doubao = doc.records.find(x => x.model === 'doubao');
    assert.equal(doubao.model_version, 'doubao-seed-1-6');
    assert.deepEqual(doubao.sources, ['https://example.com/a']);
    assert.equal(doubao.mentions_echorank, false);

    const ds = doc.records.find(x => x.model === 'deepseek');
    assert.equal(ds.search_used, false);
    assert.equal(ds.model_version, 'deepseek-chat (fp_1)');
    assert.equal(ds.cites_site, false);

    const again = await runScript('run.mjs', ['--out', out], mockEnv({ ARK_BOT_ID: 'bot-test-001' }));
    assert.equal(again.code, 1);
    assert.match(again.stderr, /已经存在/);
  });

  test('豆包没有 ARK_BOT_ID：跳过并在输出里写明原因', async () => {
    const out = join(dir, 'nobot.json');
    const r = await runScript('run.mjs', ['--out', out, '--limit', '1'], mockEnv());
    assert.equal(r.code, 0, r.stderr);
    const doc = readJSON(out);
    assert.equal(doc.records.length, 6);
    assert.equal(doc.skipped.length, 1);
    assert.equal(doc.skipped[0].model, 'doubao');
    assert.match(doc.skipped[0].reason, /ARK_BOT_ID/);
  });

  test('只有旧的 MOONSHOT_API_KEY 也能用 Kimi', async () => {
    const out = join(dir, 'moonshot.json');
    const env = mockEnv({ MOONSHOT_API_KEY: FAKE_KEYS.KIMI_API_KEY });
    delete env.KIMI_API_KEY;
    const r = await runScript('run.mjs', ['--out', out, '--only', 'kimi', '--limit', '1', '--repeats', '1'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readJSON(out).records[0].status, 'ok');
  });

  test('--import 导入豆包网页版手动记录：合并进当天文件，去掉跳过记录，重复导入不重复', async () => {
    const out = join(dir, 'with-manual.json');
    const api = await runScript('run.mjs', ['--out', out, '--limit', '1'], mockEnv());
    assert.equal(api.code, 0, api.stderr);
    assert.equal(readJSON(out).skipped[0].model, 'doubao');
    assert.ok(readJSON(out).records.every(r => r.channel === 'API'));
    const manual = join(dir, '豆包_2026-09-28.json');
    writeFileSync(manual, JSON.stringify([
      { question_id: 'Q01', attempt: 1, answer: 'EchoRank 是一项 AI 回答事实体检服务，见 https://echorank.markjcai.com/faq/。' },
      { question_id: 'Q01', attempt: 2, answer: '没有找到相关信息。', links: ['https://example.com/x'] },
    ]));
    for (let i = 0; i < 2; i++) {
      const r = await runScript('run.mjs', ['--import', manual, '--out', out], cleanEnv());
      assert.equal(r.code, 0, r.stderr);
    }
    const doc = readJSON(out);
    const man = doc.records.filter(r => r.channel === 'WEB_MANUAL');
    assert.equal(man.length, 2);
    assert.equal(doc.records.length, 6 + 2);
    assert.deepEqual(doc.skipped, []);
    assert.ok(doc.models.some(m => m.model === 'doubao' && m.search === '网页版（手动记录）'));
    assert.equal(man[0].model, 'doubao');
    assert.equal(man[0].date, '2026-09-28');
    assert.equal(man[0].mentions_echorank, true);
    assert.equal(man[0].cites_site, true);
    assert.deepEqual(man[1].links, ['https://example.com/x']);
  });

  test('--import：问题编号不在问题集里时拒绝导入', async () => {
    const manual = join(dir, '豆包_2026-09-29.json');
    writeFileSync(manual, JSON.stringify({ records: [{ question_id: 'Q99', attempt: 1, answer: 'x' }] }));
    const r = await runScript('run.mjs', ['--import', manual, '--out', join(dir, 'bad-import.json')], cleanEnv());
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Q99/);
    assert.equal(existsSync(join(dir, 'bad-import.json')), false);
  });

  test('503 重试一次；401 之后这一家不再调用，报错里的密钥被遮掉', async () => {
    const out = join(dir, 'errors.json');
    const r = await runScript('run.mjs', ['--out', out, '--only', 'deepseek,kimi', '--limit', '2', '--repeats', '1'],
      mockEnv({ DEEPSEEK_BASE_URL: api.base + '/flaky', KIMI_BASE_URL: api.base + '/denied' }));
    assert.equal(r.code, 2); // 有失败记录
    const doc = readJSON(out);
    const ds = doc.records.filter(x => x.model === 'deepseek');
    assert.ok(ds.every(x => x.status === 'ok'));
    assert.equal(api.seen.flaky, 4);
    const kimi = doc.records.filter(x => x.model === 'kimi');
    assert.equal(kimi.length, 2);
    assert.ok(kimi.every(x => x.status === 'error'));
    assert.equal(api.seen.unauthorized, 1);
    assert.ok(!readFileSync(out, 'utf-8').includes(FAKE_KEYS.KIMI_API_KEY));
    assert.match(kimi[0].error, /\*\*\*/);
  });
});

describe('score.mjs', () => {
  test('两次采集的对比表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogfood-score-'));
    const rec = (model, qid, attempt, answer, extra = {}) => ({
      date: '', model, model_version: model, question_id: qid, attempt, status: 'ok', answer,
      mentions_echorank: /echo\s*rank/i.test(answer), cites_site: false, links: [], ...extra,
    });
    const day0 = { date: '2026-09-27', models: [{ model: 'kimi', search: '联网' }, { model: 'deepseek', search: '不联网' }], skipped: [{ model: 'doubao', reason: '没有设置 ARK_BOT_ID' }], records: [
      rec('kimi', 'Q04', 1, 'EchoRank 检查 DeepSeek、Kimi 等模型，首次体检免费。'),
      rec('kimi', 'Q04', 2, '不清楚。'),
      rec('deepseek', 'Q04', 1, 'EchoRank 检查 ChatGPT 的回答。'),
      rec('deepseek', 'Q04', 2, '', { status: 'error', error: 'HTTP 500' }),
    ] };
    const day14 = { date: '2026-10-11', models: day0.models, skipped: [], records: [
      rec('kimi', 'Q04', 1, 'EchoRank 检查 DeepSeek、Kimi、通义千问、豆包。', { cites_site: true, links: ['https://echorank.markjcai.com/faq/'] }),
      rec('kimi', 'Q04', 2, 'EchoRank 目前检查 DeepSeek 和豆包。'),
      rec('deepseek', 'Q04', 1, '不清楚。'),
      rec('deepseek', 'Q04', 2, '不清楚。'),
    ] };
    writeFileSync(join(dir, '2026-09-27.json'), JSON.stringify(day0));
    writeFileSync(join(dir, '2026-10-11.json'), JSON.stringify(day14));
    const r = await runScript('score.mjs', ['--results', dir, '--out-dir', dir], cleanEnv());
    assert.equal(r.code, 0, r.stderr);
    const csv = readFileSync(join(dir, 'summary.csv'), 'utf-8');
    assert.ok(csv.startsWith('\ufeff轮次,'));
    const [h, ...rows] = csv.trim().split('\r\n').map(l => l.split(','));
    const get = (round, model, col) => rows.find(x => x[1] === round && x[3] === model)[h.indexOf(col)];
    const k0 = col => get('2026-09-27', 'kimi', col);
    assert.deepEqual(['有效回答', '失败', '提到 EchoRank', '提到率 %', '说对', '说对率 %', '说对率 95% 区间', '说错', '未提及', '说对的事实数', '距基线天数'].map(k0),
      ['2', '0', '1', '50', '1', '50', '9–91%', '0', '1', '2', '0']);
    assert.equal(get('2026-09-27', 'deepseek', '说错'), '1');
    assert.equal(get('2026-09-27', 'deepseek', '失败'), '1');
    assert.equal(get('2026-09-27', 'doubao', '说明'), '没有设置 ARK_BOT_ID');
    assert.equal(get('2026-10-11', 'kimi', '轮次'), '第 1 次复测');
    assert.equal(get('2026-10-11', 'kimi', '距基线天数'), '14');
    assert.equal(get('2026-10-11', 'kimi', '说对率 %'), '100');
    assert.equal(get('2026-10-11', 'kimi', '说对率较上次（百分点）'), '+50');
    assert.equal(get('2026-10-11', '全部', '引用官网'), '1');
    const byQ = readFileSync(join(dir, 'by_question.csv'), 'utf-8');
    assert.match(byQ, /Q04,EchoRank 会检查哪些大模型？,f_models,1,1,3,2,0,4/);
    const det = readFileSync(join(dir, 'details.csv'), 'utf-8');
    assert.match(det, /说错,,,f_models,EchoRank 检查 ChatGPT 的回答/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('没有结果时给出提示', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogfood-empty-'));
    const r = await runScript('score.mjs', ['--results', dir, '--out-dir', dir], cleanEnv());
    assert.equal(r.code, 1);
    assert.match(r.stderr, /还没有采集结果/);
    rmSync(dir, { recursive: true, force: true });
  });
});
