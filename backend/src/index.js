// Bootstrap do backend: sobe o runtime do bot (main.js) e expoe HTTP + WebSocket.
// Deve rodar dentro do Electron (o motor wwebjs-electron precisa disso), por
// isso e chamado por electron-entry.js. Tambem funciona em Node puro quando o
// motor do WhatsApp nao e necessario (ex.: testes de contrato da API).
const { loadConfig } = require('./config');
const { createAuth } = require('./auth');
const { createApiServer } = require('./http/server');
const { createRoutes } = require('./api/routes');
const { createWsHub } = require('./ws');

function createLogger(runtime) {
  return (level, msg, extra) => {
    const line = `[API] ${msg}`;
    if (level === 'error') console.error(line);
    else console.log(line);
    try {
      runtime.events.emit('server-terminal-log', {
        ts: new Date().toISOString(),
        level: level === 'warn' ? 'warn' : level,
        source: 'API',
        msg: String(msg),
        ...(extra || {})
      });
    } catch (_) {}
  };
}

async function startBackend(options = {}) {
  const config = options.config || loadConfig();
  const log = options.log || console.log;

  // O runtime e o main.js do Electron. Em contexto Node puro ele pode falhar
  // ao carregar o electron; nesse caso quem chamou deve injetar um runtime.
  let runtime = options.runtime;
  if (!runtime) {
    const mainModule = require('../../main.js');
    runtime = mainModule.getRuntime();
    await runtime.ready;
  }

  const auth = options.auth || createAuth(config);
  const routes = createRoutes({ runtime, config });

  const server = createApiServer({
    config,
    auth,
    routes,
    onRequest: (info) => {
      if (info.ms > 1500) log('warn', `requisicao lenta: ${info.method} ${info.url} (${info.ms}ms)`);
    }
  });

  const hub = createWsHub(server, {
    path: '/ws',
    auth,
    events: runtime.events,
    onClientCommand: (command, payload) => {
      if (!runtime.hasCommand(command)) throw new Error(`comando desconhecido: ${command}`);
      const args = Array.isArray(payload) ? payload : (payload == null ? [] : [payload]);
      return runtime.invoke(command, ...args);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const runningPort = typeof addr === 'object' && addr ? addr.port : config.port;
  log('info', `Backend no ar em http://${config.host}:${runningPort} (ws: /ws) - dados em ${config.dataDir}`);

  if (runtime.events) {
    try {
      runtime.events.emit('server-terminal-log', {
        ts: new Date().toISOString(),
        level: 'success',
        source: 'API',
        msg: `Servidor de API iniciado em ${config.host}:${runningPort}`
      });
    } catch (_) {}
  }

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    try { await hub.close(); } catch (_) {}
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, hub, auth, config, runtime, port: runningPort, close };
}

module.exports = { startBackend };
