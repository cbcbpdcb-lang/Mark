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
  test('10 个问题，每题对应的事实键都存在', () => {
    assert.equal(qdoc.questions.length, 10);
    assert.equal(new Set(qdoc.questions.map(q => q.id)).size, 10);
    for (const q of qdoc.questions) {
      assert.ok(q.facts?.length, `${q.id} 没有对应的事实键`);
      for (const f of q.facts) assert.ok(compiled.byId.has(f), `${q.id} 引用了不存在的 ${f}`);
    }
  });
  test('每条事实键对应一道题，正则都能编译，官网原文都在', () => {
    for (const f of facts.facts) {
      assert.ok(Q(f.faq), `${f.claim_id} 对应的题 ${f.faq} 不存在`);
      assert.ok(['key', 'marketing'].includes(f.group));
      assert.ok(f.statement && f.source_quote);
    }
  });
  test('每条事实键的官网原文自己能命中 match（写法和产品里的事实键一致）', () => {
    for (const f of compiled.facts) {
      assert.ok(f.matchRe.test(f.source_quote) || f.matchRe.test(f.statement), `${f.claim_id} 的 match 连官网原文都命中不了`);
      if (f.wrongRe) {
        const j = judgeAnswer(`EchoRank：${f.source_quote}`, compiled);
        assert.ok(!j.wrong.some(w => w.claim_id === f.claim_id), `${f.claim_id} 把官网原文判成了说错`);
      }
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
    const r = v('首次体检免费，5 个工作日内交付。', 'Q03');
    assert.equal(r.mentioned, false);
    assert.equal(r.verdict, '未提及');
  });
  test('说到本题的事实键算说对；说到别的题的事实不算本题说对', () => {
    assert.equal(v('EchoRank 首次体检免费，限 1 个品牌。', 'Q03').verdict, '说对');
    assert.equal(v('EchoRank 首次体检免费。', 'Q05').verdict, '未提及');
    assert.equal(v('EchoRank 一般 5 个工作日内交付第一份报告。', 'Q05').verdict, '说对');
  });
  test('只聊到话题不算说对（事实键要说出数字、条件或网址）', () => {
    assert.equal(v('EchoRank 的收费比较灵活，可以咨询客服。', 'Q03').verdict, '未提及');
    assert.equal(v('EchoRank 交付很快。', 'Q05').verdict, '未提及');
    assert.equal(v('EchoRank 有自己的官网。', 'Q09').verdict, '未提及');
  });
  test('说错优先于说对', () => {
    const r = v('EchoRank 是一款 SEO 关键词排名工具，官网是 echorank.markjcai.com。', 'Q09');
    assert.equal(r.verdict, '说错');
    assert.deepEqual(r.wrong.map(w => w.claim_id), ['f_what']);
  });
  test('否定句不算说错', () => {
    assert.equal(v('EchoRank 不是 SEO 工具，而是 AI 回答体检服务。', 'Q01').verdict, '说对');
    assert.equal(v('EchoRank 首次体检不收费。', 'Q03').verdict, '未提及');
    assert.equal(v('EchoRank 不需要你提供后台账号或数据权限。', 'Q06').verdict, '说对');
    assert.equal(v('EchoRank 并不代写软文，先核实 AI 说得对不对。', 'Q07').verdict, '说对');
  });
  test('各条 wrong 规则', () => {
    assert.equal(v('EchoRank 首次体检收费 999 元。', 'Q03').verdict, '说错');
    assert.equal(v('EchoRank 通常需要 2–4 周交付报告。', 'Q05').verdict, '说错');
    assert.equal(v('EchoRank 一般 5 个工作日交付，两周后复测。', 'Q05').verdict, '说对');
    assert.equal(v('使用 EchoRank 需要提供后台账号。', 'Q06').verdict, '说错');
    assert.equal(v('EchoRank 会批量发布软文。', 'Q07').verdict, '说错');
    assert.equal(v('EchoRank 的官网是 echorank.com。', 'Q09').verdict, '说错');
    assert.equal(v('EchoRank 检查 ChatGPT 和 Gemini 的回答。', 'Q10').verdict, '说错');
    assert.equal(v('EchoRank 检查 DeepSeek、豆包、元宝、Kimi、千问。', 'Q10').verdict, '说对');
  });
  test('需要同句提到品牌的 wrong：别人批量发内容不算 EchoRank 说错', () => {
    assert.equal(v('EchoRank 先核实 AI 说得对不对。代运营通常靠批量发内容。', 'Q07').verdict, '说对');
    assert.equal(v('EchoRank 和 GEO 代运营不同，代运营通常靠批量发内容，EchoRank 先核实。', 'Q07').verdict, '说对');
    assert.equal(v('和别的工具不同，EchoRank 不看 ChatGPT，只看 DeepSeek、豆包、Kimi。', 'Q10').verdict, '说对');
  });
  test('关键事实只看本题', () => {
    assert.equal(v('EchoRank 首次体检免费。', 'Q03').keyRight, true);
    assert.equal(v('EchoRank 是 AI 回答体检服务。', 'Q01').keyRight, false);
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
      rec('kimi', 'Q03', 1, 'EchoRank 首次体检免费。'),
      rec('kimi', 'Q03', 2, '不清楚。'),
      rec('deepseek', 'Q03', 1, 'EchoRank 首次体检收费 999 元。'),
      rec('deepseek', 'Q03', 2, '', { status: 'error', error: 'HTTP 500' }),
    ] };
    const day14 = { date: '2026-10-11', models: day0.models, skipped: [], records: [
      rec('kimi', 'Q03', 1, 'EchoRank 首次体检免费。', { cites_site: true, links: ['https://echorank.markjcai.com/faq/'] }),
      rec('kimi', 'Q03', 2, 'EchoRank 首次体检免费，限 1 个品牌。'),
      rec('deepseek', 'Q03', 1, '不清楚。'),
      rec('deepseek', 'Q03', 2, '不清楚。'),
    ] };
    writeFileSync(join(dir, '2026-09-27.json'), JSON.stringify(day0));
    writeFileSync(join(dir, '2026-10-11.json'), JSON.stringify(day14));
    const r = await runScript('score.mjs', ['--results', dir, '--out-dir', dir], cleanEnv());
    assert.equal(r.code, 0, r.stderr);
    const csv = readFileSync(join(dir, 'summary.csv'), 'utf-8');
    assert.ok(csv.startsWith('﻿轮次,'));
    const rows = csv.trim().split('\r\n').map(l => l.split(','));
    const find = (round, model) => rows.find(x => x[1] === round && x[2] === model);
    // 轮次, 采集, 模型, 联网方式, 有效回答, 失败, 提到, 提到率, 引用官网, 引用率, 说对, 说对率, 区间, 说错, 未提及, 关键事实, 变化, 说明
    assert.deepEqual(find('2026-09-27', 'kimi').slice(4, 16), ['2', '0', '1', '50', '0', '0', '1', '50', '9–91%', '0', '1', '1']);
    assert.deepEqual(find('2026-09-27', 'deepseek').slice(4, 16), ['1', '1', '1', '100', '0', '0', '0', '0', '0–79%', '1', '0', '0']);
    assert.equal(find('2026-09-27', 'doubao')[17], '没有设置 ARK_BOT_ID');
    assert.equal(find('2026-10-11', 'kimi')[0], '第 1 次复测');
    assert.equal(find('2026-10-11', 'kimi')[11], '100');
    assert.equal(find('2026-10-11', 'kimi')[16], '+50');
    assert.equal(find('2026-10-11', '全部')[8], '1');
    const byQ = readFileSync(join(dir, 'by_question.csv'), 'utf-8');
    assert.match(byQ, /Q03,EchoRank 的 AI 回答体检怎么收费？,f_pricing,1,1,3,2,0,4/);
    const det = readFileSync(join(dir, 'details.csv'), 'utf-8');
    assert.match(det, /说错,,f_pricing,EchoRank 首次体检收费 999 元/);
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
