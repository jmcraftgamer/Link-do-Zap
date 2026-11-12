// Persistencia segura de JSON, com backup .bak, restauracao automatica e
// lixeira recuperavel. Usado pelo app desktop e pelo backend (mesmo contrato).
const path = require('path');
const fs = require('fs');

function createJsonStore(options) {
  const paths = options && options.paths;
  if (!paths || typeof paths.getDataDir !== 'function') {
    throw new Error('createJsonStore: paths.getDataDir obrigatorio');
  }
  const logger = (options && options.logger) || console;
  const configIssues = new Map();

  function configBackupPath(p) {
    return p + '.bak';
  }

  function isConfigUnsafe(filename) {
    const issue = configIssues.get(filename);
    return !!(issue && !issue.recovered);
  }

  function configIssueSummary() {
    return [...configIssues.entries()]
      .filter(([, v]) => v && !v.recovered)
      .map(([k, v]) => `${k}: ${v.error}`)
      .join('; ');
  }

  function loadJsonFile(filename, fallback) {
    const p = paths.getFilePath(filename);
    if (!fs.existsSync(p)) {
      configIssues.delete(filename);
      return fallback;
    }
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      configIssues.delete(filename);
      return data;
    } catch (e) {
      // 1) tenta o backup antes de aceitar que o dado se perdeu
      try {
        const bak = configBackupPath(p);
        if (fs.existsSync(bak)) {
          const data = JSON.parse(fs.readFileSync(bak, 'utf8'));
          logger.error(`[CONFIG] ${filename} corrompido (${e.message}); restaurando do backup`);
          try { fs.copyFileSync(bak, p); } catch (_) {}
          configIssues.set(filename, { error: e.message, recovered: true, at: Date.now() });
          return data;
        }
      } catch (_) { /* backup tambem invalido */ }
      // 2) sem backup valido: registra a falha. Quem consome decide o que fazer.
      logger.error(`[CONFIG] ${filename} corrompido e sem backup valido: ${e.message}`);
      configIssues.set(filename, { error: e.message, recovered: false, at: Date.now() });
      return fallback;
    }
  }

  // Escrita atomica com backup da versao anterior. Nunca grava algo que nao
  // consiga ler de volta (JSON.parse no proprio conteudo serializado).
  function saveJsonAtomic(p, data) {
    paths.ensureDataDir();
    const json = JSON.stringify(data, null, 2);
    JSON.parse(json);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, json);
    try {
      if (fs.existsSync(p)) fs.copyFileSync(p, configBackupPath(p));
    } catch (_) { /* backup e melhor-esforco */ }
    try {
      fs.renameSync(tmp, p);
    } catch (_) {
      // Windows: antivirus/OneDrive podem segurar o arquivo. Fallback direto.
      fs.writeFileSync(p, json);
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    configIssues.delete(path.basename(p));
    return json.length;
  }

  // Move para a lixeira em vez de apagar. Nada e destruido por engano.
  function moveToTrash(targetPath, reason) {
    try {
      if (!fs.existsSync(targetPath)) return false;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const trashDir = path.join(paths.getDataDir(), 'trash', stamp);
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(targetPath, path.join(trashDir, path.basename(targetPath)));
      logger.log(`[TRASH] ${path.basename(targetPath)} movido para lixeira (${reason || 'sem motivo'})`);
      return true;
    } catch (e) {
      logger.error(`[TRASH] falha ao mover ${targetPath}: ${e.message}`);
      return false;
    }
  }

  // Limpa a lixeira depois de N dias (recuperacao continua possivel na janela).
  function pruneTrash(maxAgeDays = 14) {
    try {
      const root = path.join(paths.getDataDir(), 'trash');
      if (!fs.existsSync(root)) return;
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(root)) {
        const full = path.join(root, name);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
        } catch (_) {}
      }
    } catch (_) {}
  }

  function validateZapsPayload(data) {
    if (!Array.isArray(data)) return 'payload nao e uma lista';
    const ids = new Set();
    for (const z of data) {
      if (!z || typeof z !== 'object' || Array.isArray(z)) return 'zap invalido na lista';
      const id = String(z.id == null ? '' : z.id).trim();
      if (!id) return 'zap sem id';
      if (ids.has(id)) return `id duplicado: ${id}`;
      ids.add(id);
    }
    return null;
  }

  return {
    configIssues,
    configBackupPath,
    isConfigUnsafe,
    configIssueSummary,
    loadJsonFile,
    saveJsonAtomic,
    moveToTrash,
    pruneTrash,
    validateZapsPayload
  };
}

module.exports = { createJsonStore };
