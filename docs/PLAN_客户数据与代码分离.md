# 方案：客户数据与代码分离

版本：v1 草案　｜　日期：2026-09-26　｜　状态：待 Jiacheng 确认，未动代码和数据

> 背景：产品定位调整为 to B 服务交付，不做 SaaS 自助。代码仓库（本仓库）保持公开；客户数据（问题集、采集结果、事实底账）改为从本地或私有仓库加载。
> 这份文档只给方案，不做任何代码或数据搬迁。确认后按第 5 节分 PR 实施。

---

## 1. 为什么现在要分

1. **事实底账即将带人名。** v5.5 起每条口径有“客户确认人、确认日期”。客户方员工的姓名和职务不能进公开仓库，也不该进 Git 历史。分离必须在正式向客户收集确认之前完成。
2. **公开仓库现在就含客户数据。** 事实底账、问题集、三批采集结果（约 1.3 MB）和两份分析文档都在仓库里，只靠 `build_public.py` 做发布前替换。替换名单要人维护，漏一项就泄露。
3. **交付形态变了。** to B 交付的是“一份带证据的报告”，不是一个让客户自己采集的网站。代码只需要一套，数据一个客户一份。

## 2. 现状盘点：客户数据都在哪

| 位置 | 内容 | 大小/规模 | 备注 |
| --- | --- | --- | --- |
| `index.html` 第 480–554 行 `REAL_BATCH`、`REAL_BATCH2`、`REAL_BATCH3` | 三批采集结果 R1（NovaNote）、R2（腾讯会议）、R3（多特瑞）整段内嵌 | 约 1.3 MB，占页面 80% | 页面体积主要来自这里 |
| `index.html` 第 1129–1235 行 `DIRECT_A_PUBLIC`、`DIRECT_A_SRC`、`DIRECT_A_TRUTH`、`DIRECT_A_COMPETITORS`、`PRESETS.direct_a` | 多特瑞事实底账、竞品、匿名替换名单、预设 | 约 20 KB | 真实品牌名、官网网址、证照号、公司名 |
| `index.html` 第 1118 行 `directQueries()` + `DIRECT_TEMPLATES` | 直销问题集模板（按品牌名生成） | 小 | 模板本身不含客户信息，可留在代码里 |
| `index.html` 第 763 行起 `TENCENT_TRUTH`、`TENCENT_COMPETITORS`、`TENCENT_QUERIES`、`PRESETS.tencent` | 腾讯会议演示数据 | 约 10 KB | 公开产品、非客户，但同属“真实数据”，建议一并按数据包处理 |
| `index.html` 第 321 行起 `DEFAULT_TRUTH`、`DEFAULT_QUERIES`、`SAMPLE_*`、`PRESETS.novanote` | NovaNote 虚构探针数据 | 小 | 虚构，留在公开版做演示 |
| `index.html` `ITERATIONS`（第 1604 行）、案例故事（第 1951 行） | 迭代日志和案例文字里提到品牌名 | 文字 | 需改写为“客户 A”或从数据包读取 |
| `queries_多特瑞.json`、`queries_tencent.json` | 冻结问题集 | 小 | 文件名就含品牌名 |
| `data/runs_*.json` | 三批采集结果原始文件 | 288 KB + 328 KB + 724 KB | 与内嵌数据重复 |
| `docs/REPORT_R3.md`、`docs/SPOTCHECK.md` | R3 报告、抽检记录 | 含品牌名 13 处、53 处 | 客户交付物和内部质检记录 |
| `docs/HANDOFF_直销口径体检.md` | 交接文档 | 含品牌名 4 处 | 方法文档，改写为“客户 A”即可留下 |
| Git 历史 | 以上全部 | — | 已公开，见第 6 节 |

不含客户数据、可以原样公开的：评测规则、可信度计算、溯源、匿名器、`collect.py`、`worker.js`、`build_public.py`、学习手册、评测与边界。

## 3. 目标结构

```
公开仓库 Mark/                       私有数据（私有仓库 Mark-clients/ 或本机文件夹）
├── index.html   代码 + NovaNote 虚构演示   clients/
├── collect.py                           ├── doterra/                ← 一个客户一个文件夹
├── worker.js                            │   ├── manifest.json       名称、匿名名单、预设参数（anonymize、batches）
├── build_public.py  → dist/index.html   │   ├── truth.json          事实底账（含 client_confirmed_by / _at）
├── build_client.py  → dist-clients/     │   ├── competitors.json
├── clients/         .gitignore 忽略      │   ├── queries.json        冻结问题集（现 queries_多特瑞.json）
├── docs/  方法文档，品牌改称“客户 A”      │   ├── runs/               采集结果（现 data/runs_*.json）
└── tests/  用 NovaNote 数据跑回归        │   ├── reports/            交付的报告、抽检记录
                                         │   └── notes/              内部记录
                                         └── tencent/                腾讯会议演示按同一格式存放
```

要点：

- **一个客户一个文件夹，一种格式。** 页面已有的导出格式（问题集 JSON、`runs_*.json`、事实底账 JSON）就是数据包格式，只补一个 `manifest.json`。
- **公开仓库只留 NovaNote。** 它是虚构的，公开网站靠它演示方法。`build_public.py` 不再需要替换名单，改为只检查“没有任何 `clients/` 内容被内嵌”。
- **`clients/` 永远在 `.gitignore` 里。** 本机把私有仓库 clone 或软链到 `Mark/clients/`，脚本按相对路径读。

## 4. 三种加载方式与推荐

| 方式 | 做法 | 优点 | 缺点 | 适用 |
| --- | --- | --- | --- | --- |
| **A. 构建时内嵌（推荐为主）** | 新增 `build_client.py --client doterra`：读 `clients/doterra/`，把数据包写进 `index.html` 的一个占位符（`/*__CLIENT_DATA__*/`），生成 `dist-clients/doterra/index.html` | 单文件、离线可开、和现在的使用方式完全一致；客户拿到的就是一个文件；不需要任何服务端 | 每次数据更新要重新生成（一条命令） | 交付给客户、内部分析 |
| **B. 运行时导入（推荐为辅）** | 「数据导入」页新增“导入客户数据包”：选一个文件夹或 zip，把 manifest、truth、queries、runs 一次读入浏览器存储（现在只能导 runs） | 不用构建，随时切换客户 | 数据存在浏览器里，换机器要重导；不适合发给客户 | 本机日常工作 |
| **C. 运行时从私有仓库拉取** | 页面启动时 `fetch` 私有仓库或私有 Pages 上的数据包 | 数据集中、更新即生效 | 浏览器无法安全持有私有仓库 token，必须再加一层带口令的 Worker（可复用 `worker.js` 的 ACCESS_TOKEN 方式）或 Cloudflare Access；对 to B 交付没有必要 | 以后如果要给客户开在线看板再做 |

推荐：**A 为主、B 为辅，C 不做。** 理由：产品是交付报告，不是自助平台；A 和 B 都不需要服务端和密钥，实现量最小。

## 5. 实施步骤（确认后分 3 个 PR）

**PR 1：代码侧改造（不动数据）**
1. `index.html`：把 `PRESETS` 的真实数据来源改为一个 `CLIENT_DATA` 对象，默认为空；`REAL_RUNS` 从 `CLIENT_DATA.runs` 生成；NovaNote 保留在代码里。加占位符 `/*__CLIENT_DATA__*/`。
2. 新增 `build_client.py`：读 `clients/<slug>/`，校验格式（问题 id 对得上 runs、事实底账每条有 `review_status`），内嵌后生成 `dist-clients/<slug>/index.html`；同时把 `manifest.json` 里的匿名名单用于生成该客户的匿名版（沿用 `build_public.py` 的替换逻辑）。
3. 「数据导入」页加“导入客户数据包”（方式 B）。
4. `.gitignore` 加 `clients/`、`dist-clients/`。
5. `build_public.py` 改为：只内嵌 NovaNote，检查页面里没有 `clients/` 的任何字符串；不再依赖 `DIRECT_A_PUBLIC`。
6. 回归测试改用 NovaNote 数据跑（R1 批次是虚构品牌，可以留在公开仓库或同样进 `clients/novanote/`）。

**PR 2：数据搬出（在私有仓库或本机完成）**
1. 建私有仓库 `Mark-clients`（或本机文件夹），按第 3 节结构建 `clients/doterra/`、`clients/tencent/`。
2. 从 `index.html` 导出 `DIRECT_A_TRUTH` 等为 `truth.json`、`competitors.json`、`manifest.json`；`queries_多特瑞.json` → `queries.json`；`data/runs_*.json` → `runs/`；`docs/REPORT_R3.md`、`docs/SPOTCHECK.md` → `reports/`、`notes/`。
3. 用 `build_client.py --client doterra` 生成页面，对照现在的 R3 报告逐项核对数字一致（发现数、比例、区间），一致才算搬完。

**PR 3：公开仓库清理**
1. 删除 `index.html` 里的 `REAL_BATCH*`、`DIRECT_A_*`、`TENCENT_*`、`PRESETS.direct_a/tencent`，删除 `queries_*.json`、`data/`、`docs/REPORT_R3.md`、`docs/SPOTCHECK.md`。
2. 迭代日志、案例故事、交接文档里的品牌名改写为“客户 A”“某精油直销品牌”。
3. 重新生成 `dist/index.html`，确认公开网站只剩 NovaNote 演示；页面体积从 1.6 MB 降到约 300 KB。
4. README 更新“公开版 / 客户版”两条生成命令。

## 6. Git 历史怎么处理

现有客户数据已经在公开历史里（PR #2 起）。两个选项：

- **不改写历史（推荐）。** 现有数据全部来自品牌公开官网和公开模型回答，不含个人信息；改写公开仓库历史会让所有 clone 失效，收益小。前提是 PR 2、3 完成后不再有新客户数据进入，尤其是客户确认人姓名。
- **改写历史。** 只有当客户明确要求“公开仓库不得留存我方任何资料”时再做：`git filter-repo` 删除 `data/`、`queries_*.json`、`docs/REPORT_R3.md`、`docs/SPOTCHECK.md` 和 `index.html` 中的数据段，强推后所有协作者重新 clone。

## 7. 需要 Jiacheng 决定的三件事

1. **私有数据放哪。** 私有 GitHub 仓库（推荐：事实底账的每次修改和客户确认都有版本和 PR 记录，可以给客户看变更历史）还是只放本机文件夹（更简单，但没有备份和记录）。
2. **公开网站保留什么演示。** 只留 NovaNote 虚构案例（推荐，公开仓库里彻底没有真实数据），还是同时保留“品牌 A”匿名版（需要在私有仓库生成匿名数据包再拷回公开仓库，多一道流程）。腾讯会议演示同理。
3. **是否改写 Git 历史。** 默认不改（见第 6 节）。

确认这三点后，PR 1 可以直接开始；PR 2、3 依赖第 1、2 点的答案。
