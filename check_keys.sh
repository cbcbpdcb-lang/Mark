#!/bin/bash
# 只显示每个密钥的开头 6 位和总长度，用来检查有没有粘错，不会显示完整密钥。
for v in DEEPSEEK_API_KEY MOONSHOT_API_KEY DASHSCOPE_API_KEY ARK_API_KEY; do
  val="${!v}"
  if [ -z "$val" ]; then echo "$v：未设置"; else echo "$v：开头 ${val:0:6}… 共 ${#val} 位"; fi
done
echo "ARK_MODEL：${ARK_MODEL:-未设置}"
echo "MOONSHOT_MODEL：${MOONSHOT_MODEL:-未设置（使用默认）}"
