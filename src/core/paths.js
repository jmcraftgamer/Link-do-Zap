// Resolucao de caminhos independente de Electron.
// O app desktop injeta `getApp`; o backend usa LINK_DATA_DIR / dataDir fixo.
const path = require('path');
const fs = require('fs');

function createPaths(options = {}) {
  const getApp = typeof options.getApp === 'function' ? options.getApp : () => null;
  const fixedDataDir = options.dataDir ? path.resolve(String(options.dataDir)) : null;
  const folderName = options.folderName || 'link-no-whatsapp';

  function getDataDir() {
    if (fixedDataDir && !process.env.LINK_DATA_DIR) return fixedDataDir;
    try {
      if (process.env.LINK_DATA_DIR) return path.resolve(process.env.LINK_DATA_DIR);
    } catch (_) {}
    try {
      const app = getApp();
      if (app && typeof app.getPath === 'function') {
        return path.join(app.getPath('userData'), folderName);
      }
    } catch (_) {}
    const base = process.env.APPDATA || process.env.HOME || process.env.USERPROFILE ||
      require('os').homedir();
    return path.join(base, folderName);
  }

  function getFilePath(filename) {
    return path.join(getDataDir(), filename);
  }

  function ensureDataDir() {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // Garante que um caminho relativo nao escape da pasta de dados.
  function resolveDataPath(rel) {
    const base = path.resolve(getDataDir());
    const abs = path.resolve(base, rel);
    const relative = path.relative(base, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    // Windows case-insensitive check
    if (abs.toLowerCase().indexOf(base.toLowerCase()) !== 0) return null;
    return abs;
  }

  return { getDataDir, getFilePath, ensureDataDir, resolveDataPath };
}

module.exports = { createPaths };
