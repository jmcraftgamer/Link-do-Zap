// Aplica os patches de dependencias (patches/*.patch, formato patch-package)
// apos npm install/ci. Sem git: parser proprio de unified diff, com match
// exato de contexto e verificacao - falha alto se nao aplicar.
// Idempotente: se o patch ja esta aplicado (aplicacao reversa da), so avisa.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const patchesDir = path.join(root, 'patches');

function parsePatch(rawText) {
  const text = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const files = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[i]);
    if (!m) { i++; continue; }
    const filePath = m[2];
    i++;
    let oldFile = null, newFile = null;
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
      if (lines[i].startsWith('--- ')) oldFile = lines[i].slice(4).replace(/^a\//, '');
      if (lines[i].startsWith('+++ ')) newFile = lines[i].slice(4).replace(/^b\//, '');
      i++;
    }
    if (oldFile === null || newFile === null) throw new Error(`---/+++ ausente em ${filePath}`);
    if (oldFile === '/dev/null' || newFile === '/dev/null') throw new Error(`criacao/remocao de arquivo nao suportada: ${filePath}`);
    const hunks = [];
    while (i < lines.length && lines[i].startsWith('@@')) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
      if (!hm) throw new Error(`hunk invalido: ${lines[i]}`);
      const oldStart = parseInt(hm[1], 10);
      const oldCount = hm[2] !== undefined ? parseInt(hm[2], 10) : 1;
      i++;
      const ops = [];
      let consumed = 0;
      while (i < lines.length) {
        const l = lines[i];
        if (l.startsWith('@@') || l.startsWith('diff --git')) break;
        if (l.startsWith(' ')) { ops.push([' ', l.slice(1)]); consumed++; i++; }
        else if (l.startsWith('-')) { ops.push(['-', l.slice(1)]); consumed++; i++; }
        else if (l.startsWith('+')) { ops.push(['+', l.slice(1)]); i++; }
        else if (l.startsWith('\\')) { i++; } // \ No newline at end of file
        else break;
      }
      if (consumed !== oldCount) throw new Error(`hunk em ${filePath}: esperava ${oldCount} linhas velhas, li ${consumed}`);
      hunks.push({ oldStart, ops });
    }
    files.push({ path: filePath, hunks });
  }
  if (!files.length) throw new Error('nenhum arquivo encontrado no patch');
  return files;
}

// Aplica hunks (sequencia com offset). reverse=inverte +/- (check reverso).
function applyFile(lines, hunks, reverse) {
  const out = lines.slice();
  let offset = 0;
  for (const h of hunks) {
    const expect = h.oldStart - 1 + offset;
    const ops = reverse ? h.ops.map(([t, x]) => [t === '+' ? '-' : t === '-' ? '+' : t, x]) : h.ops;
    const tryAt = (start) => {
      const res = [];
      let s = start;
      for (const [t, x] of ops) {
        if (t === ' ') {
          if (s >= out.length || out[s] !== x) return null;
          res.push(out[s]); s++;
        } else if (t === '-') {
          if (s >= out.length || out[s] !== x) return null;
          s++;
        } else {
          res.push(x);
        }
      }
      return { res, end: s };
    };
    let r = tryAt(expect);
    if (!r) {
      for (let p = 0; p < out.length && !r; p++) {
        if (p === expect) continue;
        r = tryAt(p);
      }
    }
    if (!r) return false;
    out.splice(expect, r.end - expect, ...r.res);
    offset += r.res.length - (r.end - expect);
  }
  return out;
}

if (!fs.existsSync(patchesDir)) {
  console.log('[patches] diretor patches/ inexistente - nada a fazer');
  process.exit(0);
}

let falhou = false;

for (const file of fs.readdirSync(patchesDir).filter((f) => f.endsWith('.patch'))) {
  const m = file.replace(/\.patch$/, '').match(/^(.+)\+(\d+\.\d+\.\d+.*)$/);
  if (!m) {
    console.log(`[patches] nome fora do padrao, ignorando: ${file}`);
    continue;
  }
  const pkgDir = path.join(root, 'node_modules', m[1]);
  if (!fs.existsSync(pkgDir)) {
    console.log(`[patches] ${m[1]} nao instalado - pulando ${file}`);
    continue;
  }
  try {
    const parsed = parsePatch(fs.readFileSync(path.join(patchesDir, file), 'utf8'));
    let algumAlterado = false;
    let aplicados = 0;
    for (const f of parsed) {
      const alvo = path.join(pkgDir, f.path);
      const atual = fs.readFileSync(alvo, 'utf8');
      const linhas = atual.split('\n');
      const direto = applyFile(linhas, f.hunks, false);
      if (direto) {
        fs.writeFileSync(alvo, direto.join('\n'));
        algumAlterado = true;
        aplicados++;
        continue;
      }
      const reverso = applyFile(linhas, f.hunks, true);
      if (reverso) continue; // ja aplicado
      throw new Error(`contexto nao bateu em ${f.path}`);
    }
    console.log(
      aplicados > 0
        ? `[patches] aplicado: ${file} (${aplicados} arquivo(s))`
        : `[patches] ja aplicado: ${file}`
    );
    if (algumAlterado && aplicados === 0) falhou = true;
  } catch (e) {
    console.error(`[patches] FALHOU: ${file}`);
    console.error('  ' + e.message);
    falhou = true;
  }
}

process.exit(falhou ? 1 : 0);
