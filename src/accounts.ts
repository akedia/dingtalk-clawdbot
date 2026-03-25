import type { ResolvedDingTalkAccount, DingTalkChannelConfig } from "./types.js";
import { validateDingTalkAccountConfig, type DingTalkAccountConfig } from "./config-schema.js";

const DEFAULT_ACCOUNT_ID = "default";
const ENV_CLIENT_ID = "DINGTALK_CLIENT_ID";
const ENV_CLIENT_SECRET = "DINGTALK_CLIENT_SECRET";
const ENV_ROBOT_CODE = "DINGTALK_ROBOT_CODE";

/**
 * List all configured account IDs.
 * When `accounts` map exists, returns those keys. Otherwise returns ['default'].
 */
export function listDingTalkAccountIds(cfg: any): string[] {
  const channel = cfg?.channels?.dingtalk as DingTalkChannelConfig | undefined;
  if (!channel) return [];

  // Multi-account mode
  if (channel.accounts && typeof channel.accounts === 'object') {
    const ids = Object.keys(channel.accounts).filter(id => {
      const acct = channel.accounts![id];
      return acct && acct.enabled !== false;
    });
    if (ids.length > 0) return ids;
  }

  // Single-account fallback
  if (channel.clientId) return [DEFAULT_ACCOUNT_ID];
  return [];
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultDingTalkAccountId(cfg: any): string {
  const channel = cfg?.channels?.dingtalk as DingTalkChannelConfig | undefined;
  if (!channel) return DEFAULT_ACCOUNT_ID;

  // Explicit defaultAccount setting
  if (channel.defaultAccount) return channel.defaultAccount;

  // First account from accounts map
  if (channel.accounts && typeof channel.accounts === 'object') {
    const ids = Object.keys(channel.accounts);
    if (ids.length > 0) return ids[0];
  }

  return DEFAULT_ACCOUNT_ID;
}

/**
 * Deduplicate accounts by clientId: if multiple accounts share the same
 * clientId, only the first one is kept. Returns filtered account IDs.
 */
export function deduplicateByClientId(cfg: any, accountIds: string[]): string[] {
  const seen = new Set<string>();
  return accountIds.filter(id => {
    const account = resolveDingTalkAccount({ cfg, accountId: id });
    if (!account.clientId) return true;
    if (seen.has(account.clientId)) {
      console.warn(`[dingtalk] Duplicate clientId "${account.clientId}" in account "${id}", skipping`);
      return false;
    }
    seen.add(account.clientId);
    return true;
  });
}

/**
 * Resolve a single account by ID.
 * Merges top-level base config with per-account overrides.
 * Env vars only apply to the default account.
 */
export function resolveDingTalkAccount(params: {
  cfg: any;
  accountId?: string | null;
}): ResolvedDingTalkAccount {
  const accountId = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const rawChannel = params.cfg?.channels?.dingtalk ?? {};

  // Separate base config from multi-account fields
  const { accounts, defaultAccount, ...baseConfig } = rawChannel;

  // Get per-account override (if accounts map exists and this account is in it)
  let accountOverride: Record<string, any> = {};
  if (accounts && typeof accounts === 'object' && accountId !== DEFAULT_ACCOUNT_ID) {
    accountOverride = accounts[accountId] ?? {};
  } else if (accounts && typeof accounts === 'object' && accountId === DEFAULT_ACCOUNT_ID) {
    // "default" may also be an explicit key in accounts map
    accountOverride = accounts[DEFAULT_ACCOUNT_ID] ?? {};
  }

  // Merge: base + account override (deep merge for `dm` object)
  const merged = {
    ...baseConfig,
    ...accountOverride,
    // Deep merge dm
    dm: { ...(baseConfig.dm ?? {}), ...(accountOverride.dm ?? {}) },
    // Deep merge groups
    groups: { ...(baseConfig.groups ?? {}), ...(accountOverride.groups ?? {}) },
  };

  // Env var fallback only for default account
  if (accountId === DEFAULT_ACCOUNT_ID) {
    merged.clientId = merged.clientId || process.env[ENV_CLIENT_ID];
    merged.clientSecret = merged.clientSecret || process.env[ENV_CLIENT_SECRET];
    merged.robotCode = merged.robotCode || process.env[ENV_ROBOT_CODE];
  }

  // Validate merged config
  let validatedConfig: DingTalkAccountConfig;
  let credentialSource: "config" | "env" | "none" = "none";

  try {
    validatedConfig = validateDingTalkAccountConfig(merged);

    // Determine credential source
    const rawClientId = accountOverride.clientId || baseConfig.clientId;
    const rawClientSecret = accountOverride.clientSecret || baseConfig.clientSecret;
    if (rawClientId && rawClientSecret) {
      credentialSource = "config";
    } else if (validatedConfig.clientId && validatedConfig.clientSecret) {
      credentialSource = "env";
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `DingTalk configuration validation failed for account "${accountId}":\n${errorMsg}\n\n` +
      `Please check your configuration at channels.dingtalk` +
      (accountId !== DEFAULT_ACCOUNT_ID ? `.accounts.${accountId}` : '') +
      ` or set environment variables:\n` +
      `  - ${ENV_CLIENT_ID}\n` +
      `  - ${ENV_CLIENT_SECRET}\n` +
      `  - ${ENV_ROBOT_CODE} (optional)`
    );
  }

  const configured = !!(validatedConfig.clientId && validatedConfig.clientSecret);

  return {
    accountId,
    name: validatedConfig.name || (accountId === DEFAULT_ACCOUNT_ID ? "DingTalk Bot" : accountId),
    enabled: validatedConfig.enabled,
    configured,
    clientId: validatedConfig.clientId,
    clientSecret: validatedConfig.clientSecret,
    robotCode: validatedConfig.robotCode || validatedConfig.clientId,
    credentialSource,
    config: validatedConfig as unknown as Record<string, any>,
  };
}
