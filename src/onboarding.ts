import { probeDingTalk } from './probe.js';

/**
 * Interactive onboarding wizard for DingTalk plugin configuration
 */
export async function onboardDingTalk(ctx: { runtime: any; accountId: string }) {
  const { runtime } = ctx;
  const ui = runtime.ui;

  ui.info('欢迎使用钉钉插件配置向导！\n');

  // Step 1: Credential input
  ui.info('Step 1/4: 获取钉钉应用凭证');
  ui.info('请在钉钉开发者平台创建企业内部应用：');
  ui.info('https://open-dev.dingtalk.com/\n');

  const clientId = await ui.prompt({
    type: 'text',
    message: '请输入 Client ID (AppKey):',
    validate: (val: string) => val.trim().length > 0 || '不能为空',
  });

  const clientSecret = await ui.prompt({
    type: 'password',
    message: '请输入 Client Secret (AppSecret):',
    validate: (val: string) => val.trim().length > 0 || '不能为空',
  });

  // Step 2: Connection test
  ui.info('\nStep 2/4: 测试连接...');
  try {
    const result = await probeDingTalk(clientId, clientSecret);
    if (result.ok) {
      ui.success(`✓ 连接成功！延迟: ${result.latency}ms`);
    } else {
      throw new Error(result.error || '连接失败');
    }
  } catch (error) {
    ui.error(`✗ 连接失败: ${error}`);
    const retry = await ui.confirm('是否重新输入凭证?');
    if (retry) {
      return onboardDingTalk(ctx);
    }
    throw new Error('配置取消');
  }

  // Step 3: DM policy configuration
  ui.info('\nStep 3/4: 配置私聊策略');
  const dmPolicy = await ui.select({
    message: '选择私聊策略:',
    choices: [
      {
        value: 'pairing',
        label: 'Pairing (推荐)',
        description: '首次联系时显示 staffId，需管理员添加白名单',
      },
      {
        value: 'allowlist',
        label: 'Allowlist',
        description: '只允许指定用户私聊',
      },
      {
        value: 'open',
        label: 'Open',
        description: '任何人都可以私聊（不推荐）',
      },
      {
        value: 'disabled',
        label: 'Disabled',
        description: '禁用私聊',
      },
    ],
    default: 'pairing',
  });

  let dmAllowlist: string[] = [];
  if (dmPolicy === 'allowlist') {
    const input = await ui.prompt({
      type: 'text',
      message: '输入允许的 staffId（逗号分隔）:',
      default: '',
    });
    dmAllowlist = input.split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  // Step 4: Group policy configuration
  ui.info('\nStep 4/4: 配置群聊策略');
  const groupPolicy = await ui.select({
    message: '选择群聊策略:',
    choices: [
      {
        value: 'allowlist',
        label: 'Allowlist (推荐)',
        description: '只允许指定群聊',
      },
      {
        value: 'open',
        label: 'Open',
        description: '允许所有群聊',
      },
      {
        value: 'disabled',
        label: 'Disabled',
        description: '禁用群聊',
      },
    ],
    default: 'allowlist',
  });

  let groupAllowlist: string[] = [];
  if (groupPolicy === 'allowlist') {
    ui.info('\n获取群聊 conversationId 的方法：');
    ui.info('  1. 将机器人添加到群聊');
    ui.info('  2. 在群聊中 @机器人 发送消息');
    ui.info('  3. 查看日志找到 conversationId\n');
    const input = await ui.prompt({
      type: 'text',
      message: 'conversationId (可稍后添加):',
      default: '',
    });
    groupAllowlist = input.split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  const requireMention = await ui.confirm({
    message: '在群聊中是否要求 @机器人?',
    default: true,
  });

  // Build configuration object
  const config = {
    enabled: true,
    clientId,
    clientSecret,
    dm: {
      enabled: dmPolicy !== 'disabled',
      policy: dmPolicy,
      allowFrom: dmAllowlist,
    },
    groupPolicy,
    groupAllowlist,
    requireMention,
    messageFormat: 'text' as const,
  };

  // Save configuration
  await runtime.config.set('channels.dingtalk', config);

  ui.success('\n✓ 配置完成！');
  ui.info('下一步: 运行 clawdbot gateway 启动网关\n');

  return config;
}
