// Autenticacao sem dependencias externas: senha com scrypt + token HMAC.
const crypto = require('crypto');
const fs = require('fs');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64');
}

function createAuth(config) {
  const authFile = config.authPath;

  function readAuth() {
    try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch (_) { return {}; }
  }

  function checkPassword(password) {
    const auth = readAuth();
    if (!auth || !auth.salt || !auth.hash) return false;
    const hash = crypto.scryptSync(String(password || ''), auth.salt, 64);
    const expected = Buffer.from(auth.hash, 'hex');
    if (expected.length !== hash.length) return false;
    return crypto.timingSafeEqual(expected, hash);
  }

  function signToken(payload) {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify(payload));
    const data = `${header}.${body}`;
    const sig = b64url(crypto.createHmac('sha256', config.jwtSecret).update(data).digest());
    return `${data}.${sig}`;
  }

  function verifyToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const data = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac('sha256', config.jwtSecret).update(data).digest();
    let given;
    try { given = fromB64url(parts[2]); } catch (_) { return null; }
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let payload;
    try { payload = JSON.parse(fromB64url(parts[1]).toString('utf8')); } catch (_) { return null; }
    if (!payload || Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  }

  function login(password) {
    if (!checkPassword(password)) return null;
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: 'admin', role: 'owner', iat: now, exp: now + config.tokenTtlSeconds };
    return { token: signToken(payload), expiresIn: config.tokenTtlSeconds, tokenType: 'Bearer' };
  }

  function extractToken(req) {
    const header = req.headers['authorization'] || req.headers['Authorization'];
    if (header && String(header).toLowerCase().startsWith('bearer ')) {
      return String(header).slice(7).trim();
    }
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams.get('token');
    if (q) return q;
    if (req.headers['x-api-key'] && process.env.API_KEY &&
        String(req.headers['x-api-key']) === String(process.env.API_KEY)) {
      return '__api_key__';
    }
    return null;
  }

  function authenticate(req) {
    const token = extractToken(req);
    if (!token) return false;
    if (token === '__api_key__') return true;
    return !!verifyToken(token);
  }

  function tokenFromRequest(req) {
    return extractToken(req);
  }

  return { login, authenticate, verifyToken, signToken, tokenFromRequest, checkPassword };
}

module.exports = { createAuth };
