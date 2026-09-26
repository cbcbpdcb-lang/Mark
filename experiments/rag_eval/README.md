# RAG 评测：品牌 A 的四个 Dify 应用

用产品里品牌 A 的 30 个问题去问四个 Dify 应用（A0 / B / C1 / C2），每题问 2 次，再用产品自己的 `evaluate()` 和品牌 A 的事实底账打分，比较哪种知识库和检索配置说得最准。结果只放在仓库里，不上官网。

## 准备

```bash
cd experiments/rag_eval
npm install                      # 装 Playwright（打分和导出问题要用）
npx playwright install chromium
cd ../..
cp .env.example .env             # 填 DIFY_BASE_URL 和四个 DIFY_KEY_*
source .env
```

每个 Dify 应用都要在“功能”里打开“引用和归属”。不打开的话，接口不会返回 `retriever_resources`，检索召回率和编造就没法判定。

## 跑法（在仓库根目录）

```bash
node experiments/rag_eval/export_questions.mjs   # 从 PRESETS.direct_a 导出 30 题 → questions.json（仓库里已有一份）
node experiments/rag_eval/run.mjs --dry-run      # 看计划
node experiments/rag_eval/run.mjs                # 调用 4 个应用，写到 results/YYYY-MM-DD.json
node experiments/rag_eval/score.mjs              # 给最新一次采集打分
```

- `run.mjs` 调用的是 Dify 的 `chat-messages` 接口，阻塞模式。每次调用都开一个新会话。
  - 结果保存回答原文和 `metadata.retriever_resources`，格式和 `collect.py` 的运行记录一致，可以直接交给 `evaluate()`。
  - 回答里的 `<think>` 段会单独存进 `think` 字段，不参与打分。
  - 选项和监测脚本相同：`--only A0,C1`、`--limit 3`、`--repeats 2`、`--out`、`--force`。
- `score.mjs` 默认打开 `dist/app/index.html`，也就是本地构建的公开版 `/app/`。没有这个文件时，会先运行 `build_public.py` 生成。
  - 公开版的事实底账已经匿名，所以回答会先用内部版的同一套匿名规则处理，再交给 `evaluate()`。浏览器端代码没有改。
  - 加 `--page index.html` 就改用内部版打分。两者只在公司信息这类被隐藏的口径上有差别。
  - 可以一次传几个结果文件合并计算。

## 输出

| 文件 | 内容 |
| --- | --- |
| `summary.csv` | 每个应用一行，列出下面的指标 |
| `failures.csv` | 每条有问题的回答一行：问题类型、详情、前 4 段有没有召回标准段落、归因 |
| `compare.png` | A0 / B / C1 / C2 对比图 |

## 指标

以下定义是按需求卡先写的，实验计划原文到了之后再核对。

| 指标 | 算法 |
| --- | --- |
| 说错 | 产品的 `isWrongRun`：有一处说法和官方说明冲突（说反、无依据、过期、错误归属、定位偏差、替品牌宣称疗效） |
| 待确认 | 产品的 `isPendingRun`：数字和官方口径对不上，比如折扣说成 7.5 折、退款说成 7–15 个工作日 |
| 关键事实说对率 | 说对且有依据、且说对的是购买关键事实（`rightLayer` 为 key）的回答 ÷ 有效回答 |
| 空白题有依据回答率 | 空白题（官网没有口径的 7 题）里，没拒答、前 4 段召回了标准段落、也没有编造的回答 ÷ 空白题回答 |
| 恰当拒答率 | 空白题里，前 4 段没有标准段落、回答明确说资料里没有或建议咨询的 ÷ 空白题回答 |
| 编造率 | 回答里出现价格、证照号、日期、电话、折扣、期限、点数等具体事实，但检索段落里找不到 ÷ 有检索记录的回答 |
| 检索召回率（前 4 段） | 前 4 段里有标准段落的回答 ÷ 有标准段落的回答 |

`gold_sources.json` 为每道题写明：
- 是否空白题；
- 对应事实底账里的哪几条口径（`claims`）；
- 手写的标准段落（`gold`，可以写 `segment_id`、`document_name`、`contains`）。

一段检索结果只要包含这些口径的官网原文片段，或者命中任一条 `gold`，就算召回。现有内容是按事实底账起草的，**要对照实验计划和知识库的实际分段再核对一遍**。空白题的 `gold` 先空着；如果某个应用的知识库补了这些口径，就在这里写上对应段落。

## 失败归因

`failures.csv` 的“归因”列由脚本预判前两类：
- **检索没召回**：这道题有标准段落，但前 4 段里没有。
- **召回但生成错**：前 4 段里有标准段落，回答还是错了。

另外两类要人看，写在“归因（人工）”列：
- **口径缺失**：官网没有这条口径。脚本在空白题上会给提示。
- **口径有歧义**：官网写法本身能读出不同意思。

## 测试

```bash
node --test experiments/rag_eval/test/*.test.mjs
```

测试不需要 Dify 密钥：`run.mjs` 对着本机模拟的 `chat-messages` 接口运行。需要 Playwright 的测试在没装时会跳过。

其中一条测试把产品里 R3 的 240 条真实回答当成一个应用交给 `score.mjs`，检查结果和公开版体检报告一致：说对且有依据 76、关键事实 12、待确认 16、说错 2。
