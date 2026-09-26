// 四家模型的调用方式。密钥只从环境变量读，调用时放在请求头里，不写进任何输出。
// 接口地址和模型名以各家官方文档为准，默认值可能过时，用环境变量改即可。

const TIMEOUT_MS = 180_000;

export class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}：${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = String(body);
  }
}

async function postJSON(url, key, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
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

const join = (base, path) => base.replace(/\/+$/, '') + path;
const user = question => [{ role: 'user', content: question }];

function usageOf(data) {
  const u = data.usage || {};
  return { prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null };
}

function urlsFrom(list) {
  return (Array.isArray(list) ? list : []).map(r => r && (r.url || r.link || r.source_url)).filter(Boolean);
}

// Kimi：内置联网搜索 $web_search。模型要搜索时返回 tool_calls，把参数原样交回去，Kimi 自己搜完再回答
async function callKimi(p, key, question) {
  const messages = user(question);
  const tools = [{ type: 'builtin_function', function: { name: '$web_search' } }];
  let searches = 0;
  for (let round = 0; round < 6; round++) {
    const data = await postJSON(join(p.baseUrl, '/chat/completions'), key, { model: p.model, messages, tools });
    const choice = data.choices?.[0] || {};
    const calls = choice.message?.tool_calls || [];
    if (choice.finish_reason === 'tool_calls' && calls.length) {
      messages.push(choice.message);
      for (const tc of calls) {
        if (tc.function?.name === '$web_search') searches++;
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name, content: JSON.stringify(args) });
      }
      continue;
    }
    return {
      answer: choice.message?.content || '',
      model_version: data.model || p.model,
      system_fingerprint: data.system_fingerprint || null,
      search_used: searches > 0,
      sources: [],
      usage: usageOf(data),
    };
  }
  throw new Error('联网搜索超过 6 轮仍没有给出回答');
}

// 通义千问：用 DashScope 原生接口开 enable_search。OpenAI 兼容接口不返回搜索来源，所以这里不用兼容接口
async function callQwen(p, key, question) {
  const data = await postJSON(join(p.baseUrl, '/services/aigc/text-generation/generation'), key, {
    model: p.model,
    input: { messages: user(question) },
    parameters: { result_format: 'message', enable_search: true, search_options: { enable_source: true } },
  });
  const results = data.output?.search_info?.search_results || [];
  const u = data.usage || {};
  return {
    answer: data.output?.choices?.[0]?.message?.content || data.output?.text || '',
    model_version: data.model || p.model,
    system_fingerprint: null,
    search_used: results.length > 0,
    sources: urlsFrom(results),
    usage: { prompt_tokens: u.input_tokens ?? null, completion_tokens: u.output_tokens ?? null },
  };
}

// 豆包（火山方舟）：联网要走控制台里配了联网插件的应用，接口是 bots/chat/completions，model 填应用 ID
async function callDoubao(p, key, question) {
  const data = await postJSON(join(p.baseUrl, '/bots/chat/completions'), key, { model: p.model, messages: user(question) });
  const refs = data.references || data.choices?.[0]?.message?.references || [];
  const used = data.bot_usage?.model_usage?.[0]?.name;
  return {
    answer: data.choices?.[0]?.message?.content || '',
    model_version: used || data.model || p.model,
    system_fingerprint: data.system_fingerprint || null,
    search_used: refs.length > 0 ? true : null,
    sources: urlsFrom(refs),
    usage: usageOf(data),
  };
}

// DeepSeek：不联网，作对照组
async function callPlain(p, key, question) {
  const data = await postJSON(join(p.baseUrl, '/chat/completions'), key, { model: p.model, messages: user(question) });
  return {
    answer: data.choices?.[0]?.message?.content || '',
    model_version: data.model || p.model,
    system_fingerprint: data.system_fingerprint || null,
    search_used: false,
    sources: [],
    usage: usageOf(data),
  };
}

// 每次运行时从环境变量现读，便于测试时换地址
export function getProviders(env = process.env) {
  const list = [
    {
      id: 'kimi', label: 'Kimi', search: '内置联网搜索（$web_search）',
      keyEnv: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
      baseUrl: env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1',
      model: env.KIMI_MODEL || 'kimi-k2.6',
      call: callKimi,
    },
    {
      id: 'qwen', label: '通义千问', search: 'enable_search',
      keyEnv: ['DASHSCOPE_API_KEY'],
      baseUrl: env.DASHSCOPE_NATIVE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1',
      model: env.DASHSCOPE_MODEL || 'qwen-plus',
      call: callQwen,
    },
    {
      id: 'doubao', label: '豆包', search: '联网插件（火山方舟应用）',
      keyEnv: ['ARK_API_KEY'],
      baseUrl: env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
      model: env.ARK_BOT_ID || '',
      needs: { env: 'ARK_BOT_ID', reason: '火山方舟的模型接口本身不联网，联网插件要在控制台创建应用（bot）后才能调用；没有设置 ARK_BOT_ID，跳过豆包' },
      call: callDoubao,
    },
    {
      id: 'deepseek', label: 'DeepSeek', search: '不联网（对照组）',
      keyEnv: ['DEEPSEEK_API_KEY'],
      baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: env.DEEPSEEK_MODEL || 'deepseek-chat',
      call: callPlain,
    },
  ];
  for (const p of list) {
    p.keyName = p.keyEnv.find(k => env[k]) || null;
    p.key = p.keyName ? env[p.keyName] : '';
    if (!p.key) p.skip = `没有设置 ${p.keyEnv[0]}`;
    else if (p.needs && !env[p.needs.env]) p.skip = p.needs.reason;
  }
  return list;
}

// 429、5xx、超时和网络错误重试一次；401 / 403 说明密钥有问题，这一家后面不再调用
export const retryable = e => !(e instanceof HttpError) || e.status === 429 || e.status >= 500;
export const authFailed = e => e instanceof HttpError && (e.status === 401 || e.status === 403);
