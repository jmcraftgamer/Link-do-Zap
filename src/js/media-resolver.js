function parseImageMarkers(text) {
  const re = /\[SEND_IMAGE:([^\]]+)\]/g;
  const ids = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = m[1].trim().replace(/^["'`]+|["'`]+$/g, '');
    if (id) ids.push(id);
  }
  const clean = String(text).replace(/\[SEND_IMAGE:[^\]]*\]?/g, '').replace(/\s{2,}/g, ' ').trim();
  return { ids, clean };
}

function normText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const IMAGE_REQUEST_RE = /(cardapio|catalogo|cardap|foto|imagem|menu|print)/;
const IMAGE_PROMISE_RE = /(aqui esta|segue|enviando|anexo|segue ai)/;

function wantsImageAttachment(userMessage, aiText) {
  if (IMAGE_REQUEST_RE.test(normText(userMessage))) return true;
  const r = normText(aiText);
  return IMAGE_PROMISE_RE.test(r) && IMAGE_REQUEST_RE.test(r);
}

function collectTrainingImages(enabledTrainings) {
  const out = [];
  for (const t of (enabledTrainings || [])) {
    if (!t || t.enabled === false) continue;
    for (const img of (Array.isArray(t.images) ? t.images : [])) {
      if (img && img.id) out.push({ img, training: t });
    }
  }
  return out;
}

function pickTrainingImage(enabledTrainings, userMessage, aiText) {
  const all = collectTrainingImages(enabledTrainings);
  if (all.length === 0) return null;
  if (all.length === 1) return all[0].img;

  const words = normText(`${userMessage} ${aiText}`).split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4);
  let best = all[0].img;
  let bestScore = 0;
  for (const entry of all) {
    const desc = normText(`${entry.img.name || ''} ${entry.img.description || ''} ${entry.training.title || ''}`);
    let score = 0;
    for (const w of words) if (desc.includes(w)) score++;
    if (score > bestScore) { best = entry.img; bestScore = score; }
  }
  return best;
}

function findTrainingImageById(enabledTrainings, id) {
  const wanted = String(id || '').trim();
  if (!wanted) return null;
  for (const t of (enabledTrainings || [])) {
    if (!t || t.enabled === false) continue;
    const img = (Array.isArray(t.images) ? t.images : []).find(im => String(im.id) === wanted);
    if (img) return img;
  }
  return null;
}

function applyLinkMarkers(text, enabledTrainings) {
  const used = [];
  const seen = new Set();
  const out = String(text).replace(/\[SEND_LINK:([^\]]*)\]?/g, (full, raw) => {
    const id = String(raw || '').trim().replace(/^["'`]+|["'`]+$/g, '');
    const lk = id ? findTrainingLinkById(enabledTrainings, id) : null;
    const url = lk ? normalizeUrl(lk.url) : '';
    if (!url) return '';
    if (seen.has(lk.id)) return '';
    seen.add(lk.id);
    used.push(lk);
    return url;
  });
  return { text: out.replace(/\s{2,}/g, ' ').trim(), links: used };
}

function collectTrainingLinks(enabledTrainings) {
  const out = [];
  for (const t of (enabledTrainings || [])) {
    if (!t || t.enabled === false) continue;
    for (const lk of (Array.isArray(t.links) ? t.links : [])) {
      if (lk && lk.id && lk.url) out.push({ lk, training: t });
    }
  }
  return out;
}

function findTrainingLinkById(enabledTrainings, id) {
  const wanted = String(id || '').trim();
  if (!wanted) return null;
  for (const entry of collectTrainingLinks(enabledTrainings)) {
    if (String(entry.lk.id) === wanted) return entry.lk;
  }
  return null;
}

function normalizeUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[\w-]+(\.[\w-]+)+/.test(u)) return 'https://' + u;
  return '';
}

function pickTrainingLink(enabledTrainings, userMessage, aiText) {
  const all = collectTrainingLinks(enabledTrainings);
  if (all.length === 0) return null;
  if (all.length === 1) return all[0].lk;

  const words = normText(`${userMessage} ${aiText}`).split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4);
  let best = all[0].lk;
  let bestScore = 0;
  for (const entry of all) {
    const desc = normText(`${entry.lk.name || ''} ${entry.lk.description || ''} ${entry.training.title || ''}`);
    let score = 0;
    for (const w of words) if (desc.includes(w)) score++;
    if (score > bestScore) { best = entry.lk; bestScore = score; }
  }
  return best;
}

function wantsLinkAttachment(userMessage, aiText, hasImage) {
  const u = normText(userMessage);
  if (/(^|\W)(link|url|site|digital|online)(\W|$)/.test(u)) return true;
  const r = normText(aiText);
  if (IMAGE_PROMISE_RE.test(r) && /(^|\W)(link|url|site)(\W|$)/.test(r)) return true;
  return !hasImage && IMAGE_REQUEST_RE.test(u);
}

function resolveReplyMedia(response, userMessage, enabledTrainings, log) {
  const say = typeof log === 'function' ? log : () => {};

  const parsedImages = parseImageMarkers(response);
  const aiText = parsedImages.clean;

  const images = [];
  const seenImgIds = new Set();
  for (const imgId of new Set(parsedImages.ids)) {
    const img = findTrainingImageById(enabledTrainings, imgId);
    if (!img) {
      say('warning', `Marcador de imagem ${imgId} nao corresponde a nenhuma imagem do treinamento`);
      continue;
    }
    if (seenImgIds.has(img.id)) continue;
    seenImgIds.add(img.id);
    images.push(img);
  }

  if (images.length === 0) {
    const fallbackImg = pickTrainingImage(enabledTrainings, userMessage, aiText);
    if (fallbackImg && wantsImageAttachment(userMessage, aiText)) {
      images.push(fallbackImg);
      say('info', `Marcador ausente na resposta da IA - imagem anexada por deteccao de intencao: ${fallbackImg.name || fallbackImg.filename || fallbackImg.id}`);
    }
  }

  const linkResult = applyLinkMarkers(aiText, enabledTrainings);
  const links = linkResult.links;
  let text = linkResult.text;

  if (links.length === 0 && wantsLinkAttachment(userMessage, text, images.length > 0)) {
    const lk = pickTrainingLink(enabledTrainings, userMessage, text);
    const url = lk ? normalizeUrl(lk.url) : '';
    if (url) {
      links.push(lk);
      text = `${text} ${url}`.trim();
      say('info', `Marcador de link ausente na resposta da IA - link anexado por deteccao de intencao: ${lk.name || lk.description || url}`);
    }
  }

  return { images, links, text };
}

module.exports = {
  parseImageMarkers,
  normText,
  wantsImageAttachment,
  collectTrainingImages,
  pickTrainingImage,
  findTrainingImageById,
  applyLinkMarkers,
  collectTrainingLinks,
  findTrainingLinkById,
  normalizeUrl,
  pickTrainingLink,
  wantsLinkAttachment,
  resolveReplyMedia
};
