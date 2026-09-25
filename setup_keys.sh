#!/bin/bash
# EchoRank 密钥配置助手（在你自己的 Mac 上运行，密钥不会离开你的电脑）
# 用法：在终端里执行  bash setup_keys.sh
# 它会逐个询问密钥，输入时不回显；直接回车表示跳过。结果写入 ~/.zshrc。

RC="$HOME/.zshrc"
touch "$RC"

ask() {
  local var="$1" label="$2" val
  printf "%s（直接回车跳过）：" "$label"
  read -rs val
  echo
  if [ -n "$val" ]; then
    # 删除旧的同名配置，再追加新的
    sed -i '' "/^export $var=/d" "$RC" 2>/dev/null
    printf 'export %s=%s\n' "$var" "$val" >> "$RC"
    echo "  已写入 $var"
  fi
}

echo "把各家平台创建的 API Key 粘贴进来。输入时屏幕不显示，是正常的。"
echo
ask DEEPSEEK_API_KEY  "DeepSeek 的 Key"
ask MOONSHOT_API_KEY  "Kimi（Moonshot）的 Key"
ask DASHSCOPE_API_KEY "千问（阿里云百炼）的 Key"
ask ARK_API_KEY       "豆包（火山方舟）的 Key"
ask ARK_MODEL         "豆包的模型名或接入点 ID（明文即可）"
echo
echo "完成。请关闭这个终端窗口再重新打开，然后运行：python3 collect.py --dry-run"
