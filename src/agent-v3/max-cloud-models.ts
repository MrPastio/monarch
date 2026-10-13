import { cloudProvider, validCloudModel, type MaxCloudProviderId } from './max-cloud-catalog';

/** Read-only catalog lookup: fixed host, no prompts, persistence or error-body forwarding. */
export async function listMaxCloudModels(providerId: MaxCloudProviderId, apiKey: string, fetcher: typeof fetch = fetch) {
  const provider = cloudProvider(providerId);
  if (!provider || typeof apiKey !== 'string' || !/^[\x21-\x7e]{20,512}$/u.test(apiKey)) throw Error('astra-max-cloud:credential');
  if (provider.id === 'groq') return [{ id: provider.model, label: 'GPT OSS 120B' }];
  const base = provider.id === 'fireworks' ? 'https://api.fireworks.ai/v1/accounts/fireworks/models'
    : provider.id === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/models' : provider.base + '/models';
  const headers: Record<string, string> = provider.id === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : provider.id === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: 'Bearer ' + apiKey };
  const signal = AbortSignal.timeout(20_000);
  const models = new Map<string, { id: string; label: string }>();
  let token = '';
  for (let page = 0; page < 10; page++) {
    const url = new URL(base);
    if (provider.id === 'anthropic') { url.searchParams.set('limit', '100'); if (token) url.searchParams.set('after_id', token); }
    if (provider.id === 'gemini' || provider.id === 'fireworks') { url.searchParams.set('pageSize', '200'); if (token) url.searchParams.set('pageToken', token); }
    let response: Response;
    try { response = await fetcher(url.toString(), { method: 'GET', headers, signal, redirect: 'error' }); }
    catch { throw Error('astra-max-cloud:unavailable'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw Error(response.status === 401 || response.status === 403 ? 'astra-max-cloud:credential-rejected' : 'astra-max-cloud:unavailable');
    }
    const reader = response.body?.getReader(); if (!reader) throw Error('astra-max-cloud:empty-catalog');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw Error('astra-max-cloud:catalog-budget'); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    let body: any; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('astra-max-cloud:catalog'); }
    const rows = Array.isArray(body) ? body : body?.data ?? body?.models;
    if (!Array.isArray(rows)) throw Error('astra-max-cloud:catalog');
    for (const row of rows.slice(0, 3000)) {
      if (!row || typeof row !== 'object') continue;
      const id = provider.id === 'gemini' ? typeof row.name === 'string' ? row.name.replace(/^models\//, '') : null : row.id ?? row.name;
      if (!validCloudModel(id) || /embed|rerank|whisper|tts|moderation|dall-e|realtime|audio|image|transcrib|sora|veo/i.test(id)) continue;
      if (provider.id === 'openai' && !/^(gpt-|chatgpt-|o[1-9])/.test(id)) continue;
      if (provider.id === 'together' && row.type !== 'chat') continue;
      if (row.capabilities?.completion_chat === false) continue;
      if (provider.id === 'gemini' && !row.supportedGenerationMethods?.includes('generateContent')) continue;
      if (provider.id === 'fireworks' && (!row.supportsServerless || !row.conversationConfig)) continue;
      if (row.architecture?.output_modalities && !row.architecture.output_modalities.includes('text')) continue;
      const name = row.display_name ?? row.displayName ?? row.name;
      const label = typeof name === 'string' && name !== id && name.length <= 120 && !/[<>\x00-\x1f]/.test(name) ? name : id;
      models.set(id, { id, label });
      if (models.size > 2000) throw Error('astra-max-cloud:catalog-budget');
    }
    const next = provider.id === 'anthropic' ? body.has_more ? body.last_id : '' : body.nextPageToken;
    if (!next) return [...models.values()].sort((a, b) => a.label.localeCompare(b.label));
    if (typeof next !== 'string' || next.length > 1024 || next === token) throw Error('astra-max-cloud:catalog-pagination');
    token = next;
  }
  throw Error('astra-max-cloud:catalog-budget');
}
