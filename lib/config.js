const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

function loadEnvironment(env = process.env, file = path.join(__dirname, '..', '.env')) {
  const result = { ...env };
  if (env.NODE_ENV !== 'production' && fs.existsSync(file)) {
    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) {
      if (!(key in result)) result[key] = value;
    }
  }
  return result;
}

function secret(env, name) {
  const file = env[`${name}_FILE`] || (env.CREDENTIALS_DIRECTORY && path.join(env.CREDENTIALS_DIRECTORY, name));
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  if (env[`${name}_FILE`]) throw new Error(`Cannot read ${name}_FILE`);
  return env[name]?.trim() || '';
}

function endpoint(value, name) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch { throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment`); }
}

function configFromEnv(env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be between 0 and 65535');
  return {
    port, host: env.HOST || '127.0.0.1',
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    inference: {
      baseUrl: endpoint(env.AKAMAI_BASE_URL || 'https://api.akamai-inference.com/v1', 'AKAMAI_BASE_URL'),
      apiKey: secret(env, 'AKAMAI_API_KEY'),
      model: env.AKAMAI_MODEL || env.CHAT_MODEL || 'qwen3-8-27b',
      timeoutMs: 45000,
    },
    storage: {
      endpoint: endpoint(env.OBJ_ENDPOINT || 'https://us-ord-10.linodeobjects.com', 'OBJ_ENDPOINT'),
      region: env.OBJ_REGION || 'us-east-1',
      bucket: env.OBJ_BUCKET || '',
      accessKeyId: secret(env, 'OBJ_ACCESS_KEY'),
      secretAccessKey: secret(env, 'OBJ_SECRET_KEY'),
    },
  };
}

module.exports = { loadEnvironment, configFromEnv };
