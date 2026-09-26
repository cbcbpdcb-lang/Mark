// node --test experiments/rag_eval/test/*.test.mjs
// 不需要 Dify 密钥：run.mjs 对着本机模拟的 chat-messages 接口跑；score.mjs 和 export_questions.mjs 需要 Playwright，找不到时跳过。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { HERE, INTERNAL_PAGE, REPO, launch, loadChromium, openApp } from '../browser.mjs';
import { autoAttribution, expandIds, expectsRefusal, isBlank, isRefusal, kbOf, norm, recallHit, specifics, unsupportedSpecifics, visibleGold } from '../rag_lib.mjs';

const exec = promisify(execFile);
const KEYS = { DIFY_KEY_A0: 'app-fake-a0-123456', DIFY_KEY_B: 'app-fake-b-123456', DIFY_KEY_C1: 'app-fake-c1-123456', DIFY_KEY_C2: 'app-fake-c2-123456' };
const REFUND_QUOTE = '仓库收到退回产品，审核确认不影响二次销售，一般在5个工作日内原路退回支付账户，退货后该订单所获回馈点数将扣回。';

function cleanEnv(extra = {}) {
  const env = { ...process.env, RAG_PAUSE_MS: '0', RAG_RETRY_WAIT_MS: '0' };
  for (const k of ['DIFY_BASE_URL', ...Object.keys(KEYS)]) delete env[k];
  return { ...env, ...extra };
}
async function runScript(script, argv, env) {
  try {
    const r = await exec(process.execPath, [join(HERE, script), ...argv], { env, cwd: REPO, maxBuffer: 1 << 24 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}
let hasBrowser = false;
try { await loadChromium(); hasBrowser = true; } catch {}
const needBrowser = hasBrowser ? {} : { skip: '没有 Playwright（在 experiments/rag_eval 里 npm install）' };

describe('rag_lib', () => {
  test('归一化：空格和全角半角括号不区分', () => {
    assert.equal(norm('有限责任公司（港澳台 法人独资）'), norm('有限责任公司(港澳台法人独资)'));
  });
  test('标准段落按应用的知识库过滤；空白题和应拒答题的判定', () => {
    const gold = JSON.parse(readFileSync(join(HERE, 'gold_sources.json'), 'utf-8'));
    assert.equal(gold.version, 'final-1');
    assert.equal(expandIds(['B1-B15', 'K1-K17']).size, 32);
    const [A0, B, C1, C2] = ['A0', 'B', 'C1', 'C2'].map(a => kbOf(gold, a));
    assert.equal(A0, null);
    const q = gold.questions;
    assert.deepEqual(visibleGold(q.q_bt_06, B), ['B12']);
    assert.deepEqual(visibleGold(q.q_bt_06, C1), ['B12', 'K6', 'K17']);
    assert.deepEqual(visibleGold(q.q_bt_06, C2), ['B12', 'K6', 'K17', 'K18']);
    assert.deepEqual(visibleGold(q.q_bt_06, A0), []);
    // 空白题：只有 K 段落
    const blanks = Object.keys(q).filter(id => isBlank(q[id]));
    assert.deepEqual(blanks, ['q_bt_01', 'q_bt_02', 'q_bt_05', 'q_ef_02', 'q_ef_03', 'q_ef_04', 'q_ef_05', 'q_ef_06', 'q_sf_02', 'q_sf_03', 'q_sf_06', 'q_pr_01', 'q_jo_05']);
    // 应拒答：B 组在空白题和“无”题上；C1 看不到 K18、K19，所以 q_bt_05 也该拒答；A0 只在“无”题上
    const refuse = kb => Object.keys(q).filter(id => expectsRefusal(q[id], kb));
    const none = ['q_sf_04', 'q_sf_05', 'q_pr_04', 'q_pr_06', 'q_jo_06'];
    assert.deepEqual(refuse(B).sort(), [...blanks, ...none].sort());
    assert.deepEqual(refuse(C1).sort(), ['q_bt_05', ...none].sort());
    assert.deepEqual(refuse(C2), none);
    assert.deepEqual(refuse(A0), none);
  });
  const KB = join(HERE, 'kb');
  test('知识库文件和标准段落对得上：每个编号都在对应应用的知识库里', existsSync(join(KB, 'kb_B.md')) ? {} : { skip: '还没有 kb/ 里的知识库文件' }, () => {
    const gold = JSON.parse(readFileSync(join(HERE, 'gold_sources.json'), 'utf-8'));
    const ids = f => [...readFileSync(join(KB, f), 'utf-8').matchAll(/^\[([BK]\d+)\]/gm)].map(m => m[1]);
    const B = ids('kb_B.md'), C1 = [...B, ...ids('kb_C1_add.md')], C2 = [...C1, ...ids('kb_C2_add.md')];
    assert.deepEqual([...kbOf(gold, 'B')], B);
    assert.deepEqual([...kbOf(gold, 'C1')], C1);
    assert.deepEqual([...kbOf(gold, 'C2')], C2);
    for (const [q, e] of Object.entries(gold.questions)) for (const id of e.gold) assert.ok(C2.includes(id), `${q} 的 ${id} 不在知识库里`);
  });
  test('召回：只看前 4 段；段落编号 [B8] 或手写 gold 命中都算', () => {
    const seg = (position, content, extra = {}) => ({ position, content, ...extra });
    const other = [1, 2, 3, 4].map(i => seg(i, '无关段落 ' + i));
    assert.equal(recallHit({ retriever_resources: [seg(1, '[B8] ' + REFUND_QUOTE)] }, ['B8'], 4), true);
    assert.equal(recallHit({ retriever_resources: [seg(1, '【B8】退款')] }, ['B8'], 4), true);
    assert.equal(recallHit({ retriever_resources: [seg(1, '[B80] 别的')] }, ['B8'], 4), false);
    assert.equal(recallHit({ retriever_resources: [...other, seg(5, '[B8] ' + REFUND_QUOTE)] }, ['B8'], 4), false);
    assert.equal(recallHit({ retriever_resources: [seg(1, 'x', { segment_id: 's9' })] }, [{ segment_id: 's9' }], 4), true);
    assert.equal(recallHit({ retriever_resources: [seg(1, 'x', { document_name: 'FAQ.md' })] }, [{ document_name: 'FAQ', contains: 'y' }], 4), false);
    assert.equal(recallHit({ retriever_resources: [] }, [], 4), null);          // 没有标准段落
    assert.equal(recallHit({ has_retriever_resources: false, retriever_resources: [] }, ['B8'], 4), null);   // 没有检索记录
  });
  test('具体事实：价格、证照号、日期、电话、折扣、期限、点数', () => {
    const kinds = specifics('售价 ¥299，备案编号 YB13101060018558，2014年5月28日成立，客服 400-920-9191，享 7.5 折，7-15 个工作日退款，首单 125 点数').map(s => s.kind);
    for (const k of ['价格', '证照号', '日期', '电话', '折扣比例', '期限', '点数']) assert.ok(kinds.includes(k), k);
  });
  test('编造：具体事实在检索段落里找不到；05 和 5 算同一个数', () => {
    const res = [{ content: '成立日期 2014年05月28日；优惠顾客价格约为零售价的6.5-7折；' + REFUND_QUOTE }];
    assert.deepEqual(unsupportedSpecifics('2014年5月28日成立，6.5-7 折，5 个工作日退款。', res), []);
    assert.deepEqual(unsupportedSpecifics('7.5 折，运费 20 元，统一社会信用代码 91310000094218999X。', res).map(s => s.kind), ['价格', '证照号', '折扣比例']);
    assert.deepEqual(unsupportedSpecifics('可以退货。', []), []);
  });
  test('拒答', () => {
    assert.ok(isRefusal('抱歉，官网资料没有说明这一点，建议咨询客服。'));
    assert.ok(isRefusal('根据提供的资料，未提及能否内服。'));
    assert.ok(!isRefusal('一般 5 个工作日内原路退回。'));
  });
  test('归因预判只分前两类', () => {
    assert.equal(autoAttribution(true), '召回但生成错');
    assert.equal(autoAttribution(false), '检索没召回');
    assert.equal(autoAttribution(null), '');
  });
});

// 模拟 Dify：按密钥认应用，按问题给回答和检索段落
const TAGGED = '[B8] ' + REFUND_QUOTE;
const K15 = '[K15] 孕妇、哺乳期女性和儿童使用精油前，请先咨询医生。';
const SCRIPT = {
  A0: {
    q1: ['多特瑞退货后，一般 7-15 个工作日到账。', [{ position: 1, document_name: '公司介绍', segment_id: 'a1', content: '公司成立于2014年。' }]],
    q2: ['<think>想一想</think>这款精油孕妇可以放心使用。', []],
  },
  B: {
    q1: ['多特瑞退货一般 5 个工作日内原路退款，这条规则 2019 年起执行。', [1, 2, 3, 4].map(i => ({ position: i, document_name: '无关' + i, content: '无关段落' + i })).concat([{ position: 5, document_name: '帮助中心', content: TAGGED }])],
    q2: ['抱歉，官网资料没有说明孕妇能否使用，建议咨询医生。', []],
  },
  C1: {
    q1: ['多特瑞的退款规则：仓库收到退回产品，审核确认不影响二次销售，一般在5个工作日内原路退回支付账户。', [{ position: 1, document_name: '帮助中心', content: TAGGED }]],
    q2: ['根据补充材料，孕妇和儿童使用前应先咨询医生。', [{ position: 1, document_name: '补充材料', content: K15 }]],
  },
  C2: {
    q1: ['多特瑞退货后会退款。', [{ position: 1, document_name: '帮助中心', content: TAGGED }]],
    q2: ['抱歉，官网资料没有说明孕妇能否使用。', [{ position: 1, document_name: '补充材料', content: K15 }]],
  },
};
const QUESTIONS = { query_set_version: 1, source: 'test', queries: [{ id: 'q_jo_02', text: 'q1' }, { id: 'q_sf_02', text: 'q2' }] };

describe('run.mjs', () => {
  let server, base, dir, calls = 0;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rag-'));
    writeFileSync(join(dir, 'questions.json'), JSON.stringify(QUESTIONS));
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        calls++;
        const body = JSON.parse(raw || '{}');
        const app = Object.keys(KEYS).find(k => req.headers.authorization === 'Bearer ' + KEYS[k])?.replace('DIFY_KEY_', '');
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.url !== '/v1/chat-messages') return send(404, { message: 'not found' });
        if (!app) return send(401, { code: 'unauthorized', message: `Access token is invalid: ${String(req.headers.authorization).slice(7)}` });
        if (body.response_mode !== 'blocking' || body.conversation_id !== '' || !body.user) return send(400, { message: 'bad body' });
        const [answer, resources] = SCRIPT[app][body.query];
        send(200, { event: 'message', message_id: 'm-' + calls, conversation_id: 'c-' + calls, answer,
          metadata: { usage: { prompt_tokens: 5, completion_tokens: 7 }, retriever_resources: resources.map(r => ({ dataset_id: 'd', document_id: 'doc', score: 0.5, ...r })) } });
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/v1`;
  });
  after(async () => {
    await new Promise(r => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  test('没有 DIFY_BASE_URL 或密钥：退出码 1，列出要设置的环境变量', async () => {
    for (const env of [cleanEnv(KEYS), cleanEnv({ DIFY_BASE_URL: base })]) {
      const r = await runScript('run.mjs', ['--questions', join(dir, 'questions.json'), '--out', join(dir, 'x.json')], env);
      assert.equal(r.code, 1);
      for (const k of ['DIFY_BASE_URL', 'DIFY_KEY_A0', 'DIFY_KEY_B', 'DIFY_KEY_C1', 'DIFY_KEY_C2']) assert.match(r.stderr, new RegExp(k));
    }
    assert.equal(existsSync(join(dir, 'x.json')), false);
  });

  test('4 个应用 × 2 题 × 2 次 = 16 条，格式和 collect.py 一致，保存检索段落，密钥不落盘', async () => {
    const out = join(dir, 'runs.json');
    const r = await runScript('run.mjs', ['--questions', join(dir, 'questions.json'), '--out', out], cleanEnv({ DIFY_BASE_URL: base, ...KEYS }));
    assert.equal(r.code, 0, r.stderr);
    const text = readFileSync(out, 'utf-8');
    for (const k of Object.values(KEYS)) assert.ok(!text.includes(k) && !r.stdout.includes(k));
    const doc = JSON.parse(text);
    assert.equal(doc.runs.length, 16);
    assert.deepEqual(doc.apps, ['A0', 'B', 'C1', 'C2']);
    for (const run of doc.runs) {
      for (const f of ['run_id', 'engine', 'query_id', 'repeat', 'status', 'raw', 'started_at', 'model', 'latency_ms', 'input_tokens', 'output_tokens']) assert.ok(f in run, f);
      assert.equal(run.status, 'SUCCESS');
    }
    const a0 = doc.runs.find(x => x.app === 'A0' && x.query_id === 'q_sf_02');
    assert.equal(a0.raw, '这款精油孕妇可以放心使用。');   // <think> 去掉，单独存
    assert.equal(a0.think, '<think>想一想</think>');
    const b = doc.runs.find(x => x.app === 'B' && x.query_id === 'q_jo_02');
    assert.equal(b.retriever_resources.length, 5);
    assert.equal(b.retriever_resources[4].content, TAGGED);
    assert.equal(b.engine, 'dify_b');
    copyFileSync(out, join(dir, 'keep.json'));
  });

  test('密钥错误：这个应用停下，报错里的密钥被遮掉', async () => {
    const out = join(dir, 'bad.json');
    const r = await runScript('run.mjs', ['--questions', join(dir, 'questions.json'), '--out', out, '--only', 'A0'], cleanEnv({ DIFY_BASE_URL: base, DIFY_KEY_A0: 'app-wrong-key-999' }));
    assert.equal(r.code, 2);
    const doc = JSON.parse(readFileSync(out, 'utf-8'));
    assert.equal(doc.runs.length, 4);
    assert.ok(doc.runs.every(x => x.status === 'ERROR'));
    assert.ok(!readFileSync(out, 'utf-8').includes('app-wrong-key-999'));
  });

  test('score.mjs：各项指标、失败归因和对比图', needBrowser, async () => {
    // 用仓库里的定稿标准段落：q_jo_02 是 B8、K3，q_sf_02（空白题）是 K15
    const r = await runScript('score.mjs', [join(dir, 'keep.json'), '--out-dir', dir], cleanEnv());
    assert.equal(r.code, 0, r.stderr);
    const rows = readFileSync(join(dir, 'summary.csv'), 'utf-8').replace(/^﻿/, '').trim().split('\r\n').map(l => l.split(','));
    const h = rows[0];
    const get = (app, col) => rows.find(x => x[0] === app)[h.indexOf(col)];
    // A0：不接知识库。退款说成 7–15 个工作日 → 待确认，数字不在检索段落里 → 编造；空白题没依据；这两题都不在 A0 的应拒答范围
    assert.equal(get('A0', '待确认'), '2');
    assert.equal(get('A0', '编造'), '2');
    assert.equal(get('A0', '空白题回答'), '2');
    assert.equal(get('A0', '空白题有依据'), '0');
    assert.equal(get('A0', '应拒答的回答'), '0');
    assert.equal(get('A0', '有标准段落的回答'), '0');
    // B：说对 5 个工作日，但 B8 排在第 5 段，前 4 段没召回；“2019 年”编造；空白题知识库里没有 K15，恰当拒答
    assert.equal(get('B', '关键事实说对'), '2');
    assert.equal(get('B', '编造'), '2');
    assert.equal(get('B', '应拒答的回答'), '2');
    assert.equal(get('B', '恰当拒答'), '2');
    assert.equal(get('B', '前 4 段召回'), '0');
    // C1：两题都对
    assert.equal(get('C1', '关键事实说对'), '2');
    assert.equal(get('C1', '空白题有依据'), '2');
    assert.equal(get('C1', '编造'), '0');
    assert.equal(get('C1', '前 4 段召回'), '4');
    assert.equal(get('C1', `检索召回率（前 4 段）%`), '100');
    // C2：召回了却没说对；检索到 K15 却拒答
    assert.equal(get('C2', '关键事实说对'), '0');
    assert.equal(get('C2', '恰当拒答'), '0');
    assert.equal(get('C2', '空白题有依据'), '0');

    const [headerF, ...fails] = readFileSync(join(dir, 'failures.csv'), 'utf-8').replace(/^﻿/, '').trim().split('\r\n').map(l => l.split(','));
    const col = name => headerF.indexOf(name);
    const f = (app, q) => fails.filter(x => x[0] === app && x[1] === q);
    assert.equal(f('C1', 'q_jo_02').length, 0);
    assert.match(f('A0', 'q_jo_02')[0][col('问题类型')], /待确认.*编造/);
    assert.equal(f('A0', 'q_jo_02')[0][col('归因（脚本预判）')], '');
    assert.equal(f('B', 'q_jo_02')[0][col('标准段落和期望')], 'B8 K3');
    assert.equal(f('B', 'q_jo_02')[0][col('归因（脚本预判）')], '检索没召回');
    assert.equal(f('B', 'q_sf_02').length, 0);
    assert.equal(f('C2', 'q_jo_02')[0][col('问题类型')], '没说对官方口径');
    assert.equal(f('C2', 'q_jo_02')[0][col('归因（脚本预判）')], '召回但生成错');
    assert.equal(f('C2', 'q_sf_02')[0][col('问题类型')], '空白题没有依据回答');
    assert.equal(f('A0', 'q_sf_02')[0][col('问题类型')], '空白题没有依据回答');
    const png = readFileSync(join(dir, 'compare.png'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
  });
});

describe('和产品页的一致性', needBrowser, () => {
  test('export_questions.mjs 导出 30 题，和仓库里的问题集一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-q-'));
    const r = await runScript('export_questions.mjs', ['--out', join(dir, 'q.json')], cleanEnv());
    assert.equal(r.code, 0, r.stderr);
    const got = JSON.parse(readFileSync(join(dir, 'q.json'), 'utf-8'));
    assert.equal(got.queries.length, 30);
    const repo = JSON.parse(readFileSync(join(REPO, 'queries_多特瑞.json'), 'utf-8'));
    assert.deepEqual(got.queries.map(q => [q.id, q.text]), repo.queries.map(q => [q.id, q.text]));
    const gold = JSON.parse(readFileSync(join(HERE, 'gold_sources.json'), 'utf-8'));
    assert.deepEqual(Object.keys(gold.questions), got.queries.map(q => q.id));
    rmSync(dir, { recursive: true, force: true });
  });

  test('把产品里 R3 的 240 条回答当成一个应用交给 score.mjs，数字和公开版报告一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-r3-'));
    const browser = await launch();
    let runs;
    try {
      const page = await openApp(browser, INTERNAL_PAGE);
      runs = await page.evaluate(() => REAL_RUNS.filter(r => r.batch === 'R3').map(r => ({
        run_id: r.run_id, engine: 'dify_a0', app: 'A0', query_id: r.query_id, repeat: r.repeat, status: r.status, raw: r.raw,
        has_retriever_resources: false, retriever_resources: [],
      })));
    } finally {
      await browser.close();
    }
    writeFileSync(join(dir, 'r3.json'), JSON.stringify({ runs }));
    const r = await runScript('score.mjs', [join(dir, 'r3.json'), '--out-dir', dir], cleanEnv());
    assert.equal(r.code, 0, r.stderr);
    const [h, row] = readFileSync(join(dir, 'summary.csv'), 'utf-8').replace(/^﻿/, '').trim().split('\r\n').map(l => l.split(','));
    const get = col => row[h.indexOf(col)];
    // 公开版体检报告：说对且有依据 76/240，关键事实 12，待确认 16，说错 2
    assert.equal(get('有效回答'), '240');
    assert.equal(get('说对且有依据'), '76');
    assert.equal(get('关键事实说对'), '12');
    assert.equal(get('待确认'), '16');
    assert.equal(get('说错'), '2');
    rmSync(dir, { recursive: true, force: true });
  });
});
