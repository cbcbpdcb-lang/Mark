# 自我监测：AI 怎么介绍 EchoRank

用同一批问题定期去问 Kimi、通义千问、豆包、DeepSeek，看它们有没有提到 EchoRank、有没有引用官网、说得对不对。FAQ 页上线前先跑一次作为第 0 天基线，上线后按同样条件复测，对比变化。

> `questions.json` 和 `facts.json` 目前是按官网现有文字起草的草稿（version `draft-1`），收到实验计划后按 2.1 的问题和附录的 FAQ 文案替换，并改掉 version。**基线要用定稿的问题跑**，否则和复测没法比。

## 跑法

在仓库根目录：

```bash
cp .env.example .env            # 填好密钥
source .env
node experiments/dogfood/run.mjs --dry-run   # 看计划：哪几家会跑、哪几家跳过、为什么
node experiments/dogfood/run.mjs             # 正式运行，写到 results/YYYY-MM-DD.json（北京时间）
node experiments/dogfood/score.mjs           # 给 results/ 里所有采集打分，输出对比表
```

- 每题每个模型问 2 次，四家都能跑时共 10 × 4 × 2 = 80 条记录。
- 同一天的文件已经存在时不会覆盖，要覆盖加 `--force`，要另存用 `--out`。
- 小规模试跑：`--only kimi,deepseek --limit 2 --repeats 1`。
- 有调用失败时退出码是 2，失败的记录也写进文件（`status: "error"`，带原因）。
- 结果文件不含密钥，可以提交到仓库留档。

## 四家怎么联网

| 模型 | 环境变量 | 联网方式 |
| --- | --- | --- |
| Kimi | `KIMI_API_KEY`（不填时用 `MOONSHOT_API_KEY`） | 内置联网搜索 `$web_search`。模型默认 `kimi-k2.6`，可用 `KIMI_MODEL` 改；有开发者反馈 kimi-k3 调 `$web_search` 会报 400 |
| 通义千问 | `DASHSCOPE_API_KEY` | DashScope 原生接口 `enable_search`，并要回搜索来源（OpenAI 兼容接口不返回来源）。模型默认 `qwen-plus`，可用 `DASHSCOPE_MODEL` 改 |
| 豆包 | `ARK_API_KEY` + `ARK_BOT_ID` | 火山方舟的模型接口本身不联网。要在方舟控制台创建应用、打开联网内容插件，把应用 ID（`bot-` 开头）填进 `ARK_BOT_ID`。没填时跳过豆包，原因写进结果文件的 `skipped` |
| DeepSeek | `DEEPSEEK_API_KEY` | 不联网，作对照组 |

温度等参数都用各家默认值，和普通用户在接口上看到的一致。接口地址和默认模型以各家文档为准，可用 `KIMI_BASE_URL`、`DASHSCOPE_NATIVE_BASE_URL`、`ARK_BASE_URL`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL` 改。

## 每条记录

| 字段 | 含义 |
| --- | --- |
| `date` | 采集日期 |
| `model` / `model_version` | 模型（kimi、qwen、doubao、deepseek）和接口返回的实际版本 |
| `question_id` / `attempt` | 问题编号、第几次调用 |
| `answer` | 回答原文 |
| `mentions_echorank` | 回答里有没有提到 EchoRank |
| `cites_site` | 有没有引用 echorank.markjcai.com（回答里的链接、裸域名，或接口返回的搜索来源） |
| `links` | 引用的链接列表（回答里的链接加上搜索来源，去重） |
| `sources` | 接口单独返回的搜索来源（千问、豆包有，Kimi 不返回） |
| `search` / `search_used` | 联网方式、这次有没有真的搜索 |

## 打分

`facts.json` 里每条事实键对应一道题，写法和产品里 v6.2 的事实键一致：`match` 要说出官方口径里的那个事实（数字、条件、网址），聊到话题不算。

- **说错**：回答提到 EchoRank，某句命中 `wrong`，且命中处前后没有“不是”“不会”之类的否定。标了 `wrong_needs_brand` 的，只看点了 EchoRank 名的小句。
- **说对**：没说错，且说到了这道题对应的事实键。
- **未提及**：其余，包括没提到 EchoRank 的回答。

官网没公布月度和年度的具体价格，回答里给出具体金额只算没说对，不算说错。

输出三个文件，Excel 可以直接打开：

- `summary.csv`：每次采集 × 每个模型的提到、引用官网、说对 / 说错 / 未提及、说对率和 95% 区间，以及和上一次比的变化。第一个文件记为基线，之后依次是第 1、2 次复测。
- `by_question.csv`：每道题在每次采集里说对几次，对照 FAQ 逐条看。
- `details.csv`：每条回答的判定、命中的事实键和原句。

## 测试

```bash
node --test experiments/dogfood/test/*.test.mjs
```

不需要密钥，也不联网：`test/mock_api.mjs` 在本机模拟四家接口的返回格式，覆盖 Kimi 的搜索往返、千问的搜索来源、豆包跳过、重试、401 停止、密钥不落盘和打分。
