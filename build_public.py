#!/usr/bin/env python3
"""
生成公开网站：dist/

  dist/index.html      官网（site/index.html 原样复制）
  dist/app/index.html  产品（index.html 匿名后的公开版），网址是 echorank.markjcai.com/app/

仓库里的 index.html 保留真实名称，作为内部工作数据，本地打开就是内部版。公开网站上传的是这个脚本生成的版本：
源代码里不再有真实品牌名、官网链接、证照号、客服电话等可识别信息。

替换名单写在 index.html 里 `const XXX_PUBLIC = {...};` 这样的行（JSON），每个案例一行：
  DIRECT_A_PUBLIC  品牌 A（精油直销）
  TENCENT_PUBLIC   产品 B（在线会议）
每行的字段：
  anon            匿名名，默认“品牌 A”
  case_sensitive  true 时大小写敏感（腾讯会议一行用它：大写的 TENCENT_ 变量名和小写的 tencent_meeting 分别指定替换）
  names           品牌名和别名 → 匿名名
  domains         官网域名
  extra           额外可识别信息，三种写法：
                    "文字"                → 灰色斜纹块（“（已隐藏）”加一段看不见的编号，每项不同）
                    ["文字", "替换文字"]   → 指定的替换文字
                    {"rx": "正则"}        → 一类说法（如“总部位于美国”），同样换成斜纹块
每个案例的替换顺序和页面运行时的匿名（【改这里 23】makeMasker）一致：
  1. 整条网址：官网域名的网址 → “官方页面（已核对）”；网址里含品牌名的 → “外部页面（已隐藏）”
  2. 额外可识别信息：先正则项（按名单顺序），再逐字项（长的先换）
  3. 裸域名（doterra.cn 这类没有 https:// 的写法）→ “官方网站（已隐藏）”
  4. 品牌名和别名（长的先换）→ 匿名名；合并“品牌 A（品牌 A）”这类重复括号；匿名名紧跟汉字时补一个空格
最后把 `const PUBLIC_BUILD = false` 改为 true：公开版不显示「分析一个产品」等自助入口。

替换同时作用在评测规则（正则）和 AI 回答原文上，所以判定结果和内部版一致；新增名单项后请用内部版和公开版逐条比对判定。

检查（生成和 --check 都会做，任意一项不通过就失败，不写文件）：
  - 名单上的每一项都不能再出现
  - 两个页面全文搜 BANNED 里的词（大小写敏感），出现任意一个就失败

用法：
  python3 build_public.py            # 生成 dist/
  python3 build_public.py --check    # 只检查，不写文件

生成后请在浏览器里打开 dist/index.html 和 dist/app/index.html 看一遍。Cloudflare Pages 从 main 分支运行本脚本并发布 dist/。
纯标准库，不需要安装任何东西。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'index.html'
SITE = ROOT / 'site' / 'index.html'
OUT_DIR = ROOT / 'dist'
OUT_SITE = OUT_DIR / 'index.html'
OUT_APP = OUT_DIR / 'app' / 'index.html'

ANON = '品牌 A'
MASK_OFFICIAL = '官方页面（已核对）'
MASK_OTHER = '外部页面（已隐藏）'
MASK_DOMAIN = '官方网站（已隐藏）'
MASK_HIDDEN = '（已隐藏）'

# 公开版（官网和产品）全文不能出现的词，大小写敏感，所以大小写不同的写法分别列出。产品 B 的网址是 ?case=product_b
BANNED = [
    '腾讯', 'Tencent', 'tencent', 'TENCENT', 'VooV', '元宝纪要', '3.36.10',
    '多特瑞', 'doTERRA', 'dōTERRA', 'DOTERRA', 'doterra',
    '125 个', '125产品点数', '125 产品点数', 'CPTG', 'Certified Pure', '认证纯正', '纯正理疗级', '纯正治疗级',
    '2014', '2008', '静安', '犹他', '8000 万', '美国公司', '美国的精油公司', '美国精油', '源自美国', '总部位于美国',
    '9131000009421894XY', 'YB13101060018558', '400-920-9191', '南京西路',
]


def mask_token(k):
    # 每一项隐藏信息用各自不同的占位：“（已隐藏）”后面跟一段看不见的编号（零宽字符）。
    # 页面上显示为灰色斜纹小块；口径正则里的占位只会匹配同一项信息，不会误中别的被隐藏内容（与 index.html 的 maskToken 同一规则）
    return MASK_HIDDEN + '​' * (k + 1) + '‌'


def load_configs(html):
    cfgs = []
    for m in re.finditer(r'^const (\w+)_PUBLIC = (\{.*\});', html, re.M):
        cfg = json.loads(m.group(2))
        cs = bool(cfg.get('case_sensitive'))
        rx_items, lit = [], []
        for k, x in enumerate(cfg['extra']):
            if isinstance(x, dict):
                rx_items.append((x['rx'], x.get('to') or mask_token(k)))
            elif isinstance(x, list):
                lit.append((x[0], x[1]))
            else:
                lit.append((x, mask_token(k)))
        lit.sort(key=lambda t: len(t[0]), reverse=True)
        cfgs.append({
            'key': m.group(1),
            'anon': cfg.get('anon') or ANON,
            'flags': 0 if cs else re.I,
            'names': sorted(cfg['names'], key=len, reverse=True),
            'domains': sorted((d.lower().removeprefix('www.') for d in cfg['domains']), key=len, reverse=True),
            'rx': rx_items,
            'lit': lit,
        })
    if not cfgs:
        sys.exit('index.html 里找不到 XXX_PUBLIC 替换名单行')
    return cfgs


def host_of(url):
    m = re.match(r'^https?://([^/\s]+)', url)
    return (m.group(1) if m else '').lower().removeprefix('www.')


def anonymize(out, c, bump):
    tag = c['key'] + '：'
    fl = c['flags']
    name_re = re.compile('|'.join(re.escape(n) for n in c['names']), fl)

    # 1. 整条网址
    url_re = re.compile(r'https?://[^\s"\'<>（）()\[\]【】，。；、]+')

    def url_sub(m):
        u = m.group(0)
        h = host_of(u)
        if any(h == d or h.endswith('.' + d) for d in c['domains']):
            bump(tag + '官网网址', 1)
            return MASK_OFFICIAL
        if name_re.search(u):
            bump(tag + '含品牌名的网址', 1)
            return MASK_OTHER
        return u

    out = url_re.sub(url_sub, out)

    # 2. 额外可识别信息：先正则项，再逐字项（先于裸域名：邮箱这类含域名的整体先换掉）
    for rx, to in c['rx']:
        out, n = re.subn(rx, to, out, flags=fl)
        bump(tag + '说法：' + rx, n)
    for src, to in c['lit']:
        out, n = re.subn(re.escape(src), to, out, flags=fl)
        bump(tag + '额外信息：' + src, n)

    # 3. 裸域名
    if c['domains']:
        bare = re.compile(r'(?<![\w.-])(?:www\.)?(?:' + '|'.join(re.escape(d) for d in c['domains']) + r')(?![\w-])', re.I)
        out, n = bare.subn(MASK_DOMAIN, out)
        bump(tag + '裸域名', n)

    # 4. 品牌名 → 匿名名；合并“品牌 A（品牌 A）”这类重复括号（页面运行时的 dedupeAnon 同样处理）
    out, n = name_re.subn(c['anon'], out)
    bump(tag + '品牌名', n)
    a = re.escape(c['anon'])
    out, n = re.subn(a + r'(?:\s*[（(]\s*' + a + r'(?:\s*[，,、/／或]\s*' + a + r')*\s*[）)])+', c['anon'], out)
    bump(tag + '重复括号合并', n)
    # 汉字紧跟匿名名时补一个空格（中英文之间留空）
    out, n = re.subn(a + r'(?=[一-龥])', c['anon'] + ' ', out)
    bump(tag + '匿名名后补空格', n)
    # 以字母开头的替换文字（如“B 公司”“B 纪要”）前面紧挨汉字时，同样补一个空格
    for to in sorted({to for _, to in c['lit'] if re.match(r'[A-Za-z]', to)}, key=len, reverse=True):
        out, n = re.subn(r'(?<=[一-龥])' + re.escape(to), ' ' + to, out)
        bump(tag + '替换文字前补空格', n)
    return out


def leaks_of(out, c):
    leaks = []
    for tok in c['names'] + c['domains'] + [src for src, _ in c['lit']]:
        if re.search(re.escape(tok), out, c['flags']):
            leaks.append(tok)
    for rx, _ in c['rx']:
        if re.search(rx, out, c['flags']):
            leaks.append(rx)
    return leaks


def build(html):
    counts = {}

    def bump(k, n):
        counts[k] = counts.get(k, 0) + n

    out = html
    leaks = []
    cfgs = load_configs(html)
    for c in cfgs:
        out = anonymize(out, c, bump)
    for c in cfgs:
        leaks += leaks_of(out, c)

    # 回答记录里的耗时、token 数公开版不显示，去掉（这类数字里可能碰巧含有被隐藏的年份，如 42014）
    out, n = re.subn(r'"(?:latency_ms|input_tokens|output_tokens)": -?[0-9.]+, ', '', out)
    bump('去掉耗时和 token 数', n)
    out, n = re.subn(r', "(?:latency_ms|input_tokens|output_tokens)": -?[0-9.]+(?=\})', '', out)
    bump('去掉耗时和 token 数（末尾）', n)

    # 公开版开关：隐藏「分析一个产品」等自助入口（to B 交付，不做 SaaS 自助）
    out, n = re.subn(r'^const PUBLIC_BUILD = false;', 'const PUBLIC_BUILD = true;', out, count=1, flags=re.M)
    if n != 1:
        sys.exit('index.html 里找不到 `const PUBLIC_BUILD = false;`，无法生成公开版')
    bump('公开版开关 PUBLIC_BUILD', n)
    return out, counts, leaks


def banned_in(text):
    return [w for w in BANNED if w in text]


def main():
    check_only = '--check' in sys.argv
    html = SRC.read_text(encoding='utf-8')
    app, counts, leaks = build(html)
    if not SITE.exists():
        sys.exit('找不到 site/index.html（官网）')
    site = SITE.read_text(encoding='utf-8')
    for k, n in counts.items():
        if n:
            print(f'{k}: {n} 处')
    bad = False
    if leaks:
        print('\n产品页里仍然出现的真实信息：', '、'.join(leaks))
        bad = True
    for name, text in (('官网 dist/index.html', site), ('产品 dist/app/index.html', app)):
        hit = banned_in(text)
        if hit:
            print(f'\n{name} 里出现了不能公开的词：', '、'.join(hit))
            bad = True
    if bad:
        sys.exit(1)
    print('\n检查通过：名单上的信息都已替换，官网和产品页全文没有不能公开的词。')
    if check_only:
        return
    OUT_APP.parent.mkdir(parents=True, exist_ok=True)
    OUT_APP.write_text(app, encoding='utf-8')
    OUT_SITE.write_text(site, encoding='utf-8')
    print(f'已生成 {OUT_SITE.relative_to(ROOT)}（官网，{len(site.encode("utf-8")) // 1024} KB）'
          f'和 {OUT_APP.relative_to(ROOT)}（产品，{len(app.encode("utf-8")) // 1024} KB）。请先在浏览器里打开检查。')


if __name__ == '__main__':
    main()
