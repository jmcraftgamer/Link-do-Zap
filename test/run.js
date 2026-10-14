const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const resolver = require(path.join(root, 'src', 'js', 'media-resolver'));
const AIResponder = require(path.join(root, 'src', 'js', 'ai-responder'));
const ConversationStore = require(path.join(root, 'src', 'js', 'conversation-store'));
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
  // Envio robusto: sucesso RETORNA na hora (sem retry); so repete em excecao
  assert.ok(src.includes('async _sendRobust('), '_sendRobust ausente');
  assert.ok(src.includes('return await doSend(cd.client, id);'), 'sucesso deve retornar sem dar retry');
  assert.ok(src.includes('const attempts = 3;'), 'limite de 3 tentativas ausente');
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

// ================= MEMORIA / HISTORICO DE CONVERSAS =================
const os = require('os');
const TMP_CONV_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-store-'));

function at(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

function newStore(options) {
  return new ConversationStore(null, options);
}

function convMsg(body) {
  return {
    zapId: 'z1',
    body,
    from: '551199999@c.us',
    chat: { id: 'c1' },
    contact: { name: 'Joao' }
  };
}

function convConfig(conversationInfo) {
  return {
    aiName: '',
    personality: 'padrao',
    area: '',
    customPrompt: '',
    provider: { name: 'Teste' },
    model: { id: 'm1' },
    trainings: [],
    conversationInfo: conversationInfo || null
  };
}

test('MEMORIA: primeira mensagem abre uma conversa nova', () => {
  const s = newStore();
  const r = s.ensure('z1', 'c1', at(2026, 9, 27, 10, 0));
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.conversation.day, '2026-09-27');
  assert.strictEqual(r.conversation.endedAt, null);
  assert.strictEqual(r.conversation.messages.length, 0);
});

test('MEMORIA: mensagem seguinte no mesmo dia continua na MESMA conversa', () => {
  const s = newStore();
  const a = s.ensure('z1', 'c1', at(2026, 9, 27, 10, 0)).conversation;
  s.append('z1', 'c1', 'user', 'oi');
  const b = s.ensure('z1', 'c1', at(2026, 9, 27, 23, 50)).conversation;
  assert.strictEqual(b.id, a.id);
  assert.strictEqual(b.messages.length, 1);
  assert.strictEqual(s.history('z1', 'c1').length, 1);
});

test('MEMORIA: apos 00:00 a conversa anterior fecha e abre outra vazia', () => {
  const s = newStore();
  const a = s.ensure('z1', 'c1', at(2026, 9, 27, 23, 0)).conversation;
  s.append('z1', 'c1', 'user', 'boa noite');
  const r = s.ensure('z1', 'c1', at(2026, 9, 28, 0, 5));
  assert.strictEqual(r.created, true);
  assert.notStrictEqual(r.conversation.id, a.id);
  assert.strictEqual(a.endedAt, at(2026, 9, 28, 0, 0), 'finalizada exatamente as 00:00');
  assert.strictEqual(s.history('z1', 'c1').length, 0, 'conversa nova comeca sem historico');
});

test('MEMORIA: rollOver das 00:00 fecha conversa mesmo com o app desligado', () => {
  const s = newStore();
  const a = s.ensure('z1', 'c1', at(2026, 9, 27, 23, 30)).conversation;
  assert.strictEqual(s.rollOver(at(2026, 9, 28, 0, 2)), true);
  assert.strictEqual(a.endedAt, at(2026, 9, 28, 0, 0));
  assert.strictEqual(s.rollOver(at(2026, 9, 28, 0, 3)), false, 'segunda chamada nao muda nada');
  const b = s.ensure('z1', 'c1', at(2026, 9, 28, 8, 0));
  assert.strictEqual(b.created, true);
});

test('MEMORIA: cada contato tem a sua propria conversa', () => {
  const s = newStore();
  s.ensure('z1', 'c1', at(2026, 9, 27, 10, 0));
  s.ensure('z1', 'c2', at(2026, 9, 27, 10, 0));
  s.append('z1', 'c1', 'user', 'fala do c1');
  assert.strictEqual(s.history('z1', 'c1').length, 1);
  assert.strictEqual(s.history('z1', 'c2').length, 0);
  assert.strictEqual(s.countFor('z1', 'c1'), 1);
  assert.strictEqual(s.countFor('z1', 'c2'), 1);
});

test('MEMORIA: historico persiste em disco e volta ao reiniciar o app', () => {
  const file = path.join(TMP_CONV_DIR, `conv-${Date.now()}.json`);
  const s1 = new ConversationStore(file);
  s1.ensure('z1', 'c1', at(2026, 9, 27, 10, 0));
  s1.append('z1', 'c1', 'user', 'quanto custa?');
  s1.append('z1', 'c1', 'assistant', 'R$ 50');
  s1.flush();
  assert.ok(fs.existsSync(file));

  const s2 = new ConversationStore(file);
  assert.strictEqual(s2.history('z1', 'c1').length, 2);
  assert.deepStrictEqual(s2.history('z1', 'c1')[1], { role: 'assistant', content: 'R$ 50' });
  const r = s2.ensure('z1', 'c1', at(2026, 9, 27, 18, 0));
  assert.strictEqual(r.created, false, 'no mesmo dia reaproveita a conversa');
  const r2 = s2.ensure('z1', 'c1', at(2026, 9, 28, 18, 0));
  assert.strictEqual(r2.created, true, 'no dia seguinte abre conversa nova');
  fs.rmSync(file, { force: true });
});

test('MEMORIA: arquivo corrompido nao derruba o app', () => {
  const file = path.join(TMP_CONV_DIR, `broken-${Date.now()}.json`);
  fs.writeFileSync(file, 'nao e json {');
  const s = new ConversationStore(file);
  assert.strictEqual(s.conversations.length, 0);
  assert.strictEqual(s.ensure('z1', 'c1', at(2026, 9, 27, 10, 0)).created, true);
  fs.rmSync(file, { force: true });
});

test('MEMORIA: historico do contato e cortado no limite configurado', () => {
  const s = newStore({ maxMessagesPerConversation: 4 });
  s.ensure('z1', 'c1', at(2026, 9, 27, 10, 0));
  for (let i = 1; i <= 10; i++) s.append('z1', 'c1', i % 2 ? 'user' : 'assistant', `msg ${i}`);
  const h = s.history('z1', 'c1');
  assert.strictEqual(h.length, 4);
  assert.strictEqual(h[3].content, 'msg 10');
  assert.strictEqual(h[0].content, 'msg 7');
});

test('MEMORIA: limpar historico por contato e por zap', () => {
  const s = newStore();
  s.ensure('z1', 'c1', at(2026, 9, 27, 10, 0));
  s.append('z1', 'c1', 'user', 'a');
  s.ensure('z2', 'c1', at(2026, 9, 27, 10, 0));
  s.append('z2', 'c1', 'user', 'b');
  assert.strictEqual(s.clearForChat('z1', 'c1'), 1);
  assert.strictEqual(s.history('z1', 'c1').length, 0);
  assert.strictEqual(s.history('z2', 'c1').length, 1);
  assert.strictEqual(s.clearForZap('z2'), 1);
  assert.strictEqual(s.history('z2', 'c1').length, 0);
});

test('MEMORIA: conversas em excesso sao removidas (guarda so as mais novas)', () => {
  const s = newStore({ maxConversationsPerChat: 2, maxAgeDays: 3650 });
  const createdIds = [];
  for (let d = 1; d <= 5; d++) {
    const r = s.ensure('z1', 'c1', at(2026, 9, d, 10, 0));
    createdIds.push(r.conversation.id);
    s.append('z1', 'c1', 'user', `dia ${d}`);
    r.conversation.endedAt = at(2026, 9, d + 1, 0, 0);
  }
  assert.strictEqual(s.countFor('z1', 'c1'), 2, 'so as 2 conversas mais novas ficam');
  const kept = s.conversations.filter(c => c.key === 'z1|c1').map(c => c.id);
  assert.ok(kept.includes(createdIds[4]));
  assert.ok(kept.includes(createdIds[3]));
  assert.ok(!kept.includes(createdIds[0]));
});

test('MEMORIA: endOfDay marca exatamente as 00:00 do dia seguinte', () => {
  assert.strictEqual(ConversationStore.endOfDay('2026-09-27'), at(2026, 9, 28, 0, 0));
  assert.strictEqual(ConversationStore.dayKey(at(2026, 9, 27, 23, 59)), '2026-09-27');
  assert.strictEqual(ConversationStore.dayKey(at(2026, 9, 28, 0, 1)), '2026-09-28');
});

function makeStoreAiFixed(store, reply) {
  const ai = new AIResponder();
  ai.setHistoryStore(store);
  const calls = [];
  ai.callAI = async (provider, model, messages) => {
    calls.push(messages.map(m => ({ role: m.role, content: m.content })));
    return typeof reply === 'function' ? reply(calls.length) : (reply || 'Certo, ja anotei.');
  };
  return { ai, calls };
}

testAsync('MEMORIA IA: 1a resposta registra user + assistant no historico', async () => {
  const s = newStore();
  const { ai, calls } = makeStoreAiFixed(s);
  s.ensure('z1', 'c1', at(2026, 9, 27, 10, 0));
  const r = await ai.generateResponse(convMsg('oi'), convConfig(null), undefined);
  assert.strictEqual(r, 'Certo, ja anotei.');
  assert.deepStrictEqual(s.history('z1', 'c1'), [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: 'Certo, ja anotei.' }
  ]);
  assert.strictEqual(calls[0].length, 2, 'system + a mensagem atual');
  assert.strictEqual(calls[0][0].role, 'system');
  assert.strictEqual(calls[0][1].content, 'oi');
});

testAsync('MEMORIA IA: 2a mensagem leva o historico da 1a para o modelo', async () => {
  const s = newStore();
  const { ai, calls } = makeStoreAiFixed(s);
  s.ensure('z1', 'c1', at(2026, 9, 27, 10, 0));
  await ai.generateResponse(convMsg('oi'), convConfig(null), undefined);
  await ai.generateResponse(convMsg('quanto custa?'), convConfig({ label: '10:00', count: 2 }), undefined);

  assert.strictEqual(calls.length, 2);
  const msgs = calls[1];
  assert.strictEqual(msgs[msgs.length - 1].content, 'quanto custa?');
  assert.deepStrictEqual(msgs.slice(1).map(m => m.content),
    ['oi', 'Certo, ja anotei.', 'quanto custa?']);
  assert.ok(msgs[0].content.includes('MEMORIA DA CONVERSA ATUAL'), 'prompt explica a memoria');
  assert.strictEqual(s.history('z1', 'c1').length, 4);
});

testAsync('MEMORIA IA: falha total nao deixa mensagem pendurada no historico', async () => {
  const s = newStore();
  const { ai } = makeStoreAiFixed(s, () => { throw new Error('API fora do ar'); });
  s.ensure('z1', 'c1', at(2026, 9, 27, 10, 0));
  const r = await ai.generateResponse(convMsg('oi'), convConfig(null), undefined);
  assert.strictEqual(r, null);
  assert.strictEqual(s.history('z1', 'c1').length, 0, 'nada e memorizado sem resposta');
});

testAsync('MEMORIA IA: marcadores nao ficam gravados no historico', async () => {
  const s = newStore();
  const { ai } = makeStoreAiFixed(s, 'Aqui esta:[QUEBRA]Bom apetite! [SEND_IMAGE:img_1]');
  s.ensure('z1', 'c1', at(2026, 9, 27, 10, 0));
  await ai.generateResponse(convMsg('me mande o cardapio'), convConfig(null), undefined);
  ai.updateLastAssistant('z1', 'c1', 'Aqui esta: Bom apetite!');
  const h = s.history('z1', 'c1');
  assert.strictEqual(h.length, 2);
  assert.strictEqual(h[1].content, 'Aqui esta: Bom apetite!');
  assert.strictEqual(h[1].content.includes('[SEND_IMAGE'), false);
  assert.strictEqual(h[1].content.includes('[QUEBRA]'), false);
});

testAsync('MEMORIA IA: midia enviada vira registro legivel no historico', async () => {
  const s = newStore();
  const { ai } = makeStoreAiFixed(s, 'Aqui esta');
  s.ensure('z1', 'c1', at(2026, 9, 27, 10, 0));
  await ai.generateResponse(convMsg('me mande o cardapio'), convConfig(null), undefined);
  ai.updateLastAssistant('z1', 'c1', 'Aqui esta');
  s.append('z1', 'c1', 'assistant', '[enviou imagem: Cardapio salgados]');
  const h = s.history('z1', 'c1');
  assert.strictEqual(h.length, 3);
  assert.ok(h[2].content.includes('Cardapio salgados'));
  assert.strictEqual(s.info('z1', 'c1').count, 3);
});

test('MEMORIA IA: turnos cortados por quantidade mantem user/assistant', () => {
  const ai = new AIResponder();
  const hist = [];
  for (let i = 1; i <= 60; i++) {
    hist.push({ role: 'user', content: `u${i}` });
    hist.push({ role: 'assistant', content: `a${i}` });
  }
  const turns = ai.buildHistoryTurns(hist);
  assert.strictEqual(turns.length, ai.HISTORY_MAX_MESSAGES);
  assert.strictEqual(turns[0].role, 'user');
  assert.strictEqual(turns[turns.length - 1].content, 'a60');
  assert.ok(turns[0].content.startsWith('u'));
});

test('MEMORIA IA: turnos tambem cortados por quantidade de caracteres', () => {
  const ai = new AIResponder();
  ai.HISTORY_MAX_CHARS = 50;
  const turns = ai.buildHistoryTurns([
    { role: 'user', content: 'x'.repeat(30) },
    { role: 'assistant', content: 'y'.repeat(30) },
    { role: 'user', content: 'z'.repeat(30) }
  ]);
  assert.strictEqual(turns.length, 1);
  assert.strictEqual(turns[0].content, 'z'.repeat(30));
});

test('MEMORIA IA: historico nunca comeca com uma fala da IA', () => {
  const ai = new AIResponder();
  const turns = ai.buildHistoryTurns([
    { role: 'assistant', content: 'perdida' },
    { role: 'user', content: 'ola' },
    { role: 'assistant', content: 'oi!' }
  ]);
  assert.strictEqual(turns.length, 2);
  assert.strictEqual(turns[0].role, 'user');
});

test('MEMORIA IA: bloco de memoria so entra no prompt quando ja ha historico', () => {
  const ai = new AIResponder();
  const sem = ai.getSystemPrompt({ personality: 'padrao', trainings: [], conversationInfo: { label: '10:00', count: 0 } });
  const com = ai.getSystemPrompt({ personality: 'padrao', trainings: [], conversationInfo: { label: '10:00', count: 4 } });
  assert.strictEqual(sem.includes('MEMORIA DA CONVERSA ATUAL'), false);
  assert.ok(com.includes('MEMORIA DA CONVERSA ATUAL'));
  assert.ok(com.includes('4 mensagens'));
  assert.ok(com.indexOf('MEMORIA DA CONVERSA ATUAL') < com.indexOf('FORMATO DA RESPOSTA'),
    'memoria vem antes do formato, que continua por ultimo');
});

test('MEMORIA: main.js agenda a virada 00:00 e injeta a memoria no fluxo', () => {
  const src = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.ok(src.includes('function scheduleMidnightRollover()'), 'agenda a virada de dia');
  assert.ok(src.includes('conversationStore.rollOver'), 'fecha conversas as 00:00');
  assert.ok(src.includes('initConversationStore()'), 'inicializa o store');
  assert.ok(/new AIResponder\(\);\s*\r?\n\s*initConversationStore\(\)/.test(src), 'inicializa depois de criar o AIResponder');
  assert.ok(src.includes('conversationInfo'), 'passa o contexto de memoria para o prompt');
  assert.ok(src.includes('setHistoryStore'), 'conecta o store ao AIResponder');
  assert.ok(src.includes('conversations.json'), 'grava o historico em disco');
  assert.ok(src.includes('conversationStore.flush()'), 'salva ao fechar o app');
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
