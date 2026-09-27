const fs = require('fs');
const path = require('path');
const AIResponder = require(path.join(__dirname, '..', 'src', 'js', 'ai-responder'));
const resolver = require(path.join(__dirname, '..', 'src', 'js', 'media-resolver'));

const root = path.join(__dirname, '..');
const dataDir = path.join(process.env.APPDATA || '', 'link-no-whatsapp', 'link-no-whatsapp');

function load(name) {
  const p = path.join(dataDir, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const providers = load('providers.json');
const trainingsData = load('trainings.json');
const zaps = load('zaps.json');

if (!providers || !trainingsData || !zaps || !zaps.length) {
  console.log('Nenhum dado de producao encontrado - nada para testar.');
  process.exit(0);
}

const zap = zaps[0];
const trainings = (trainingsData[String(zap.id)] || []).filter(t => t && t.enabled !== false);
const provider = providers.find(p => (zap.providers || []).includes(p.id)) || providers[0];
const key = provider.apiKey || (Array.isArray(provider.apiKeys) ? provider.apiKeys[0] : null);
const model = (provider.models || []).find(m => /flash/.test(m.id)) || (provider.models || [])[0];

if (!key || !model || trainings.length === 0) {
  console.log('Chave de API ou treinamento ausente - nada para testar.');
  process.exit(0);
}

const ai = new AIResponder();
const cfg = {
  aiName: zap.aiName || '',
  personality: zap.personality || 'padrao',
  area: zap.area || '',
  customPrompt: zap.customPrompt || '',
  trainings
};
const system = ai.getSystemPrompt(cfg);

const hasImages = trainings.some(t => (t.images || []).length > 0);
const hasLinks = trainings.some(t => (t.links || []).length > 0);

const cases = [];
if (hasImages) {
  cases.push({ msg: 'me mande o cardapio', wantImage: true });
  cases.push({ msg: 'me mande a foto do cardapio', wantImage: true });
  cases.push({ msg: 'QUAL e seu nome?', wantImage: false });
}
if (hasLinks) {
  cases.push({ msg: 'manda o link do cardapio', wantLink: true });
}

console.log(`Provedor: ${provider.name} / ${model.id}`);
console.log(`Treinamentos: ${trainings.length} | imagens: ${trainings.reduce((n, t) => n + (t.images || []).length, 0)} | links: ${trainings.reduce((n, t) => n + (t.links || []).length, 0)}\n`);

let failures = 0;

async function runCase(c) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: c.msg }
  ];

  let raw = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !raw; attempt++) {
    try {
      raw = await ai.callGoogleAI(model.id, key, messages);
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
  if (!raw) {
    console.log(`FALHOU  "${c.msg}" -> erro na API: ${lastErr.message}`);
    failures++;
    return;
  }

  const res = resolver.resolveReplyMedia(raw, c.msg, trainings, () => {});
  const markerImg = /\[SEND_IMAGE:[^\]]+\]/.test(raw);
  const markerLink = /\[SEND_LINK:[^\]]+\]/.test(raw);

  const problems = [];
  if (c.wantImage && !markerImg) problems.push('IA nao colocou [SEND_IMAGE]');
  if (c.wantImage && res.images.length !== 1) problems.push(`imagens resolvidas: ${res.images.length} (esperado 1)`);
  if (c.wantImage === false && res.images.length !== 0) problems.push(`anexou imagem sem pedido: ${res.images.length}`);
  if (c.wantLink && !markerLink && res.links.length !== 1) problems.push('IA nao colocou [SEND_LINK] e o fallback nao cobriu');
  if (res.text.includes('[SEND_IMAGE') || res.text.includes('[SEND_LINK')) problems.push('marcador vazou para o cliente');

  if (problems.length) {
    failures++;
    console.log(`FALHOU  "${c.msg}"`);
    console.log(`        ${problems.join('\n        ')}`);
  } else {
    console.log(`OK      "${c.msg}" -> imagens: ${res.images.length}, links: ${res.links.length}`);
  }
  console.log(`        IA: ${raw.replace(/\s+/g, ' ').trim().substring(0, 160)}`);
  console.log(`        Sai: ${res.text.replace(/\s+/g, ' ').trim().substring(0, 160)}`);
}

(async () => {
  for (const c of cases) {
    await runCase(c);
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(failures === 0 ? '\nTODOS OS CASOS DE IA PASSARAM' : `\n${failures} caso(s) falharam`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
