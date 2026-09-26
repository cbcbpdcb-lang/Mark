// RAG 评测里不依赖浏览器的判定：标准段落召回、编造、拒答、失败归因。

// 空格、全角半角括号和标点不区分
export function norm(s) {
  return String(s || '')
    .replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[：]/g, ':').replace(/[，]/g, ',').replace(/[；]/g, ';')
    .replace(/\s+/g, '')
    .toLowerCase();
}

// ---------- 标准段落（gold_sources.json，实验计划附录 D） ----------

// "B1-B15" → B1…B15
export function expandIds(list) {
  const out = new Set();
  for (const item of list || []) {
    const m = String(item).match(/^([A-Z]+)(\d+)-(?:[A-Z]+)?(\d+)$/);
    if (!m) { out.add(String(item)); continue; }
    for (let i = Number(m[2]); i <= Number(m[3]); i++) out.add(m[1] + i);
  }
  return out;
}

// 一个应用能检索到的标准段落编号；gold_sources.json 里没写这个应用时不做限制
export function kbOf(gold, app) {
  if (!gold.kb || !(app in gold.kb)) return undefined;
  return gold.kb[app] === null ? null : expandIds(gold.kb[app]);
}

// 空白题：只有 K 开头的补充段落，没有 B 开头的官网段落
export const isBlank = entry => {
  const ids = (entry.gold || []).filter(g => typeof g === 'string');
  return ids.length > 0 && !ids.some(id => id.startsWith('B'));
};

// 这道题在这个应用里的标准段落：字符串是段落编号，只保留应用知识库里有的；对象是手写的 segment_id / document_name / contains
export function visibleGold(entry = {}, kb) {
  if (kb === null) return [];
  return (entry.gold || []).filter(g => typeof g !== 'string' || !kb || kb.has(g));
}

// 应用的知识库里没有这道题的标准段落时期望拒答；不接知识库的应用（A0）只在所有应用都没有标准段落的题上期望拒答
export function expectsRefusal(entry = {}, kb) {
  return (kb === null ? entry.gold || [] : visibleGold(entry, kb)).length === 0;
}

function matchSpec(spec, res) {
  if (typeof spec === 'string') return new RegExp(`[\\[【]${spec}[\\]】]`).test(String(res.content || ''));
  const content = norm(res.content);
  let any = false;
  if (spec.segment_id) { if (res.segment_id !== spec.segment_id) return false; any = true; }
  if (spec.document_name) { if (!String(res.document_name || '').includes(spec.document_name)) return false; any = true; }
  if (spec.contains) { if (!content.includes(norm(spec.contains))) return false; any = true; }
  return any;
}

export function topK(resources, k) {
  return [...(resources || [])].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9)).slice(0, k);
}

// 前 k 段里有没有标准段落。没有标准段落或者没有检索记录时返回 null（不参与召回率）
export function recallHit(run, specs, k = 4) {
  if (!specs?.length || !hasRetrieval(run)) return null;
  return topK(run.retriever_resources, k).some(res => specs.some(s => matchSpec(s, res)));
}

// 应用打开了“引用和归属”才会返回 retriever_resources；旧文件没有这个标记时按有没有数组判断
export function hasRetrieval(run) {
  return run.has_retriever_resources ?? Array.isArray(run.retriever_resources);
}

// ---------- 编造：回答里的具体事实（价格、证照号、日期等）在检索段落里找不到 ----------

const SPECIFIC = [
  ['价格', /[¥￥$]\s*\d[\d,，]*(?:\.\d+)?|\d[\d,，]*(?:\.\d+)?\s*(?:元|块钱|美元|港币)/g],
  ['证照号', /(?<![0-9A-Za-z])(?=[0-9A-Z]{0,17}\d)[0-9A-Z]{15,18}(?![0-9A-Za-z])|(?:备案|许可证?|执照|证书|批准文号|注册)(?:编?号|号码)?[：:\s]*[A-Z]{0,4}\d[0-9A-Z-]{5,}/g],
  ['日期', /\d{4}\s*年(?:\s*\d{1,2}\s*月)?(?:\s*\d{1,2}\s*日)?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日/g],
  ['电话', /(?<!\d)(?:400|800)[-\s]?\d{3}[-\s]?\d{4}(?!\d)|(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g],
  ['折扣比例', /\d+(?:\.\d+)?\s*(?:[-–~至到]\s*\d+(?:\.\d+)?\s*)?折|\d+(?:\.\d+)?\s*%/g],
  ['期限', /\d+\s*(?:[-–~至到]\s*\d+\s*)?个?(?:工作日|天|小时|个月|周)/g],
  ['点数', /\d+\s*(?:个)?(?:产品)?(?:点数|PV)/gi],
];

const numbersIn = s => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(x => String(Number(x)));

export function specifics(text) {
  const out = [];
  const seen = new Set();
  for (const [kind, re] of SPECIFIC) {
    for (const m of String(text || '').matchAll(re)) {
      const v = m[0].trim();
      if (seen.has(kind + v)) continue;
      seen.add(kind + v);
      out.push({ kind, text: v });
    }
  }
  return out;
}

// 证照号要整串出现；其他具体事实里的每个数字都要在检索段落里出现过（05 和 5 视为同一个数）
export function unsupportedSpecifics(answer, resources) {
  const ctx = (resources || []).map(r => r.content || '').join('\n');
  const ctxNorm = norm(ctx);
  const nums = new Set(numbersIn(ctx));
  return specifics(answer).filter(sp => {
    if (sp.kind === '证照号') return !ctxNorm.includes(norm(sp.text.replace(/^[^0-9A-Z]*(?=[A-Z]{0,4}\d)/, '')));
    return !numbersIn(sp.text).every(n => nums.has(n));
  });
}

// ---------- 拒答 ----------

const REFUSAL = /(官网|官方|资料|知识库|现有信息|已知信息|提供的(?:资料|信息|内容)|参考(?:资料|内容))[^。\n]{0,12}(没有|未|并未|暂无|无)(?:提到|说明|提及|相关|记载|明确|包含|涉及|给出)|无法(?:回答|确定|确认|提供|判断)|(?:没有|暂无|缺少)(?:相关|足够|这方面的?)(?:信息|资料|依据)|(?:不|无法)清楚|建议(?:您)?(?:直接)?(?:咨询|联系|询问|查看)[^。\n]{0,10}(?:客服|官方|官网|医生|专业)|抱歉/;

export const isRefusal = text => REFUSAL.test(String(text || ''));

// ---------- 失败归因 ----------
// 前两类由脚本预判：有标准段落时，前 k 段没召回算“检索没召回”，召回了还答错算“召回但生成错”。
// “口径缺失”“口径有歧义”要人看，脚本只给提示
export function autoAttribution(hit) {
  if (hit === true) return '召回但生成错';
  if (hit === false) return '检索没召回';
  return '';
}
