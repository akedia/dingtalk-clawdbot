import type { ResolvedDingTalkAccount, DingTalkChannelConfig } from "./types.js";
import { validateDingTalkConfig, type DingTalkConfig } from "./config-schema.js";

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
  const rawConfig = params.cfg?.channels?.dingtalk ?? {};

  // Merge configuration with environment variables
  // Environment variables serve as fallback for missing config values
  const configWithEnv = {
    ...rawConfig,
    clientId: rawConfig.clientId || process.env[ENV_CLIENT_ID],
    clientSecret: rawConfig.clientSecret || process.env[ENV_CLIENT_SECRET],
    robotCode: rawConfig.robotCode || process.env[ENV_ROBOT_CODE],
  };

  // Validate configuration with Zod
  let validatedConfig: DingTalkConfig;
  let credentialSource: "config" | "env" | "none" = "none";

  try {
    validatedConfig = validateDingTalkConfig(configWithEnv);

    // Determine credential source
    if (rawConfig.clientId && rawConfig.clientSecret) {
      credentialSource = "config";
    } else if (validatedConfig.clientId && validatedConfig.clientSecret) {
      credentialSource = "env";
    }
  } catch (error) {
    // If validation fails, throw a helpful error message
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `DingTalk configuration validation failed for account "${accountId}":\n${errorMsg}\n\n` +
      `Please check your configuration at channels.dingtalk or set environment variables:\n` +
      `  - ${ENV_CLIENT_ID}\n` +
      `  - ${ENV_CLIENT_SECRET}\n` +
      `  - ${ENV_ROBOT_CODE} (optional)`
    );
  }

  const configured = !!(validatedConfig.clientId && validatedConfig.clientSecret);

  return {
    accountId,
    name: "DingTalk Bot",
    enabled: validatedConfig.enabled,
    configured,
    clientId: validatedConfig.clientId,
    clientSecret: validatedConfig.clientSecret,
    robotCode: validatedConfig.robotCode || validatedConfig.clientId,
    credentialSource,
    config: validatedConfig as unknown as Record<string, any>,
  };
}
