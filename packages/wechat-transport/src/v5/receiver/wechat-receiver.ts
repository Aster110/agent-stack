import type { GetUpdatesResp, GetConfigResp } from '../../types.js';
import {
  apiFetch,
  buildBaseInfo,
  DEFAULT_CONFIG_TIMEOUT_MS,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
} from '../shared/wechat-api-core.js';

export async function getUpdates(
  token: string,
  buf: string,
  baseUrl?: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<GetUpdatesResp> {
  const timeout = timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: buf ?? '',
        base_info: buildBaseInfo(),
      }),
      token,
      timeoutMs: timeout,
      label: 'getUpdates',
      signal,
    });
    // Node 24 provides the original numeric token. WeChat IDs are int64:
    // converting through Number would collapse distinct incoming messages.
    return JSON.parse(rawText, (key, value, context?: { source?: string }) =>
      key === 'message_id' && typeof value === 'number' ? context?.source ?? String(value) : value,
    ) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: buf };
    }
    throw err;
  }
}

export async function getConfig(
  token: string,
  userId: string,
  contextToken?: string,
  baseUrl?: string,
): Promise<GetConfigResp> {
  const rawText = await apiFetch({
    baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'getConfig',
    failOnBodyError: true,
  });
  return JSON.parse(rawText) as GetConfigResp;
}
