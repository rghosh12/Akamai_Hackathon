async function readPhoto(base64Jpeg) {
  const baseUrl = (process.env.AKAMAI_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.AKAMAI_API_KEY || '';
  const model = process.env.AKAMAI_VISION_MODEL || 'gemma-4-26b-a4b-it';
  if (!baseUrl || !apiKey) return { error: 'vision not configured' };
  const image = String(base64Jpeg || '').replace(/^data:image\/[^;]+;base64,/, '');
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let res, text;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: [{ type: 'text', text: 'Transcribe this lab-log photo line by line. Return ONLY JSON: {"lines":[{"n":1,"text":"...","unreadable":false}]}. Mark uncertain handwriting unreadable.' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }] }] }) });
    text = await res.text();
  } finally { clearTimeout(timeout); }
  if (!res.ok) throw new Error(`Akamai Inference HTTP ${res.status}: ${text.slice(0, 300)}`);
  let parsed;
  try {
    const content = JSON.parse(text).choices?.[0]?.message?.content || '{}';
    parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch { return { error: "couldn't read the model's answer; retake or retry" }; }
  return { lines: Array.isArray(parsed.lines) ? parsed.lines.map((line, i) => ({ n: Number(line.n) || i + 1, text: String(line.text || ''), unreadable: Boolean(line.unreadable) })) : [], meta: { provider: 'Akamai Inference Cloud', endpoint: new URL(baseUrl).host, model, latencyMs: Date.now() - started } };
}
module.exports = { readPhoto };
