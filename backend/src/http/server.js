// Servidor HTTP sem dependencias externas (node:http) + roteador com :params.
const http = require('http');

function applyCors(res, req, origins) {
  const origin = req.headers.origin || '';
  let allow = '*';
  if (origins && origins.length && !origins.includes('*')) {
    allow = origins.includes(origin) ? origin : origins[0];
  }
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data === undefined ? null : data);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('payload muito grande'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw)); } catch (_) { resolve(raw); }
    });
    req.on('error', reject);
  });
}

function compile(pathPattern) {
  const parts = pathPattern.split('/').filter(Boolean);
  return {
    parts,
    match(pathname) {
      const actual = pathname.split('/').filter(Boolean);
      if (actual.length !== parts.length) return null;
      const params = {};
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.startsWith(':')) {
          params[p.slice(1)] = decodeURIComponent(actual[i]);
        } else if (p !== actual[i]) {
          return null;
        }
      }
      return params;
    }
  };
}

function createRouter(routes) {
  const compiled = routes.map((r) => ({ ...r, matcher: compile(r.path) }));
  return function match(method, pathname) {
    for (const r of compiled) {
      if (r.method !== method) continue;
      const params = r.matcher.match(pathname);
      if (params) return { route: r, params };
    }
    return null;
  };
}

function createApiServer(options) {
  const { config, auth, routes, onRequest } = options;
  const match = createRouter(routes);

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      applyCors(res, req, config.corsOrigins);
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        return res.end();
      }

      const url = new URL(req.url, 'http://localhost');
      const rawPath = url.pathname;
      const prefix = config.apiPrefix || '';
      const pathname = (prefix && rawPath.startsWith(prefix))
        ? (rawPath.slice(prefix.length) || '/')
        : rawPath;
      const found = match(req.method, pathname) || match(req.method, rawPath);

      if (!found) {
        return sendJson(res, 404, { ok: false, error: 'rota nao encontrada', path: pathname });
      }

      const { route, params } = found;
      if (route.public !== true && !auth.authenticate(req)) {
        return sendJson(res, 401, { ok: false, error: 'nao autorizado' });
      }

      let body = null;
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        body = await readBody(req, config.maxBodyBytes);
      }

      const ctx = {
        req,
        res,
        params,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
        config,
        auth,
        send: (status, data) => sendJson(res, status, data)
      };

      const result = await route.handler(ctx);
      if (!res.writableEnded) {
        if (result && typeof result === 'object' && result.__raw === true) {
          // handler ja respondeu
        } else {
          sendJson(res, result && result.__status ? result.__status : 200, result);
        }
      }
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      if (status >= 500) console.error('[API] erro:', err && err.stack ? err.stack : err);
      if (!res.writableEnded) {
        sendJson(res, status, { ok: false, error: err && err.message ? err.message : String(err) });
      }
    } finally {
      if (typeof onRequest === 'function') {
        try { onRequest({ method: req.method, url: req.url, ms: Date.now() - started }); } catch (_) {}
      }
    }
  });

  return server;
}

module.exports = { createApiServer, sendJson, readBody };
