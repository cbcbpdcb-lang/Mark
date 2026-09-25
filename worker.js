/**
 * EchoRank 采集服务（Cloudflare Worker）
 *
 * 作用：让部署在你自己域名上的 EchoRank 网页能够
 *   1. 读取官网页面并抽取候选事实        POST /facts    {url, product}
 *   2. 用国产模型 API 跑一段对话（支持多轮） POST /chat     {engine, messages}
 *   3. 用模型抽取回答里的理由             POST /reasons  {prompt}
 * 密钥只存在 Worker 的 Secrets 里，网页里没有任何密钥。
 *
 * 部署（不需要命令行）：
 *   1. Cloudflare 后台 → Workers & Pages → Create → Worker，名字填 echorank-api，把本文件全部内容粘贴进编辑器，Deploy。
 *   2. 该 Worker 的 Settings → Variables and Secrets，逐个添加 Secret：
 *        ACCESS_TOKEN      你自己设一串口令，网页里要填同一串
 *        DEEPSEEK_API_KEY  MOONSHOT_API_KEY  DASHSCOPE_API_KEY  ARK_API_KEY
 *        ARK_MODEL         火山方舟的模型名或接入点 ID（例如 doubao-seed-2-0-lite-260428）
 *        MOONSHOT_MODEL    例如 kimi-k3（可选，默认 kimi-k3）
 *        DASHSCOPE_MODEL   例如 qwen3.7-plus（可选，默认 qwen-plus）
 *        DEEPSEEK_MODEL    可选，默认 deepseek-chat
 *   3. 把 Worker 的地址（https://echorank-api.xxx.workers.dev）和 ACCESS_TOKEN 填进 EchoRank「分析一个产品」页。
 *
 * 限制：单次请求最多 8 轮消息；每次读取官网最多 60,000 字符；只允许 http/https 网址。
 */

const PROVIDERS = {
  deepseek:   { base: 'https://api.deepseek.com',                             key: 'DEEPSEEK_API_KEY',  model: 'DEEPSEEK_MODEL',  def: 'deepseek-chat', temperature: 0.7 },
  kimi:       { base: 'https://api.moonshot.cn/v1',                          key: 'MOONSHOT_API_KEY',  model: 'MOONSHOT_MODEL',  def: 'kimi-k3',       temperature: 1 },
  qwen:       { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',   key: 'DASHSCOPE_API_KEY', model: 'DASHSCOPE_MODEL', def: 'qwen-plus',     temperature: 0.7 },
  doubao_api: { base: 'https://ark.cn-beijing.volces.com/api/v3',            key: 'ARK_API_KEY',       model: 'ARK_MODEL',       def: '',              temperature: 0.7 },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Token',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

async function chat(env, engine, messages, temperature) {
  const p = PROVIDERS[engine];
  if (!p) throw new Error('未知引擎 ' + engine);
  const key = env[p.key];
  if (!key) throw new Error('Worker 里没有设置 ' + p.key);
  const model = env[p.model] || p.def;
  if (!model) throw new Error('Worker 里没有设置 ' + p.model);
  const res = await fetch(p.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model, messages, temperature: temperature ?? p.temperature }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return { text: data.choices?.[0]?.message?.content || '', model: data.model || model, usage: data.usage || {} };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h\d|tr|br|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

const factPrompt = (product, text) => `你是产品事实抽取器。只根据下面【页面文字】抽取关于产品「${product}」的可核实事实。不要推测，不要使用页面以外的知识。
只输出 JSON，不要任何解释或代码块标记，格式：
{"facts":[{"type":"capability|price|limitation|positioning","statement":"一句话事实","match":"用于在 AI 回答里识别这条事实的关键词，多个用 | 分隔","quote":"从页面文字中逐字复制的原句","plan":"套餐名，仅 price 类填写","price":数字或 null,"valid_from":"YYYY-MM-DD，页面没写就留空字符串"}]}
规则：quote 必须逐字出现在页面文字中；页面没写的日期一律留空；limitation 写成“暂不支持……”；最多 20 条。
【页面文字】
${text.slice(0, 12000)}`;

function parseJSON(text) {
  const clean = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch (e) {
    const m = clean.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
    throw new Error('模型返回的不是有效 JSON');
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return json({ error: '只接受 POST' }, 405);
    if (!env.ACCESS_TOKEN || request.headers.get('X-Token') !== env.ACCESS_TOKEN) return json({ error: '口令不对' }, 401);
    const url = new URL(request.url);
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: '请求体不是 JSON' }, 400); }
    try {
      if (url.pathname === '/chat') {
        const messages = Array.isArray(body.messages) ? body.messages.slice(-8) : null;
        if (!messages || !messages.length) return json({ error: '缺少 messages' }, 400);
        const out = await chat(env, body.engine, messages, body.temperature);
        return json(out);
      }
      if (url.pathname === '/facts') {
        const target = String(body.url || '');
        if (!/^https?:\/\//.test(target)) return json({ error: '只接受 http/https 网址' }, 400);
        const page = await fetch(target, { headers: { 'User-Agent': 'EchoRank-facts/1.0' } });
        if (!page.ok) return json({ error: '官网返回 HTTP ' + page.status }, 502);
        const text = stripHtml(await page.text()).slice(0, 60000);
        if (text.length < 50) return json({ error: '页面文字太少，可能是动态渲染的页面，请改为粘贴文字' }, 422);
        const out = await chat(env, body.engine || 'deepseek', [{ role: 'user', content: factPrompt(String(body.product || ''), text) }], 0.2);
        const data = parseJSON(out.text);
        return json({ text, facts: Array.isArray(data.facts) ? data.facts : [], model: out.model });
      }
      if (url.pathname === '/reasons') {
        if (!body.prompt) return json({ error: '缺少 prompt' }, 400);
        const out = await chat(env, body.engine || 'deepseek', [{ role: 'user', content: String(body.prompt) }], 0.2);
        return json(parseJSON(out.text));
      }
      return json({ error: '未知路径' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
