// Abito-owned. A provider key saved in Chat also becomes a provider account of the closed `abito_account_*`
// store, so the chat can use it alongside the accounts made in Cuentas. The presets are the ones Cuentas offers
// (hub/accounts.ts PRESETS) with the model ids Coucou's own provider table names (core/providers.ts).
// Pure: builds the payload only; chat.ts sends it.
export interface KeyAccount { id?: string; provider: string; nombre: string; baseUrl: string; api: string; models: string[]; defaultModel: string }
export const KEY_ACCOUNTS: Record<string, KeyAccount> = {
  'anthropic-api-key': { provider: 'anthropic', nombre: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'], defaultModel: 'claude-opus-5' },
  'google-api-key': { provider: 'google', nombre: 'Google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai',
    models: ['gemini-2.0-flash'], defaultModel: 'gemini-2.0-flash' },
  'openai-api-key': { provider: 'openai', nombre: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-completions',
    models: ['gpt-4o', 'gpt-4o-mini'], defaultModel: 'gpt-4o' },
  'openrouter-api-key': { provider: 'openrouter', nombre: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions',
    models: ['openrouter/auto'], defaultModel: 'openrouter/auto' },
  // #503 S3. NaN: OpenAI-compatible, base URL from the human (L1). OpenCode Go: endpoint + models from opencode.ai/docs/go (2026-10-22);
  // «sin verificar»: no real call was made with a key. Auth is presumed `Authorization: Bearer <key>` (sin verificar).
  'nan-api-key': { id: 'key-nan', provider: 'custom', nombre: 'NaN', baseUrl: 'https://api.nan.builders/v1', api: 'openai-completions',
    models: ['nan-default'], defaultModel: 'nan-default' },
  'opencode-go-api-key': { id: 'key-opencodego', provider: 'custom', nombre: 'OpenCode Go', baseUrl: 'https://opencode.ai/inference/go/openai/v1', api: 'openai-completions',
    models: ['kimi-k3', 'glm-5.2', 'deepseek-v4-pro'], defaultModel: 'kimi-k3' },
};
export const keyAccountId = (keyId: string): string | null => KEY_ACCOUNTS[keyId] ? (KEY_ACCOUNTS[keyId].id ?? `key-${KEY_ACCOUNTS[keyId].provider}`) : null;
/** The account command that follows a keychain `set` (create, or save when it already exists) or `clear` (remove). */
export function keyAccountCommand(keyId: string, action: 'set' | 'clear', value: string, owned: { accountId: string }[]): any | null {
  const preset = KEY_ACCOUNTS[keyId], accountId = keyAccountId(keyId);
  if (!preset || !accountId) return null;
  const exists = owned.some(a => a.accountId === accountId);
  if (action === 'clear') return exists ? { action: 'abito_account_remove', accountId } : null;
  if (!value) return null;
  const { provider, nombre, baseUrl, api, models, defaultModel } = preset;
  return { action: exists ? 'abito_account_save' : 'abito_account_create', accountId, provider,
    // secret_action owns the shared key; the account stores only its reference.
    config: { nombre, baseUrl, api, compat: {}, models: [...models], defaultModel } };
}
