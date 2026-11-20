class InferenceError extends Error {}

function extractJson(content) {
  if (typeof content !== 'string') throw new InferenceError('Akamai returned no text response');
  try { return JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { throw new InferenceError('Akamai returned invalid JSON'); }
}

function createInference(config, fetchImpl = fetch) {
  const configured = Boolean(config.apiKey && config.baseUrl && config.model);
  const health = { configured, status: configured ? 'configured' : 'not_configured', lastSuccessAt: null };
  async function call(system, user, schema, validate = value => value) {
    if (!configured) throw new InferenceError('Akamai Inference is not configured');
    const started = Date.now();
    const body = {
      model: config.model, temperature: 0, max_tokens: 6144,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    };
    const signal = AbortSignal.timeout(config.timeoutMs);
    const post = format => fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ ...body, ...(format ? { response_format: format } : {}) }),
    });
    try {
      let response = await post({ type: 'json_schema', json_schema: { name: 'labstrata', schema } });
      if ([400, 422].includes(response.status)) {
        const rejection = await response.text();
        // Retry only schema/format incompatibility, never authentication or arbitrary bad requests.
        if (/response_format|json_schema|structured output/i.test(rejection)) response = await post();
      }
      if (!response.ok) throw new InferenceError(`Akamai Inference request failed (HTTP ${response.status})`);
      const data = await response.json();
      const choice = data.choices?.[0];
      if (choice?.finish_reason !== 'stop') throw new InferenceError('Akamai response was incomplete');
      const json = validate(extractJson(choice.message?.content));
      const meta = {
        provider: 'Akamai Inference Cloud', endpoint: new URL(config.baseUrl).host,
        model: config.model, requestId: typeof data.id === 'string' ? data.id.slice(0, 150) : null,
        latencyMs: Date.now() - started,
        usage: data.usage ? Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens']
          .filter(key => Number.isSafeInteger(data.usage[key])).map(key => [key, data.usage[key]])) : null,
      };
      Object.assign(health, { status: 'operational', lastSuccessAt: new Date().toISOString() });
      return { json, meta };
    } catch (error) {
      health.status = 'error';
      if (error instanceof InferenceError) throw error;
      throw new InferenceError(signal.aborted ? 'Akamai Inference timed out' : 'Akamai response could not be processed');
    }
  }
  return { call, health };
}

module.exports = { createInference, InferenceError, extractJson };
