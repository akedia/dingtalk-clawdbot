#!/bin/bash
#
# DingTalk Plugin 一键升级脚本 (v0.1.0 → v1.2.0)
# 用法: bash upgrade-from-v0.1.0.sh
#
# 功能:
# 1. 自动备份配置
# 2. 删除旧版本
# 3. 安装 NPM 官方版本
# 4. 恢复配置
# 5. 重启 gateway
#

set -e  # 遇到错误立即退出

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}DingTalk 插件升级脚本 (v0.1.0 → v1.2.0)${NC}"
echo -e "${BOLD}========================================${NC}\n"

# 检查是否有旧版本
OLD_PLUGIN_DIR="$HOME/.clawdbot/extensions/dingtalk"
CONFIG_FILE="$HOME/.clawdbot/clawdbot.json"

if [ ! -d "$OLD_PLUGIN_DIR" ]; then
    echo -e "${RED}✗ 未找到旧版本插件目录: $OLD_PLUGIN_DIR${NC}"
    echo "  如果你还没有安装 DingTalk 插件，请直接运行:"
    echo "  clawdbot plugins install @yaoyuanchao/dingtalk"
    exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}✗ 未找到配置文件: $CONFIG_FILE${NC}"
    exit 1
fi

echo -e "${GREEN}✓ 检测到旧版本插件${NC}\n"

# 步骤1: 备份配置
echo -e "${BOLD}[1/6] 备份配置文件...${NC}"
BACKUP_FILE="$CONFIG_FILE.backup-$(date +%Y%m%d-%H%M%S)"
cp "$CONFIG_FILE" "$BACKUP_FILE"
echo -e "${GREEN}✓ 配置已备份到: $BACKUP_FILE${NC}\n"

# 步骤2: 提取 DingTalk 配置
echo -e "${BOLD}[2/6] 提取 DingTalk 配置...${NC}"
TEMP_CONFIG="/tmp/dingtalk-upgrade-config-$$.json"
python3 << 'PYEOF'
import json
import sys

config_file = sys.argv[1]
temp_file = sys.argv[2]

try:
    with open(config_file, 'r') as f:
        config = json.load(f)

    dingtalk_config = config.get('channels', {}).get('dingtalk')

    if not dingtalk_config:
        print("  ⚠️  未找到 DingTalk 配置，可能已经卸载")
        sys.exit(0)

    # 保存 DingTalk 配置到临时文件
    with open(temp_file, 'w') as f:
        json.dump(dingtalk_config, f, indent=2)

    print(f"  ✓ DingTalk 配置已提取")

    # 从配置文件中移除 dingtalk 引用
    if 'channels' in config and 'dingtalk' in config['channels']:
        del config['channels']['dingtalk']
    if 'plugins' in config and 'entries' in config['plugins'] and 'dingtalk' in config['plugins']['entries']:
        del config['plugins']['entries']['dingtalk']

    # 写回配置文件
    with open(config_file, 'w') as f:
        json.dump(config, f, indent=2)

    print(f"  ✓ 配置引用已清理")

except Exception as e:
    print(f"✗ 错误: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF "$CONFIG_FILE" "$TEMP_CONFIG"

if [ ! -f "$TEMP_CONFIG" ]; then
    echo -e "${YELLOW}⚠️  未找到 DingTalk 配置，继续安装新版本${NC}\n"
else
    echo -e "${GREEN}✓ DingTalk 配置已保存到临时文件${NC}\n"
fi

# 步骤3: 停止 Gateway
echo -e "${BOLD}[3/6] 停止 Gateway...${NC}"
if pgrep -f "clawdbot gateway" > /dev/null; then
    pkill -f "clawdbot gateway" || true
    sleep 2
    echo -e "${GREEN}✓ Gateway 已停止${NC}\n"
else
    echo -e "${YELLOW}⚠️  Gateway 未运行${NC}\n"
fi

# 步骤4: 删除旧版本
echo -e "${BOLD}[4/6] 删除旧版本...${NC}"
rm -rf "$OLD_PLUGIN_DIR"
echo -e "${GREEN}✓ 旧版本已删除${NC}\n"

# 步骤5: 安装新版本
echo -e "${BOLD}[5/6] 安装新版本 (NPM)...${NC}"
clawdbot plugins install @yaoyuanchao/dingtalk

if [ $? -ne 0 ]; then
    echo -e "${RED}✗ 安装失败，正在恢复配置...${NC}"
    cp "$BACKUP_FILE" "$CONFIG_FILE"
    echo -e "${YELLOW}配置已恢复，请手动检查问题${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 新版本安装成功${NC}\n"

# 步骤6: 恢复 DingTalk 配置
echo -e "${BOLD}[6/6] 恢复 DingTalk 配置...${NC}"
if [ -f "$TEMP_CONFIG" ]; then
    python3 << 'PYEOF'
import json
import sys

config_file = sys.argv[1]
temp_file = sys.argv[2]

try:
    # 读取当前配置
    with open(config_file, 'r') as f:
        config = json.load(f)

    # 读取保存的 DingTalk 配置
    with open(temp_file, 'r') as f:
        dingtalk_config = json.load(f)

    # 恢复配置
    if 'channels' not in config:
        config['channels'] = {}
    config['channels']['dingtalk'] = dingtalk_config

    if 'plugins' not in config:
        config['plugins'] = {}
    if 'entries' not in config['plugins']:
        config['plugins']['entries'] = {}
    config['plugins']['entries']['dingtalk'] = {'enabled': True}

    # 写回配置文件
    with open(config_file, 'w') as f:
        json.dump(config, f, indent=2)

    print("  ✓ DingTalk 配置已恢复")

except Exception as e:
    print(f"✗ 错误: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF "$CONFIG_FILE" "$TEMP_CONFIG"

    # 清理临时文件
    rm -f "$TEMP_CONFIG"
    echo -e "${GREEN}✓ 配置恢复完成${NC}\n"
else
    echo -e "${YELLOW}⚠️  跳过配置恢复（未找到临时配置）${NC}\n"
fi

# 验证安装
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}验证安装${NC}"
echo -e "${BOLD}========================================${NC}\n"

echo "检查插件状态..."
if clawdbot plugins list | grep -q "dingtalk.*1.2.0"; then
    echo -e "${GREEN}✓ 插件版本: 1.2.0${NC}"
else
    echo -e "${RED}✗ 插件版本检查失败${NC}"
fi

echo -e "\n检查配置..."
if clawdbot doctor 2>&1 | grep -q "Error"; then
    echo -e "${RED}✗ 配置验证失败，请运行 'clawdbot doctor' 查看详情${NC}"
else
    echo -e "${GREEN}✓ 配置验证通过${NC}"
fi

# 提示启动 Gateway
echo -e "\n${BOLD}========================================${NC}"
echo -e "${BOLD}升级完成！${NC}"
echo -e "${BOLD}========================================${NC}\n"

echo -e "${GREEN}✓ DingTalk 插件已成功升级到 v1.2.0${NC}\n"

echo "下一步操作:"
echo "  1. 启动 Gateway:"
echo -e "     ${BOLD}clawdbot gateway${NC}\n"
echo "  2. 查看日志验证连接:"
echo -e "     ${BOLD}tail -f /tmp/clawdbot/clawdbot-\$(date +%Y-%m-%d).log | grep dingtalk${NC}\n"
echo "  3. (可选) 运行配置向导重新配置:"
echo -e "     ${BOLD}clawdbot onboard --channel dingtalk${NC}\n"

echo "备份文件位置:"
echo "  $BACKUP_FILE"
echo -e "\n如有问题，请查看升级文档: https://github.com/akedia/dingtalk-clawdbot/UPGRADE.md"
