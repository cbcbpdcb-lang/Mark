#!/usr/bin/env python3
"""
生成公开版页面：dist/index.html

仓库里的 index.html 保留真实品牌名，作为内部工作数据。公开网站上传的是这个脚本生成的版本：
源代码里不再有真实品牌名、官网链接、证照号、客服电话等可识别信息。

替换名单只有一处：index.html 里 `const DIRECT_A_PUBLIC = {...}` 那一行（JSON）。
替换顺序和页面运行时的匿名（【改这里 23】makeMasker）一致：
  1. 整条网址：官网域名的网址 → “官方页面（已核对）”；网址里含品牌名的 → “外部页面（已隐藏）”
  2. 额外可识别信息（证照号、电话、邮箱、地址、专有名词）→ “（已隐藏）”，或名单里指定的替换文字
  3. 裸域名（doterra.cn 这类没有 https:// 的写法）→ “官方网站（已隐藏）”
  4. 品牌名和别名（不分大小写，长的先换）→ “品牌 A”
  5. 把 `const PUBLIC_BUILD = false` 改为 true：公开版不显示「分析一个产品」等自助入口

用法：
  python3 build_public.py            # 生成 dist/index.html
  python3 build_public.py --check    # 只检查，不写文件

生成后请在浏览器里打开 dist/index.html 看一遍，再上传到 Cloudflare Pages。纯标准库，不需要安装任何东西。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'index.html'
OUT = ROOT / 'dist' / 'index.html'

ANON = '品牌 A'
MASK_OFFICIAL = '官方页面（已核对）'
MASK_OTHER = '外部页面（已隐藏）'
MASK_DOMAIN = '官方网站（已隐藏）'
MASK_HIDDEN = '（已隐藏）'


def load_config(html):
    m = re.search(r'^const DIRECT_A_PUBLIC = (\{.*\});', html, re.M)
    if not m:
        sys.exit('index.html 里找不到 DIRECT_A_PUBLIC 配置行')
    cfg = json.loads(m.group(1))
    names = sorted(cfg['names'], key=len, reverse=True)
    domains = [d.lower().removeprefix('www.') for d in cfg['domains']]
    extra = []
    for x in cfg['extra']:
        extra.append((x[0], x[1]) if isinstance(x, list) else (x, MASK_HIDDEN))
    extra.sort(key=lambda t: len(t[0]), reverse=True)
    return names, domains, extra


def host_of(url):
    m = re.match(r'^https?://([^/\s]+)', url)
    return (m.group(1) if m else '').lower().removeprefix('www.')


def build(html):
    names, domains, extra = load_config(html)
    counts = {}

    def bump(k, n):
        counts[k] = counts.get(k, 0) + n

    name_re = re.compile('|'.join(re.escape(n) for n in names), re.I)

    # 1. 整条网址
    url_re = re.compile(r'https?://[^\s"\'<>（）()\[\]【】，。；、]+')

    def url_sub(m):
        u = m.group(0)
        h = host_of(u)
        if any(h == d or h.endswith('.' + d) for d in domains):
            bump('官网网址', 1)
            return MASK_OFFICIAL
        if name_re.search(u):
            bump('含品牌名的网址', 1)
            return MASK_OTHER
        return u

    out = url_re.sub(url_sub, html)

    # 2. 额外可识别信息（先于裸域名：邮箱这类含域名的整体先换掉）
    for src, to in extra:
        out, n = re.subn(re.escape(src), to, out, flags=re.I)
        bump('额外信息：' + src, n)

    # 3. 裸域名
    if domains:
        bare = re.compile(r'(?<![\w.-])(?:www\.)?(?:' + '|'.join(re.escape(d) for d in domains) + r')(?![\w-])', re.I)
        out, n = bare.subn(MASK_DOMAIN, out)
        bump('裸域名', n)

    # 4. 品牌名
    out, n = name_re.subn(ANON, out)
    bump('品牌名', n)

    # 5. 公开版开关：隐藏「分析一个产品」等自助入口（to B 交付，不做 SaaS 自助）
    out, n = re.subn(r'^const PUBLIC_BUILD = false;', 'const PUBLIC_BUILD = true;', out, count=1, flags=re.M)
    if n != 1:
        sys.exit('index.html 里找不到 `const PUBLIC_BUILD = false;`，无法生成公开版')
    bump('公开版开关 PUBLIC_BUILD', n)

    # 检查：所有名单项都不能再出现
    leaks = []
    for tok in names + domains + [src for src, _ in extra]:
        if re.search(re.escape(tok), out, re.I):
            leaks.append(tok)
    return out, counts, leaks


def main():
    check_only = '--check' in sys.argv
    html = SRC.read_text(encoding='utf-8')
    out, counts, leaks = build(html)
    for k, n in counts.items():
        if n:
            print(f'{k}: {n} 处')
    if leaks:
        print('\n仍然出现的真实信息：', '、'.join(leaks))
        sys.exit(1)
    print('\n检查通过：源代码里没有名单上的任何信息。')
    if check_only:
        return
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(out, encoding='utf-8')
    print(f'已生成 {OUT.relative_to(ROOT)}（{len(out.encode("utf-8")) // 1024} KB）。请先在浏览器里打开检查，再上传。')


if __name__ == '__main__':
    main()
