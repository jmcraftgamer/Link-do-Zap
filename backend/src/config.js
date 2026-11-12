// Configuracao do backend (VPS). Tudo por ambiente, com defaults seguros.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function envBool(name, def = false) {
  const v = String(process.env[name] || '').toLowerCase();
  if (!v) return def;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function loadConfig() {
  const rootDir = path.resolve(__dirname, '..', '..');
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : process.env.LINK_DATA_DIR
      ? path.resolve(process.env.LINK_DATA_DIR)
      : path.join(rootDir, 'data');

  fs.mkdirSync(dataDir, { recursive: true });

  const config = {
    rootDir,
    dataDir,
    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT) || 3000,
    apiPrefix: process.env.API_PREFIX || '/api/v1',
    corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
    jwtSecret: process.env.JWT_SECRET || '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    tokenTtlSeconds: Number(process.env.TOKEN_TTL_SECONDS) || 7 * 24 * 60 * 60,
    maxBodyBytes: Number(process.env.MAX_BODY_MB || 30) * 1024 * 1024,
    trustProxy: envBool('TRUST_PROXY', true)
  };

  // Garante que o app (main.js) use a mesma pasta de dados.
  process.env.LINK_DATA_DIR = config.dataDir;

  const authPath = path.join(dataDir, 'backend-auth.json');
  let auth = null;
  try {
    if (fs.existsSync(authPath)) auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch (_) { auth = null; }

  if (!auth || typeof auth !== 'object') {
    const password = config.adminPassword || crypto.randomBytes(9).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const jwtSecret = config.jwtSecret || crypto.randomBytes(32).toString('hex');
    auth = { salt, hash, jwtSecret, createdAt: new Date().toISOString() };
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
    if (!config.adminPassword) {
      const pwFile = path.join(dataDir, 'ADMIN_PASSWORD.txt');
      fs.writeFileSync(pwFile, `${password}\n`, { mode: 0o600 });
      console.log(`[AUTH] Senha administrativa gerada: ${password}`);
      console.log(`[AUTH] Ela tambem foi salva em ${pwFile}`);
    }
  } else if (config.jwtSecret && config.jwtSecret !== auth.jwtSecret) {
    auth.jwtSecret = config.jwtSecret;
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
  }
  if (config.adminPassword) {
    // Permite trocar a senha via ambiente sem editar o arquivo.
    const salt = auth.salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(config.adminPassword, salt, 64).toString('hex');
    if (hash !== auth.hash) {
      auth.salt = salt;
      auth.hash = hash;
      fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
    }
  }

  config.jwtSecret = config.jwtSecret || auth.jwtSecret;
  config.authPath = authPath;
  return config;
}

module.exports = { loadConfig };
