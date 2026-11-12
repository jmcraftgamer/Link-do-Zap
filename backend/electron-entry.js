// Entrypoint do backend headless (VPS). Roda como processo Electron sem janela,
// com o motor wwebjs-electron + Xvfb, e expoe HTTP/WebSocket.
//
// Uso: HEADLESS=1 ADMIN_PASSWORD=... PORT=3000 npx electron backend/electron-entry.js
process.env.HEADLESS = process.env.HEADLESS || '1';
process.env.LINK_SERVER_SYNC = process.env.LINK_SERVER_SYNC || '0';
process.env.LINK_CONNECT_READONLY = '0';

const { app } = require('electron');
const { loadConfig } = require('./src/config');
const { startBackend } = require('./src');

let backend = null;
let shuttingDown = false;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (backend) await backend.close();
  } catch (err) {
    console.error('[API] falha ao fechar servidor:', err && err.message ? err.message : err);
  }
  app.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

(async () => {
  try {
    // Configura a pasta de dados ANTES de carregar o main.js: assim o bot usa
    // exatamente o mesmo DATA_DIR da API.
    const config = loadConfig();
    const mainModule = require('../main.js');
    const runtime = mainModule.getRuntime();

    await app.whenReady();
    backend = await startBackend({ config, runtime });
    console.log(`[API] Pronto. Painel pode conectar em http://<ip>:${backend.port}`);
  } catch (err) {
    console.error('[API] Falha fatal ao iniciar backend:', err && err.stack ? err.stack : err);
    await shutdown(1);
  }
})();
