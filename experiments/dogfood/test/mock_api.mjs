// 测试用的假接口：模拟 Kimi / 千问 / 豆包 / DeepSeek 的返回格式，不需要任何真实密钥。
import { createServer } from 'node:http';

export const FAKE_KEYS = {
  KIMI_API_KEY: 'sk-fake-kimi-0123456789',
  DASHSCOPE_API_KEY: 'sk-fake-qwen-0123456789',
  ARK_API_KEY: 'fake-ark-0123456789',
  DEEPSEEK_API_KEY: 'sk-fake-deepseek-0123456789',
};

const ok = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const fail = (res, status, msg) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: msg } })); };
const reply = (model, content, extra = {}) => ({
  id: 'x', model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 10, completion_tokens: 20 }, ...extra,
});

export async function startMockApi() {
  const seen = { kimiRounds: 0, qwenBodies: [], arkBodies: [], flaky: 0, unauthorized: 0 };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const auth = req.headers.authorization || '';
      const path = req.url;
      if (path === '/kimi/chat/completions') {
        if (auth !== 'Bearer ' + FAKE_KEYS.KIMI_API_KEY) return fail(res, 401, 'bad key');
        seen.kimiRounds++;
        if (!body.tools?.some(t => t.function?.name === '$web_search')) return fail(res, 400, 'no search tool');
        const toolMsg = body.messages.find(m => m.role === 'tool');
        if (!toolMsg) {
          return ok(res, {
            model: 'kimi-k2.6',
            choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [
              { id: 'call_1', type: 'builtin_function', function: { name: '$web_search', arguments: JSON.stringify({ search_result: { search_id: 's1' } }) } },
            ] } }],
          });
        }
        if (JSON.parse(toolMsg.content).search_result?.search_id !== 's1') return fail(res, 400, 'tool args not echoed');
        return ok(res, reply('kimi-k2.6-0925', 'EchoRank 是一家 AI 回答体检服务，首次体检免费，限 1 个品牌。详见[官网](https://echorank.markjcai.com/)。'));
      }
      if (path === '/qwen/services/aigc/text-generation/generation') {
        if (auth !== 'Bearer ' + FAKE_KEYS.DASHSCOPE_API_KEY) return fail(res, 401, 'bad key');
        seen.qwenBodies.push(body);
        if (!body.parameters?.enable_search) return fail(res, 400, 'enable_search missing');
        if (!body.input?.messages?.length) return fail(res, 400, 'input.messages missing');
        return ok(res, {
          request_id: 'r1',
          output: {
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '据公开信息，EchoRank 一般 5 个工作日内交付报告。[1]' } }],
            search_info: { search_results: [{ index: 1, title: 'EchoRank', url: 'https://echorank.markjcai.com/#faq', site_name: 'EchoRank' }] },
          },
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        });
      }
      if (path === '/ark/bots/chat/completions') {
        if (auth !== 'Bearer ' + FAKE_KEYS.ARK_API_KEY) return fail(res, 401, 'bad key');
        seen.arkBodies.push(body);
        if (body.model !== 'bot-test-001') return fail(res, 404, 'bot not found');
        return ok(res, reply('bot-test-001', '没有找到关于这个品牌的可靠信息。', {
          references: [{ url: 'https://example.com/a', title: 'A' }],
          bot_usage: { model_usage: [{ name: 'doubao-seed-1-6', prompt_tokens: 1 }] },
        }));
      }
      if (path === '/deepseek/chat/completions') {
        if (auth !== 'Bearer ' + FAKE_KEYS.DEEPSEEK_API_KEY) return fail(res, 401, 'bad key');
        return ok(res, reply('deepseek-chat', 'EchoRank 是一款 SEO 关键词排名工具，官网是 echorank.com。', { system_fingerprint: 'fp_1' }));
      }
      if (path === '/flaky/chat/completions') {
        // 第一次 503，第二次成功：检验重试
        seen.flaky++;
        if (seen.flaky % 2 === 1) return fail(res, 503, 'busy');
        return ok(res, reply('deepseek-chat', '不知道。'));
      }
      if (path === '/denied/chat/completions') {
        seen.unauthorized++;
        return fail(res, 401, `Incorrect API key provided: ${auth.slice(7)}`);
      }
      fail(res, 404, 'unknown path ' + path);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, close: () => new Promise(r => server.close(r)) };
}
