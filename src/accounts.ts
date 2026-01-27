import type { ResolvedDingTalkAccount, DingTalkChannelConfig } from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";
const ENV_CLIENT_ID = "DINGTALK_CLIENT_ID";
const ENV_CLIENT_SECRET = "DINGTALK_CLIENT_SECRET";
const ENV_ROBOT_CODE = "DINGTALK_ROBOT_CODE";

export function listDingTalkAccountIds(cfg: any): string[] {
  const channel = cfg?.channels?.dingtalk as DingTalkChannelConfig | undefined;
  if (!channel) return [DEFAULT_ACCOUNT_ID];
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultDingTalkAccountId(cfg: any): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveDingTalkAccount(params: {
  cfg: any;
  accountId?: string | null;
}): ResolvedDingTalkAccount {
  const accountId = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const channel = (params.cfg?.channels?.dingtalk ?? {}) as DingTalkChannelConfig;

  let clientId = channel.clientId?.trim();
  let clientSecret = channel.clientSecret?.trim();
  let robotCode = channel.robotCode?.trim();
  let credentialSource: "config" | "env" | "none" = "none";

  if (clientId && clientSecret) {
    credentialSource = "config";
  } else {
    clientId = clientId || process.env[ENV_CLIENT_ID]?.trim();
    clientSecret = clientSecret || process.env[ENV_CLIENT_SECRET]?.trim();
    robotCode = robotCode || process.env[ENV_ROBOT_CODE]?.trim();
    if (clientId && clientSecret) {
      credentialSource = "env";
    }
  }

  const enabled = channel.enabled !== false;
  const configured = credentialSource !== "none";

  return {
    accountId,
    name: "DingTalk Bot",
    enabled,
    configured,
    clientId,
    clientSecret,
    robotCode: robotCode || clientId,
    credentialSource,
    config: channel as Record<string, any>,
  };
}
