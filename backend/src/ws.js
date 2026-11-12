// WebSocket de eventos ao vivo. Usa a lib `ws` (ja presente no projeto).
const { WebSocketServer } = require('ws');

function createWsHub(server, options) {
  const { path: wsPath = '/ws', auth, events } = options;
  const wss = new WebSocketServer({ noServer: true });

  function send(ws, event, data) {
    if (ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ event, data })); } catch (_) {}
  }

  function broadcast(event, data) {
    for (const client of wss.clients) send(client, event, data);
  }

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { return socket.destroy(); }
    if (url.pathname !== wsPath) return socket.destroy();
    const token = url.searchParams.get('token') ||
      (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!auth.verifyToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    send(ws, 'hello', {
      ok: true,
      time: new Date().toISOString(),
      uptime: Math.floor(process.uptime())
    });
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(String(buf)); } catch (_) { return; }
      if (!msg || !msg.command) return;
      const id = msg.id || null;
      Promise.resolve()
        .then(() => options.onClientCommand ? options.onClientCommand(msg.command, msg.payload) : null)
        .then((result) => send(ws, 'command-result', { id, command: msg.command, ok: true, result }))
        .catch((err) => send(ws, 'command-result', { id, command: msg.command, ok: false, error: err.message }));
    });
  });

  const unsubscribe = events.on('*', (event, payload) => broadcast(event, payload));

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, 30000);
  if (interval.unref) interval.unref();

  return {
    wss,
    broadcast,
    close() {
      unsubscribe();
      clearInterval(interval);
      for (const ws of wss.clients) { try { ws.close(); } catch (_) {} }
      return new Promise((resolve) => wss.close(() => resolve()));
    }
  };
}

module.exports = { createWsHub };
