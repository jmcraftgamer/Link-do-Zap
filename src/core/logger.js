// Logger/terminal compartilhado entre Setup local e backend.
// - ring buffer em memoria (ultimas linhas de console)
// - terminal persistente em JSONL (com teto de linhas)
// - callback onEntry para o transporte (IPC/WebSocket)
const path = require('path');
const fs = require('fs');

const LEVELS = new Set(['info', 'success', 'warning', 'error', 'warn', 'outgoing', 'ai', 'debug']);

function classifyLevel(msg) {
  const s = String(msg || '').toLowerCase();
  if (/\[error\]|\berro\b|\bfalha\b|\bfalhou\b|exception|stack/.test(s)) return 'error';
  if (/\[warn\]|\baviso\b|\balerta\b/.test(s)) return 'warning';
  if (/\[success\]|\bok\b|conectado|enviad[oa]|sucesso/.test(s)) return 'success';
  return 'info';
}

function createLogger(options = {}) {
  const paths = options.paths;
  const fileName = options.fileName || 'server-terminal.jsonl';
  const maxRingLines = Number(options.maxRingLines) || 500;
  const maxTerminalLines = Number(options.maxTerminalLines) || 20000;
  const trimTo = Number(options.trimTo) || 18000;
  const logger = options.console || console;

  const ring = [];
  let terminal = [];
  let loaded = false;

  function pushLine(line) {
    const text = String(line == null ? '' : line);
    ring.push(text);
    while (ring.length > maxRingLines) ring.shift();
  }

  function filePath() {
    return paths.getFilePath(fileName);
  }

  function normalizeTerminalEntry(input) {
    if (!input) return null;
    if (typeof input === 'string') {
      return { ts: Date.now(), level: classifyLevel(input), source: 'SISTEMA', msg: input };
    }
    const msg = String(input.msg == null ? '' : input.msg);
    if (!msg) return null;
    const level = LEVELS.has(input.level) ? input.level : classifyLevel(msg);
    return {
      ts: Number(input.ts) || Date.now(),
      level: level === 'warn' ? 'warning' : level,
      source: String(input.source || 'SISTEMA'),
      msg
    };
  }

  function writeTerminalFile() {
    try {
      paths.ensureDataDir();
      fs.writeFileSync(filePath(), terminal.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } catch (_) {}
  }

  function loadFromDisk() {
    if (loaded) return terminal;
    loaded = true;
    try {
      const p = filePath();
      if (!fs.existsSync(p)) return terminal;
      const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
      terminal = lines
        .slice(-maxTerminalLines)
        .map((line) => {
          try { return normalizeTerminalEntry(JSON.parse(line)); } catch (_) { return null; }
        })
        .filter(Boolean);
    } catch (_) {}
    return terminal;
  }

  function append(input, opts = {}) {
    const entry = normalizeTerminalEntry(input);
    if (!entry) return null;
    terminal.push(entry);
    if (terminal.length > maxTerminalLines) terminal = terminal.slice(-trimTo);
    if (!opts.skipDisk) writeTerminalFile();
    if (typeof options.onEntry === 'function') {
      try { options.onEntry(entry, opts); } catch (_) {}
    }
    return entry;
  }

  function clear(opts = {}) {
    terminal = [];
    if (!opts.skipDisk) writeTerminalFile();
    if (typeof options.onClear === 'function') {
      try { options.onClear(); } catch (_) {}
    }
  }

  // Captura console.log/error/warn para o ring e para o terminal.
  function installConsoleCapture() {
    if (options.noConsoleCapture) return () => {};
    const originals = {
      log: console.log.bind(console),
      error: console.error.bind(console),
      warn: console.warn.bind(console)
    };
    const wrap = (level, fn) => (...args) => {
      const line = args.map((a) => (typeof a === 'string' ? a : (() => {
        try { return JSON.stringify(a); } catch (_) { return String(a); }
      })())).join(' ');
      pushLine(line);
      if (options.mirrorTerminal) {
        append({ level, source: 'CONSOLE', msg: line }, { skipDisk: false });
      }
      fn(...args);
    };
    console.log = wrap('info', originals.log);
    console.error = wrap('error', originals.error);
    console.warn = wrap('warning', originals.warn);
    return () => {
      console.log = originals.log;
      console.error = originals.error;
      console.warn = originals.warn;
    };
  }

  return {
    ring,
    getRing: () => ring,
    pushLine,
    append,
    clear,
    loadFromDisk,
    normalizeTerminalEntry,
    getTerminal: () => terminal,
    installConsoleCapture,
    filePath,
    classifyLevel
  };
}

module.exports = { createLogger, classifyLevel };
