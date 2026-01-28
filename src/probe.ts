import { getDingTalkAccessToken } from './api.js';

/**
 * Probe DingTalk connection health
 * @param clientId - DingTalk application AppKey
 * @param clientSecret - DingTalk application AppSecret
 * @returns Health check result with latency measurement
 */
export async function probeDingTalk(
  clientId: string,
  clientSecret: string,
): Promise<{ ok: boolean; latency?: number; error?: string }> {
  const startTime = Date.now();

  try {
    const token = await getDingTalkAccessToken(clientId, clientSecret);
    if (!token) {
      return {
        ok: false,
        error: 'Failed to get access token',
        latency: Date.now() - startTime,
      };
    }

    return {
      ok: true,
      latency: Date.now() - startTime,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latency: Date.now() - startTime,
    };
  }
}
