const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const resolver = require(path.join(root, 'src', 'js', 'media-resolver'));
const AIResponder = require(path.join(root, 'src', 'js', 'ai-responder'));
const WhatsAppManager = require(path.join(root, 'src', 'js', 'whatsapp-manager'));

let passed = 0;
const failures = [];
const pending = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ name, error: e.message });
  }
}

function testAsync(name, fn) {
  pending.push({ name, fn });
}

const TR = [{
  enabled: true,
  title: 'Dikassa Acai',
  images: [
    { id: 'img_1', filename: 'p1.png', name: 'Cardapio salgados', description: 'Parte 1 do cardapio' },
    { id: 'img_2', filename: 'p2.png', name: 'Cardapio doces', description: 'Parte 2 do cardapio' }
  ],
  links: [
    { id: 'lnk_1', url: 'https://loja.com/cardapio', description: 'Cardapio digital' },
    { id: 'lnk_2', url: 'https://loja.com/regras', description: 'Regras da loja' }
  ]
}];

const TR1 = [TR[0].images.length ? {
  enabled: true,
  title: 'Teste',
  images: [{ id: 'img_a', filename: 'menu.png', name: 'Cardapio', description: 'Cardapio da loja' }],
  links: [{ id: 'lnk_a', url: 'https://loja.com/menu', description: 'Cardapio digital' }]
} : null].filter(Boolean);

const ids = (r) => r.images.map(i => i.id);

test('marcador simples de imagem', () => {
  assert.deepStrictEqual(resolver.parseImageMarkers('[SEND_IMAGE:img_1]').ids, ['img_1']);
  assert.strictEqual(resolver.parseImageMarkers('[SEND_IMAGE:img_1]').clean, '');
});

test('marcador com espaco e aspas e normalizado', () => {
  assert.deepStrictEqual(resolver.parseImageMarkers('[SEND_IMAGE: img_1 ]').ids, ['img_1']);
  assert.deepStrictEqual(resolver.parseImageMarkers('[SEND_IMAGE:`img_1`]').ids, ['img_1']);
});

test('marcador truncado nao vira id e sai do texto', () => {
  const r = resolver.parseImageMarkers('Claro, aqui esta a foto [SEND_IMAGE:img_17');
  assert.deepStrictEqual(r.ids, []);
  assert.strictEqual(r.clean, 'Claro, aqui esta a foto');
});

test('marcadores repetidos viram um id so', () => {
  const r = resolver.parseImageMarkers('[SEND_IMAGE:img_1] x [SEND_IMAGE:img_1]');
  assert.deepStrictEqual([...new Set(r.ids)], ['img_1']);
});

test('id inexistente nao resolvem imagem', () => {
  assert.strictEqual(resolver.findTrainingImageById(TR, 'img123'), null);
  assert.strictEqual(resolver.findTrainingImageById(TR, ' img_1 ').id, 'img_1');
});

test('REGRESSAO: 4 marcadores invalidos + intencao envia UMA imagem', () => {
  const r = resolver.resolveReplyMedia(
    'Claro, aqui esta o cardapio: [SEND_IMAGE:img123][SEND_IMAGE:img123][SEND_IMAGE:img123][SEND_IMAGE:img123]',
    'me mande o cardapio', TR1, () => {});
  assert.strictEqual(r.images.length, 1);
  assert.strictEqual(r.images[0].id, 'img_a');
});

test('REGRESSAO: marcadores invalidos sem intencao nao envia imagem', () => {
  const r = resolver.resolveReplyMedia('[SEND_IMAGE:bogus] e mais [SEND_IMAGE:outro]', 'qual seu nome?', TR1, () => {});
  assert.strictEqual(r.images.length, 0);
});

test('cardapio em 2 partes: dois marcadores validos = 2 imagens', () => {
  const r = resolver.resolveReplyMedia('Segue: [SEND_IMAGE:img_1] [SEND_IMAGE:img_2]', 'me mande o cardapio', TR, () => {});
  assert.deepStrictEqual(ids(r), ['img_1', 'img_2']);
});

test('marcador repetido do mesmo id envia 1 imagem', () => {
  const r = resolver.resolveReplyMedia('[SEND_IMAGE:img_1] [SEND_IMAGE:img_1]', 'me mande o cardapio', TR, () => {});
  assert.deepStrictEqual(ids(r), ['img_1']);
});

test('sem marcador + pedido de imagem: fallback anexa 1 imagem', () => {
  const r = resolver.resolveReplyMedia('Claro, aqui esta', 'me mande a foto do cardapio', TR1, () => {});
  assert.strictEqual(r.images.length, 1);
});

test('sem marcador e sem intencao: nada e anexado', () => {
  const r = resolver.resolveReplyMedia('Oi, em que posso ajudar?', 'oi', TR1, () => {});
  assert.strictEqual(r.images.length, 0);
  assert.strictEqual(r.links.length, 0);
});

test('pergunta normal com "cardapio" so no treinamento nao anexa', () => {
  const r = resolver.resolveReplyMedia('Sai por R$ 20, quer que eu reserve?', 'o preco ta bom', TR1, () => {});
  assert.strictEqual(r.images.length, 0);
});

test('link marcado vira URL no texto', () => {
  const r = resolver.resolveReplyMedia('Aqui esta: [SEND_LINK:lnk_1]', 'me mande o link do cardapio', TR, () => {});
  assert.strictEqual(r.text, 'Aqui esta: https://loja.com/cardapio');
  assert.strictEqual(r.links.length, 1);
});

test('link marcado invalido sai do texto e nao gera link', () => {
  const r = resolver.resolveReplyMedia('x [SEND_LINK:bogus] y', 'qual seu nome?', TR, () => {});
  assert.strictEqual(r.text, 'x y');
  assert.strictEqual(r.links.length, 0);
});

test('link invalido + pedido de link: fallback preenche a lacuna', () => {
  const r = resolver.resolveReplyMedia('x [SEND_LINK:bogus] y', 'manda o link', TR, () => {});
  assert.strictEqual(r.text, 'x y https://loja.com/cardapio');
  assert.strictEqual(r.links.length, 1);
});

test('link marcado repetido aparece uma vez', () => {
  const r = resolver.resolveReplyMedia('[SEND_LINK:lnk_1] [SEND_LINK:lnk_1]', 'manda o link', TR, () => {});
  assert.strictEqual(r.text, 'https://loja.com/cardapio');
  assert.strictEqual(r.links.length, 1);
});

test('sem marcador de link + pedido de link: fallback anexa a URL', () => {
  const r = resolver.resolveReplyMedia('Claro', 'manda o link do cardapio', TR, () => {});
  assert.strictEqual(r.links.length, 1);
  assert.ok(r.text.includes('https://loja.com/cardapio'));
});

test('pedido de imagem sem imagem cadastrada anexa o link', () => {
  const onlyLink = [{ enabled: true, title: 'T', images: [], links: [{ id: 'l1', url: 'https://loja.com/m', description: 'Cardapio digital' }] }];
  const r = resolver.resolveReplyMedia('Claro', 'me mande o cardapio', onlyLink, () => {});
  assert.strictEqual(r.images.length, 0);
  assert.strictEqual(r.links.length, 1);
});

test('sem link cadastrado o fallback nao faz nada', () => {
  const onlyImg = [{ enabled: true, title: 'T', images: [{ id: 'i1', filename: 'a.png' }], links: [] }];
  const r = resolver.resolveReplyMedia('Oi', 'manda o link da loja', onlyImg, () => {});
  assert.strictEqual(r.links.length, 0);
});

test('normalizeUrl aceita sem protocolo e recusa lixo', () => {
  assert.strictEqual(resolver.normalizeUrl('loja.com/m'), 'https://loja.com/m');
  assert.strictEqual(resolver.normalizeUrl('http://loja.com'), 'http://loja.com');
  assert.strictEqual(resolver.normalizeUrl('nada'), '');
  assert.strictEqual(resolver.normalizeUrl(''), '');
});

test('pickTrainingImage usa nome e descricao', () => {
  assert.strictEqual(resolver.pickTrainingImage(TR, 'manda o cardapio doces', '').id, 'img_2');
  assert.strictEqual(resolver.pickTrainingImage(TR, 'manda o cardapio salgados', '').id, 'img_1');
});

test('pickTrainingLink usa descricao', () => {
  assert.strictEqual(resolver.pickTrainingLink(TR, 'manda o link do cardapio', '').id, 'lnk_1');
  assert.strictEqual(resolver.pickTrainingLink(TR, 'manda o link das regras', '').id, 'lnk_2');
});

test('wantsImageAttachment: positivos e negativos', () => {
  assert.strictEqual(resolver.wantsImageAttachment('me mande o cardapio', ''), true);
  assert.strictEqual(resolver.wantsImageAttachment('voce tem cardápio?', ''), true);
  assert.strictEqual(resolver.wantsImageAttachment('QUAL é seu nome?', ''), false);
  assert.strictEqual(resolver.wantsImageAttachment('oi', ''), false);
  assert.strictEqual(resolver.wantsImageAttachment('qual o valor', 'Aqui esta o cardapio:'), true);
  assert.strictEqual(resolver.wantsImageAttachment('qual o valor', 'Aqui esta: R$ 20'), false);
});

test('wantsLinkAttachment: positivos e negativos', () => {
  assert.strictEqual(resolver.wantsLinkAttachment('manda o link', '', false), true);
  assert.strictEqual(resolver.wantsLinkAttachment('me manda o cardapio digital', '', false), true);
  assert.strictEqual(resolver.wantsLinkAttachment('me manda o cardapio', '', false), true);
  assert.strictEqual(resolver.wantsLinkAttachment('me manda o cardapio', '', true), false);
  assert.strictEqual(resolver.wantsLinkAttachment('qual o valor', '', false), false);
  assert.strictEqual(resolver.wantsLinkAttachment('oi', '', false), false);
});

test('treinamento desativado nao entra', () => {
  const off = [{ enabled: false, images: [{ id: 'x', filename: 'f.png' }], links: [] }];
  assert.strictEqual(resolver.pickTrainingImage(off, 'cardapio', ''), null);
  assert.strictEqual(resolver.resolveReplyMedia('[SEND_IMAGE:x]', 'cardapio', off, () => {}).images.length, 0);
});

test('prompt: imagem sai com nome e descricao', () => {
  const s = new AIResponder().buildTrainingsSection(TR);
  assert.ok(s.includes('[SEND_IMAGE:img_1]'));
  assert.ok(s.includes('nome: Cardapio salgados'));
  assert.ok(s.includes('sobre: Parte 1 do cardapio'));
});

test('prompt: link sai com marcador e descricao', () => {
  const s = new AIResponder().buildTrainingsSection(TR);
  assert.ok(s.includes('[SEND_LINK:lnk_1]'));
  assert.ok(s.includes('sobre: Cardapio digital'));
  assert.ok(!s.includes('https://loja.com/cardapio'), 'URL nao deve aparecer no prompt');
});

test('prompt: regra de varias imagens existe', () => {
  const s = new AIResponder().buildTrainingsSection(TR);
  assert.ok(s.includes('MAIS DE UMA imagem'));
  assert.ok(s.includes('UM marcador apenas'));
});

test('prompt final: excecao dos marcadores existe e vem depois da proibicao', () => {
  const s = new AIResponder().getSystemPrompt({ personality: 'atendente', trainings: TR });
  const proib = s.indexOf('nao use marcadores');
  const exc = s.indexOf('UNICA EXCECAO');
  assert.ok(proib >= 0, 'regra de nao usar marcadores ausente');
  assert.ok(exc > proib, 'excecao deve vir depois da proibicao');
  assert.ok(s.includes('[SEND_IMAGE:id]'));
  assert.ok(s.includes('[SEND_LINK:id]'));
});

test('fonte: sendMedia so da retry em excecao (bug das 4 imagens)', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'js', 'whatsapp-manager.js'), 'utf8');
  assert.ok(src.includes('let sendDone = false;'));
  assert.ok(src.includes('attempt <= 3 && !sendDone'));
  assert.ok(src.includes('sendDone = true;'));
  assert.ok(!/for \(let attempt = 1; attempt <= 3 && !sentMsg;/.test(src));
});

test('fonte: codigo injetado nao usa Msg.get quebrado e tem o strip de midia', () => {
  const p = path.join(root, 'node_modules', 'wwebjs-electron', 'src', 'util', 'Injected', 'Utils.js');
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(!src.includes('Msg.get(newMsgKey._serialized)'), 'Msg.get com _serialized continua no codigo');
  assert.ok(src.includes('mediaFields'), 'strip de mediaOptions ausente');
  assert.ok(!src.includes('...mediaOptions,'), 'spread cru de mediaOptions continua');
  assert.ok(src.includes('return null;'), 'sendMessage precisa retornar null seguro');
});

test('fonte: main.js usa o modulo de resolucao', () => {
  const src = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.ok(src.includes("require('./src/js/media-resolver')"));
  assert.ok(!src.includes('function parseImageMarkers'));
  assert.ok(src.includes('resolveReplyMedia('));
});

test('modulo carrega e exporta tudo que o main usa', () => {
  const r = resolver.resolveReplyMedia('oi', 'oi', [], () => {});
  assert.deepStrictEqual(Object.keys(r).sort(), ['images', 'links', 'text']);
  assert.strictEqual(r.text, 'oi');
});

test('UI: campos de nome/descricao e secao de links estao ligados', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'js', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  assert.ok(app.includes('modal-image-name-field'));
  assert.ok(app.includes('modalPendingLinks[idx].name') || app.includes('modalPendingImages[idx].name'));
  assert.ok(app.includes('renderModalLinks()'));
  assert.ok(app.includes('t.links = links'));
  assert.ok(app.includes('links,'));
  assert.ok(app.includes('addTrainingLinkFromInputs'));
  assert.ok(html.includes('trainingLinkUrl'));
  assert.ok(html.includes('trainingLinkDesc'));
  assert.ok(html.includes('trainingLinksList'));
  assert.ok(html.includes('addTrainingLink'));
});

test('UI: CSS dos novos elementos existe', () => {
  const css = fs.readFileSync(path.join(root, 'src', 'css', 'styles.css'), 'utf8');
  for (const cls of ['.modal-image-name-field', '.link-add-row', '.modal-link-item', '.modal-link-url', '.modal-link-remove', '.training-item-links']) {
    assert.ok(css.includes(cls), `classe ausente no CSS: ${cls}`);
  }
});

test('smoke: dados reais de treinamento geram prompt e resolvem midia', () => {
  const p = path.join(process.env.APPDATA || '', 'link-no-whatsapp', 'link-no-whatsapp', 'trainings.json');
  if (!fs.existsSync(p)) return;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const all = Object.values(data).flat().filter(Boolean);
  if (all.length === 0) return;

  const prompt = new AIResponder().buildTrainingsSection(all);
  const first = all[0];
  if ((first.images || []).length) {
    assert.ok(prompt.includes(`[SEND_IMAGE:${first.images[0].id}]`));
    const r = resolver.resolveReplyMedia(`Aqui esta: [SEND_IMAGE:${first.images[0].id}]`, 'me mande o cardapio', all, () => {});
    assert.strictEqual(r.images.length, 1);
    assert.strictEqual(r.text, 'Aqui esta:');
  }
  if ((first.links || []).length) {
    assert.ok(prompt.includes(`[SEND_LINK:${first.links[0].id}]`));
    const r = resolver.resolveReplyMedia(`Link: [SEND_LINK:${first.links[0].id}]`, 'manda o link', all, () => {});
    assert.strictEqual(r.text, `Link: ${first.links[0].url}`);
  }
});

function makeManager(sendImpl) {
  const mgr = new WhatsAppManager(null);
  const state = { calls: 0 };
  mgr.clients.set('zap1', {
    status: 'ready',
    selfNumber: '',
    messages: new Map(),
    pendingAiSends: [],
    aiSending: false,
    client: {
      pupPage: null,
      sendMessage: async () => {
        state.calls++;
        return sendImpl(state.calls);
      }
    }
  });
  return { mgr, state };
}

const MEDIA = { data: 'aGVsbG8=', mimeType: 'image/png', name: 'menu.png' };

testAsync('REGRESSAO: sendMedia com retorno undefined chama sendMessage UMA vez', async () => {
  const { mgr, state } = makeManager(() => undefined);
  const r = await mgr.sendMedia('zap1', '5511999999999', MEDIA);
  assert.deepStrictEqual(r, { success: true });
  assert.strictEqual(state.calls, 1, `esperava 1 envio, houve ${state.calls}`);
});

testAsync('sendMedia: falha transitoria tenta de novo e envia 1 vez', async () => {
  const { mgr, state } = makeManager((n) => { if (n === 1) throw new Error('pagina recarregando'); return undefined; });
  const r = await mgr.sendMedia('zap1', '5511999999999', MEDIA);
  assert.deepStrictEqual(r, { success: true });
  assert.strictEqual(state.calls, 2, `esperava 2 chamadas, houve ${state.calls}`);
});

testAsync('sendMedia: falha total para em 3 tentativas (sem loop infinito)', async () => {
  const { mgr, state } = makeManager(() => { throw new Error('sempre falha'); });
  await assert.rejects(() => mgr.sendMedia('zap1', '5511999999999', MEDIA));
  assert.strictEqual(state.calls, 3, `esperava 3 chamadas, houve ${state.calls}`);
});

testAsync('sendMedia: zap desconectado lanca erro sem chamar a pagina', async () => {
  const mgr = new WhatsAppManager(null);
  await assert.rejects(() => mgr.sendMedia('naoexiste', '5511999999999', MEDIA), /nao esta conectado/);
});

async function runPending() {
  for (const p of pending) {
    try {
      await p.fn();
      passed++;
    } catch (e) {
      failures.push({ name: p.name, error: e.message });
    }
  }

  console.log(`\n${passed} teste(s) passaram`);
  if (failures.length) {
    console.log(`\n${failures.length} FALHA(S):`);
    for (const f of failures) console.log(`  - ${f.name}\n      ${f.error}`);
    process.exitCode = 1;
  } else {
    console.log('TODOS OS TESTES PASSARAM');
  }
}

runPending();
