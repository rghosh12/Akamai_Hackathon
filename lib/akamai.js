// Akamai Inference Cloud client (OpenAI-compatible). Shared by verify, vision, embeddings.
// temperature 0, max_tokens ~1500, cache by sha256(request), retry 429 at most 2 times.
const crypto = require('crypto');

const AKAMAI = {
  baseUrl: (process.env.AKAMAI_BASE_URL || 'https://api.akamai-inference.com/v1').replace(/\/+$/, ''),
  apiKey: process.env.AKAMAI_API_KEY || '',
  model: process.env.AKAMAI_MODEL || 'qwen3-8-27b',
  visionModel: process.env.AKAMAI_VISION_MODEL || 'gemma-4-26b-a4b-it',
  embedModel: process.env.AKAMAI_EMBED_MODEL || 'qwen3-embedding-8b',
};
const akamaiReady = () => Boolean(AKAMAI.baseUrl && AKAMAI.apiKey && AKAMAI.model);
const endpointHost = () => { try { return new URL(AKAMAI.baseUrl).host; } catch { return null; } };

const cache = new Map(); // sha256(body) -> { json, meta }
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postWithRetry(pathname, body, timeoutMs = 90000) {
  let res, text;
  for (let attempt = 0; attempt <= 2; attempt++) {
    res = await fetch(AKAMAI.baseUrl + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AKAMAI.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
    if (res.status !== 429 || attempt === 2) break;
    const ra = Number(res.headers.get('retry-after')) || 0;
    await sleep(Math.max(ra * 1000, 1500 * 2 ** attempt));
  }
  return { res, text };
}

// messages: OpenAI chat messages. Returns { content, json?, meta }.
async function chat({ system, user, messages, model = AKAMAI.model, json = true, maxTokens = 1500 }) {
  const msgs = messages || [{ role: 'system', content: system }, { role: 'user', content: user }];
  const body = { model, temperature: 0, max_tokens: maxTokens, messages: msgs };
  const key = sha256(JSON.stringify(body) + json);
  if (cache.has(key)) return { ...cache.get(key), meta: { ...cache.get(key).meta, cached: true } };
  const started = Date.now();
  let { res, text } = await postWithRetry('/chat/completions', json ? { ...body, response_format: { type: 'json_object' } } : body);
  if (json && res.status === 400) ({ res, text } = await postWithRetry('/chat/completions', body));
  if (!res.ok) { const e = new Error(`Akamai Inference HTTP ${res.status}: ${text.slice(0, 300)}`); e.status = res.status; throw e; }
  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content || '';
  const out = {
    content,
    json: json ? extractJson(content) : undefined,
    meta: {
      provider: 'Akamai Inference Cloud', endpoint: endpointHost(), model: data.model || model,
      requestId: data.id || res.headers.get('x-request-id') || null, latencyMs: Date.now() - started, usage: data.usage || null,
    },
  };
  cache.set(key, out);
  return out;
}

async function embed(inputs) {
  const arr = Array.isArray(inputs) ? inputs : [inputs];
  const { res, text } = await postWithRetry('/embeddings', { model: AKAMAI.embedModel, input: arr });
  if (!res.ok) throw new Error(`Akamai embeddings HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text).data.map(d => d.embedding);
}

function extractJson(s) {
  const t = String(s).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) return JSON.parse(m[0]);
  throw new Error('Model did not return JSON');
}

module.exports = { AKAMAI, akamaiReady, endpointHost, chat, embed, extractJson, sha256 };
