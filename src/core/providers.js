'use strict';

const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  mistral: 'https://api.mistral.ai/v1'
};

const KNOWN_ROOT_URLS = {
  'api.openai.com': '/v1',
  'api.groq.com': '/openai/v1',
  'api.deepseek.com': '/v1',
  'api.mistral.ai': '/v1',
  'openrouter.ai': '/api/v1'
};

function cleanText(value, max = 2048) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function inferProviderType(input, existing) {
  const explicit = cleanText(input && (input.type || input.providerType), 40).toLowerCase();
  if (['openai', 'openrouter', 'google'].includes(explicit)) return explicit;
  const name = cleanText(input && input.name || existing && existing.name, 120).toLowerCase();
  if (name.includes('openrouter')) return 'openrouter';
  if (name.includes('google') || name.includes('gemini')) return 'google';
  return 'openai';
}

function defaultBaseUrl(type, name) {
  const n = cleanText(name, 120).toLowerCase();
  if (n.includes('groq')) return DEFAULT_BASE_URLS.groq;
  if (n.includes('deepseek')) return DEFAULT_BASE_URLS.deepseek;
  if (n.includes('mistral')) return DEFAULT_BASE_URLS.mistral;
  return DEFAULT_BASE_URLS[type] || DEFAULT_BASE_URLS.openai;
}

function normalizeBaseUrl(value, fallback) {
  const raw = cleanText(value || fallback, 2048);
  if (!raw) throw new Error('informe a URL do provedor');
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error('URL invalida; use http:// ou https://');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('a URL do provedor deve usar http:// ou https://');
  }
  if (url.username || url.password) {
    throw new Error('nao coloque usuario ou senha dentro da URL; use o campo Chave API');
  }
  url.hash = '';
  if (url.pathname === '/' && KNOWN_ROOT_URLS[url.hostname]) {
    url.pathname = KNOWN_ROOT_URLS[url.hostname];
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function buildProviderEndpoint(baseUrl, endpoint) {
  const url = new URL(normalizeBaseUrl(baseUrl));
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname) pathname = '/v1';
  if (/\/models$/i.test(pathname)) pathname = pathname.replace(/\/models$/i, '');
  if (/\/chat\/completions$/i.test(pathname)) pathname = pathname.replace(/\/chat\/completions$/i, '');
  url.pathname = `${pathname}/${endpoint}`.replace(/\/{2,}/g, '/');
  url.hash = '';
  return url.toString();
}

function buildGoogleModelsUrl(baseUrl, apiKey) {
  const url = new URL(buildProviderEndpoint(baseUrl, 'models'));
  if (apiKey) url.searchParams.set('key', apiKey);
  return url.toString();
}

function buildGoogleGenerateUrl(baseUrl, modelId, apiKey) {
  const base = new URL(buildProviderEndpoint(baseUrl, 'models'));
  const root = base.pathname.replace(/\/models$/i, '');
  const url = new URL(base.toString());
  url.pathname = `${root}/models/${encodeURIComponent(cleanText(modelId, 300))}:generateContent`;
  if (apiKey) url.searchParams.set('key', apiKey);
  return url.toString();
}

function providerHeaders(provider, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  const key = cleanText(apiKey != null ? apiKey : provider && provider.apiKey, 8192);
  if (key) headers.Authorization = `Bearer ${key}`;
  if (provider && provider.type === 'openrouter') {
    headers['HTTP-Referer'] = 'https://link-no-whatsapp.app';
    headers['X-Title'] = 'Link no WhatsApp';
  }
  if (provider && provider.headers && typeof provider.headers === 'object') {
    for (const [name, value] of Object.entries(provider.headers)) {
      if (/^[a-z0-9-]+$/i.test(name) && value != null) headers[name] = String(value);
    }
  }
  return headers;
}

function normalizeModels(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const id = cleanText(typeof item === 'string' ? item : item && item.id, 500);
    if (!id) continue;
    if (seen.has(id)) throw new Error(`modelo duplicado: ${id}`);
    seen.add(id);
    const model = typeof item === 'string' ? { id, name: id } : { ...item, id };
    model.name = cleanText(model.name || model.displayName || id, 200);
    out.push(model);
    if (out.length >= 500) break;
  }
  return out;
}

function normalizeProviderDraft(input, existing = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const name = cleanText(source.name != null ? source.name : existing.name, 120);
  if (!name) throw new Error('informe um nome para o provedor');
  const type = inferProviderType(source, existing);
  const baseUrl = normalizeBaseUrl(
    source.baseUrl != null ? source.baseUrl : (source.url != null ? source.url : existing.baseUrl),
    defaultBaseUrl(type, name)
  );
  return { name, type, baseUrl };
}

function normalizeProvider(input, existing = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const draft = normalizeProviderDraft(source, existing);
  const id = cleanText(source.id || existing.id, 120);
  if (!id) throw new Error('provedor sem id');
  const models = normalizeModels(source.models != null ? source.models : existing.models);
  if (!models.length) throw new Error('adicione pelo menos um modelo');

  const oldKeys = Array.isArray(existing.apiKeys) && existing.apiKeys.length
    ? existing.apiKeys.map((key) => cleanText(key)).filter(Boolean)
    : (existing.apiKey ? [cleanText(existing.apiKey, 8192)] : []);
  const primary = cleanText(source.apiKey != null ? source.apiKey : existing.apiKey, 8192);
  let apiKeys = oldKeys;
  if (source.apiKey != null && primary !== cleanText(existing.apiKey, 8192)) {
    apiKeys = primary ? [primary, ...oldKeys.filter((key) => key !== primary)] : [];
  }
  if (!apiKeys.includes(primary) && primary) apiKeys.unshift(primary);
  apiKeys = [...new Set(apiKeys.filter(Boolean))];

  const apiKeyNames = apiKeys.map((_, index) => {
    const current = Array.isArray(source.apiKeyNames) ? source.apiKeyNames[index] : null;
    const old = Array.isArray(existing.apiKeyNames) ? existing.apiKeyNames[index] : null;
    return cleanText(current || old || (index === 0 ? 'Chave principal' : `Chave ${index + 1}`), 80);
  });

  return {
    ...existing,
    id,
    name: draft.name,
    type: draft.type,
    baseUrl: draft.baseUrl,
    apiKey: primary,
    apiKeys,
    apiKeyNames,
    models,
    createdAt: existing.createdAt || source.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function parseModelList(payload, type) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const list = Array.isArray(source.data) ? source.data
    : Array.isArray(source.models) ? source.models
      : Array.isArray(source.result) ? source.result : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    let id = '';
    let name = '';
    if (typeof item === 'string') {
      id = item;
    } else if (item && typeof item === 'object') {
      id = item.id || item.model || item.name || '';
      name = item.displayName || item.name || '';
      if (type === 'google') name = item.displayName || '';
    }
    if (type === 'google') id = String(id).replace(/^models\//, '');
    id = cleanText(id, 500);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: cleanText(name || id, 200), free: false });
    if (out.length >= 500) break;
  }
  return out;
}

async function discoverProviderModels(input, options = {}) {
  const draft = normalizeProviderDraft(input);
  const apiKey = cleanText(input && input.apiKey != null ? input.apiKey : options.existing && options.existing.apiKey, 8192);
  const provider = { ...draft, apiKey };
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch indisponivel no processo principal');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 20000);
  try {
    const url = draft.type === 'google'
      ? buildGoogleModelsUrl(draft.baseUrl, apiKey)
      : buildProviderEndpoint(draft.baseUrl, 'models');
    const headers = providerHeaders(provider, apiKey);
    if (draft.type === 'google') delete headers.Authorization;
    const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload && payload.error && (payload.error.message || payload.error)
        || payload && payload.message || `HTTP ${response.status}`;
      throw new Error(String(message));
    }
    const models = parseModelList(payload, draft.type);
    if (!models.length) throw new Error('a API respondeu, mas nao retornou modelos');
    return models;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('a busca de modelos excedeu o tempo limite');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_BASE_URLS,
  normalizeBaseUrl,
  buildProviderEndpoint,
  buildGoogleModelsUrl,
  buildGoogleGenerateUrl,
  providerHeaders,
  normalizeModels,
  normalizeProviderDraft,
  normalizeProvider,
  parseModelList,
  discoverProviderModels
};
