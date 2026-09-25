#!/usr/bin/env python3
"""
EchoRank 采集脚本：用官方 API 批量提问，输出可导入 EchoRank 的运行记录。

用法
  1. 在 EchoRank「数据导入」页导出问题集，保存为 queries.json，放在本脚本同一个文件夹。
  2. 设置你要用的模型的密钥（只放在本机环境变量里，不要写进代码）：
       export DEEPSEEK_API_KEY=...      # DeepSeek
       export MOONSHOT_API_KEY=...      # Kimi
       export DASHSCOPE_API_KEY=...     # 千问（阿里云百炼）
       export ARK_API_KEY=...           # 豆包（火山方舟），还需要 ARK_MODEL=你的模型或接入点 ID
  3. 先预览要跑什么：   python3 collect.py --dry-run
     正式运行：         python3 collect.py --repeats 2
  4. 把生成的 runs_日期时间.json 在 EchoRank「数据导入」页导入。

说明
  - 只用 Python 标准库，不需要安装任何依赖。
  - 这些都是 API 结果，代表“模型本身”，默认不联网，不等于用户在豆包 / Kimi / 千问 App 里看到的回答。
  - 元宝没有公开 API；腾讯混元 API 的结果也不等于元宝 App，所以这里不采集元宝。元宝请在平台人工导入。
  - 接口地址和模型名以各家官方文档为准，下面的默认值可能过时，改 PROVIDERS 即可。
"""

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request

# ---------- 【改这里】各家接口配置（都是 OpenAI 兼容格式） ----------
PROVIDERS = {
    "deepseek": {
        "engine": "deepseek",                       # 对应 EchoRank 里的引擎 id
        "base_url": os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
        "key_env": "DEEPSEEK_API_KEY",
    },
    "kimi": {
        "engine": "kimi",
        "base_url": os.environ.get("MOONSHOT_BASE_URL", "https://api.moonshot.cn/v1"),   # 国际版账号改成 https://api.moonshot.ai/v1
        "model": os.environ.get("MOONSHOT_MODEL", "moonshot-v1-8k"),
        "key_env": "MOONSHOT_API_KEY",
        "temperature": float(os.environ.get("MOONSHOT_TEMPERATURE", "1")),   # kimi-k3 只允许 1
    },
    "qwen": {
        "engine": "qwen",
        "base_url": os.environ.get("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),   # 国际版改成 https://dashscope-intl.aliyuncs.com/compatible-mode/v1
        "model": os.environ.get("DASHSCOPE_MODEL", "qwen-plus"),
        "key_env": "DASHSCOPE_API_KEY",
    },
    "doubao_api": {
        "engine": "doubao_api",
        "base_url": os.environ.get("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
        "model": os.environ.get("ARK_MODEL", ""),   # 火山方舟需要填模型名或接入点 ID
        "key_env": "ARK_API_KEY",
    },
}

TIMEOUT_SECONDS = 180
PAUSE_SECONDS = 1.0   # 两次调用之间暂停，避免触发限流


def now_str():
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M")


def call_chat(provider, key, question):
    """发一条单轮对话。和普通用户一样，只发问题本身，不加系统提示。"""
    url = provider["base_url"].rstrip("/") + "/chat/completions"
    body = json.dumps({
        "model": provider["model"],
        "messages": [{"role": "user", "content": question}],
        "temperature": provider.get("temperature", 0.7),
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,
    })
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    latency = int((time.time() - t0) * 1000)
    text = data["choices"][0]["message"].get("content") or ""
    usage = data.get("usage") or {}
    return text, latency, usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0), data.get("model", provider["model"])


def main():
    ap = argparse.ArgumentParser(description="EchoRank 采集脚本")
    ap.add_argument("--queries", default="queries.json", help="从 EchoRank 导出的问题集文件")
    ap.add_argument("--repeats", type=int, default=2, help="每条问题问几次，建议至少 2 次")
    ap.add_argument("--only", nargs="*", help="只跑指定的提供方，例如 --only deepseek kimi")
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 条问题，先小规模试跑")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不调用任何接口")
    args = ap.parse_args()

    try:
        with open(args.queries, encoding="utf-8") as f:
            qs = json.load(f)
    except FileNotFoundError:
        sys.exit(f"找不到 {args.queries}。先在 EchoRank「数据导入」页导出问题集。")
    queries = qs.get("queries", [])
    if args.limit:
        queries = queries[: args.limit]
    if not queries:
        sys.exit("问题集是空的。")
    if not qs.get("frozen", True):
        print("提醒：这个问题集还是草稿，建议先在平台冻结再采集。\n")

    active = []
    for name, p in PROVIDERS.items():
        if args.only and name not in args.only:
            continue
        key = os.environ.get(p["key_env"], "")
        if not key:
            print(f"跳过 {name}：没有设置 {p['key_env']}")
            continue
        if not p["model"]:
            print(f"跳过 {name}：没有设置模型名")
            continue
        active.append((name, p, key))

    total = len(active) * len(queries) * args.repeats
    print(f"\n问题集 v{qs.get('query_set_version')}，{len(queries)} 条问题 × {len(active)} 个模型 × {args.repeats} 次 = {total} 次调用")
    for name, p, _ in active:
        print(f"  {name}: {p['model']}  ({p['base_url']})")
    if args.dry_run or not active:
        print("\n预览结束，没有调用任何接口。" if args.dry_run else "\n没有可用的模型，请先设置密钥。")
        return

    runs, done = [], 0
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M")
    for name, p, key in active:
        for q in queries:
            for rep in range(1, args.repeats + 1):
                done += 1
                rec = {
                    "run_id": f"API-{stamp}-{p['engine']}-{q['id']}-{rep}",
                    "engine": p["engine"], "query_id": q["id"], "repeat": rep,
                    "capture": "OFFICIAL_API", "search": False,
                    "started_at": now_str(), "model": p["model"],
                    "temperature": p.get("temperature", 0.7),
                }
                try:
                    text, latency, tin, tout, model = call_chat(p, key, q["text"])
                    rec.update(status="SUCCESS", raw=text, latency_ms=latency,
                               input_tokens=tin, output_tokens=tout, model=model)
                    print(f"[{done}/{total}] {name} {q['id']} 第{rep}次  完成 {latency/1000:.1f}s")
                except urllib.error.HTTPError as e:
                    status = "RATE_LIMITED" if e.code == 429 else "ERROR"
                    try:
                        detail = e.read().decode("utf-8", "replace")[:300]
                    except Exception:
                        detail = ""
                    rec.update(status=status, raw="", error=f"HTTP {e.code} {detail}")
                    print(f"[{done}/{total}] {name} {q['id']} 第{rep}次  失败 HTTP {e.code}")
                    if detail:
                        print(f"  平台返回：{detail}")
                    if e.code in (401, 403):
                        print("  密钥无效或没有权限，停止这个模型。")
                        break
                except Exception as e:  # 超时、网络错误等
                    status = "TIMEOUT" if "timed out" in str(e).lower() else "ERROR"
                    rec.update(status=status, raw="", error=str(e)[:200])
                    print(f"[{done}/{total}] {name} {q['id']} 第{rep}次  失败 {status}")
                runs.append(rec)
                time.sleep(PAUSE_SECONDS)

    out = f"runs_{stamp}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"source": "echorank-collect", "created_at": now_str(),
                   "query_set_version": qs.get("query_set_version"), "runs": runs}, f, ensure_ascii=False, indent=2)
    ok = sum(1 for r in runs if r["status"] == "SUCCESS")
    print(f"\n完成：{ok}/{len(runs)} 次成功。结果已保存到 {out}，去 EchoRank「数据导入」页导入。")


if __name__ == "__main__":
    main()
