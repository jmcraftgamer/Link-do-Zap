// Leitura de recursos reais da maquina (RAM, swap e disco).
//
// Fica num modulo compartilhado porque o painel precisa do MESMO dado nos dois
// jeitos de rodar: no processo Electron (modo local) e no backend da VPS
// (rotas /health, /server/status). Antes cada lado tinha a sua copia.
const os = require('os');
const fs = require('fs');

// Em Linux usa MemAvailable: o MemFree puro ignora cache e mostra a maquina
// "cheia" sem motivo. Fallback para os.* em Windows/macOS (testes locais).
function readMemory() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const read = (key) => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = read('MemTotal');
    const available = read('MemAvailable');
    const swapTotal = read('SwapTotal') || 0;
    const swapFree = read('SwapFree');
    if (total && available != null) {
      return {
        total,
        available,
        swapTotal,
        swapUsed: swapFree == null ? 0 : Math.max(0, swapTotal - swapFree)
      };
    }
  } catch (_) { /* nao e Linux */ }
  const total = os.totalmem();
  const available = os.freemem();
  return { total, available, swapTotal: 0, swapUsed: 0 };
}

// Disco do sistema de arquivos que guarda os dados (na VPS, a raiz).
// fs.statfs so existe a partir do Node 18.15 e nao funciona no Windows.
function readDisk(path) {
  const target = path || (process.platform === 'win32' ? null : '/');
  if (!target) return null;
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(target);
    const bsize = Number(st.bsize) || 0;
    const blocks = Number(st.blocks) || 0;
    const bfree = Number(st.bfree) || 0;
    const bavail = Number(st.bavail) || 0;
    if (!bsize || !blocks) return null;
    const total = bsize * blocks;
    // bfree inclui blocos reservados ao root; bavail e o que sobra de verdade
    // para os processos comuns (o numero que o "df" mostra como disponivel).
    const free = bsize * bavail;
    const used = Math.max(0, total - bsize * bfree);
    const usedPct = total ? Math.round((used / total) * 100) : 0;
    return { path: String(path || '/'), total, used, free, usedPct };
  } catch (_) {
    return null;
  }
}

// Bloco de recursos exposto em /health, /server/status e /server/overview.
function resourcesSnapshot(options = {}) {
  const mem = readMemory();
  const mb = (bytes) => Math.round(Number(bytes) / 1048576);
  const ramTotalMB = mb(mem.total);
  const ramAvailableMB = mb(mem.available);
  const ramUsedMB = Math.max(0, ramTotalMB - ramAvailableMB);
  const usedPct = mem.total ? Math.round(((mem.total - mem.available) / mem.total) * 100) : 0;

  const disk = readDisk(options.diskPath);
  const diskOut = disk
    ? {
      path: disk.path,
      totalMB: mb(disk.total),
      usedMB: mb(disk.used),
      freeMB: mb(disk.free),
      usedPct: disk.usedPct,
      totalGB: Math.round((disk.total / 1073741824) * 10) / 10,
      usedGB: Math.round((disk.used / 1073741824) * 10) / 10,
      freeGB: Math.round((disk.free / 1073741824) * 10) / 10
    }
    : null;

  // Tempo desde o boot da maquina (os.uptime) e o instante exato do boot.
  // E a referencia para "quantos erros aconteceram desde o ultimo reinicio":
  // o log persiste em disco, mas a contagem do painel so considera daqui pra frente.
  const systemUptimeSeconds = Math.floor(os.uptime());

  return {
    ram: {
      totalMB: ramTotalMB,
      usedMB: ramUsedMB,
      availableMB: ramAvailableMB,
      totalGB: Math.round((ramTotalMB / 1024) * 10) / 10,
      usedGB: Math.round((ramUsedMB / 1024) * 10) / 10,
      usedPct
    },
    swap: { totalMB: mb(mem.swapTotal), usedMB: mb(mem.swapUsed) },
    disk: diskOut,
    processMB: mb(process.memoryUsage().rss),
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    cpus: (os.cpus() || []).length,
    host: (() => { try { return os.hostname(); } catch (_) { return ''; } })(),
    platform: process.platform,
    systemUptimeSeconds,
    systemBootAt: new Date(Date.now() - systemUptimeSeconds * 1000).toISOString(),
    at: new Date().toISOString()
  };
}

module.exports = { resourcesSnapshot, readMemory, readDisk };
