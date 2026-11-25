// ============================================================
// Agente de IA do Dashboard - controla o app inteiro
// ------------------------------------------------------------
// A pessoa conversa no ChatBox do Dashboard e o agente usa
// ferramentas (JSON) para gerenciar Zaps, contatos bloqueados,
// treinamentos, enviar mensagens, responder estatisticas,
// gerar codigos de pareamento e ate reiniciar a VPS.
// O agente responde com a chave da app e tambem com a API de
// qualquer Zap configurado (fallback em sequencia).
// ============================================================
const AIResponder = require('./ai-responder');

const MAX_STEPS = 8;
const MAX_HISTORY = 16;

class AppAgent {
  constructor(deps) {
    this.ai = (deps && deps.aiResponder) || new AIResponder();
    this.getProviders = deps.getProviders;
    this.resolveProviderKey = deps.resolveProviderKey;
    this.loadZaps = deps.loadZaps;
    this.saveZaps = deps.saveZaps;
    this.loadTrainings = deps.loadTrainings;
    this.saveTrainings = deps.saveTrainings;
    this.getStore = deps.getConversationStore;
    this.whatsapp = deps.whatsapp;
    this.restartServer = deps.restartServer;
    this.getServerOverview = deps.getServerOverview;
    this.runServerCommand = deps.runServerCommand;
    this.requestServerPairing = deps.requestServerPairing;
    this.getServerPairingCodes = deps.getServerPairingCodes;
    this.isServerMode = deps.isServerMode;
    this.log = deps.log || function () {};
  }

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------
  normNumber(n) {
    return String(n || '')
      .replace(/@(s\.whatsapp\.net|c\.us|g\.us|broadcast|newsletter)/gi, '')
      .replace(/[^\d+]/g, '');
  }

  findZap(ref, zaps) {
    const r = String(ref == null ? '' : ref).trim().toLowerCase();
    if (!r) return null;
    let z = zaps.find(x => String(x.id) === r);
    if (z) return z;
    z = zaps.find(x => String(x.name || '').toLowerCase() === r);
    if (z) return z;
    const digits = r.replace(/\D/g, '');
    if (digits.length >= 8) {
      z = zaps.find(x => String(x.phone || '').replace(/\D/g, '').includes(digits));
      if (z) return z;
    }
    return zaps.find(x => String(x.name || '').toLowerCase().includes(r)) || null;
  }

  zapSummary(z, store) {
    let connected = false;
    try {
      connected = !!(this.whatsapp && this.whatsapp.getStatus && this.whatsapp.getStatus(String(z.id)).status === 'ready');
    } catch (_) {}
    let blocked = Array.isArray(z.blockedContacts) ? z.blockedContacts.length : 0;
    let trainings = 0;
    try {
      const all = this.loadTrainings ? this.loadTrainings() : {};
      trainings = (all[String(z.id)] || []).length;
    } catch (_) {}
    return {
      id: z.id,
      name: z.name,
      phone: z.phone || '',
      enabled: z.enabled !== false,
      autoReply: z.autoReply !== false,
      instantReply: !!z.instantReply,
      personality: z.personality || 'padrao',
      area: z.area || '',
      connected,
      blocked,
      trainings
    };
  }

  // ----------------------------------------------------------
  // Estatisticas de hoje (conversation store)
  // ----------------------------------------------------------
  getStats() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const byZap = {};
    const store = this.getStore ? this.getStore() : null;
    if (store && Array.isArray(store.conversations)) {
      for (const c of store.conversations) {
        const zid = String(c.zapId);
        if (!byZap[zid]) byZap[zid] = { zapId: zid, received: 0, aiReplies: 0, chats: new Set() };
        for (const m of (c.messages || [])) {
          if ((m.at || 0) < start) continue;
          if (m.role === 'assistant') {
            byZap[zid].aiReplies++;
            byZap[zid].chats.add(c.chatId);
          } else if (m.role === 'user') {
            byZap[zid].received++;
          }
        }
      }
    }
    const zaps = this.loadZaps ? this.loadZaps() : [];
    const list = [];
    let totalReceived = 0;
    let totalReplies = 0;
    for (const zid of Object.keys(byZap)) {
      const v = byZap[zid];
      const zap = zaps.find(z => String(z.id) === zid);
      totalReceived += v.received;
      totalReplies += v.aiReplies;
      list.push({
        zapId: zid,
        zapName: zap ? zap.name : '(zap removido)',
        received: v.received,
        aiReplies: v.aiReplies,
        chats: v.chats.size
      });
    }
    list.sort((a, b) => b.aiReplies - a.aiReplies);
    return { day, totalReceived, totalReplies, byZap: list };
  }

  // ----------------------------------------------------------
  // Estado + prompt
  // ----------------------------------------------------------
  buildState() {
    const zaps = this.loadZaps ? this.loadZaps() : [];
    const providers = this.getProviders ? this.getProviders() : [];
    const lines = [];

    lines.push('## ZAPS (contas de WhatsApp)');
    if (!zaps.length) lines.push('(nenhum zap cadastrado)');
    for (const z of zaps) {
      const s = this.zapSummary(z);
      lines.push(`- id=${s.id} | nome="${s.name}" | telefone=${s.phone || 'n/d'} | ativo=${s.enabled ? 'sim' : 'nao'} | auto-resposta=${s.autoReply ? 'sim' : 'nao'} | resposta-instantanea=${s.instantReply ? 'sim' : 'nao'} | personalidade=${s.personality}${s.area ? ' (' + s.area + ')' : ''} | conectado=${s.connected ? 'SIM' : 'nao'} | bloqueados=${s.blocked} | treinamentos=${s.trainings}`);
    }

    lines.push('');
    lines.push('## PROVEDORES DE IA COM CHAVE (chave da propria app)');
    const withKey = [];
    for (const p of providers) {
      const resolved = this.resolveProviderKey ? this.resolveProviderKey(p) : p;
      if (resolved && resolved.apiKey) {
        withKey.push(p);
        lines.push(`- ${p.name} | modelos: ${(p.models || []).map(m => m.id).join(', ') || 'n/d'}`);
      }
    }
    if (!withKey.length) lines.push('(nenhum provedor com chave - a IA do app nao responde)');

    const stats = this.getStats();
    lines.push('');
    lines.push(`## ESTATISTICAS DE HOJE (${stats.day})`);
    lines.push(`- mensagens recebidas: ${stats.totalReceived} | respostas da IA: ${stats.totalReplies}`);
    for (const b of stats.byZap) {
      lines.push(`  - ${b.zapName}: recebidas=${b.received}, respostas IA=${b.aiReplies}, conversas atendidas=${b.chats}`);
    }

    return lines.join('\n');
  }

  buildSystemPrompt(state, mentions) {
    const mentionLines = (mentions || []).map(m =>
      `- ${m.token} -> nome: ${m.name || 'n/d'}, numero: ${m.number || 'NAO RESOLVIDO (use search_contacts)'}`);
    const mentionBlock = mentionLines.length
      ? `\n## MENCOES @ NA MENSAGEM DA PESSOA\n${mentionLines.join('\n')}\n`
      : '';

    return `Voce e o AGENTE OFICIAL do app "Assistente do Zap" (Link do WhatsApp). Voce conversa com o dono do app no ChatBox do Dashboard e CONTROLA O APP INTEIRO pelas ferramentas.

Sempre responda em PORTUGUES DO BRASIL, direto e educado. Sem emojis excessivos.

${state}
${mentionBlock}
## COMO USAR FERRAMENTAS
Quando precisar executar uma acao no app ou buscar dados, responda APENAS com um JSON puro (sem texto fora do JSON, sem markdown):
{"tool": "nome_da_ferramenta", "args": {...}}

Depois voce recebe o RESULTADO da ferramenta e ai sim responde em texto normal para a pessoa, confirmando o que foi feito.
NUNCA invente resultados: so afirme algo que veio no RESULTADO.
Se a ferramenta retornar ok:false, explique o problema e, se possivel, tente corrigir com outra ferramenta.

## FERRAMENTAS DISPONIVEIS
1. list_zaps {} - lista todos os Zaps com situacao
2. add_zap {"name": "nome", "phone": "5511999999999"} - cria um Zap novo
3. update_zap {"zap": "id ou nome", "enabled": true, "autoReply": true, "instantReply": false, "personality": "padrao|vendedor|atendente|especialista", "area": "texto", "name": "novo nome"} - altera um Zap (so envie o que mudar)
4. delete_zap {"zap": "id ou nome"} - apaga um Zap e seus treinamentos
5. block_contact {"zap": "id ou nome", "number": "5511999999999"} - bloqueia um numero nesse Zap (a IA nao responde mais a ele)
6. unblock_contact {"zap": "id ou nome", "number": "5511999999999"} - desbloqueia
7. list_blocked {"zap": "id ou nome"} - lista numeros bloqueados do Zap
8. add_training {"zap": "id ou nome", "title": "titulo", "content": "conteudo"} - cria um treinamento (conhecimento para a IA do Zap)
9. list_trainings {"zap": "id ou nome"} - lista treinamentos
10. delete_training {"zap": "id ou nome", "trainingId": "id"} - apaga um treinamento
11. send_message {"zap": "id ou nome", "number": "5511999999999", "texto": "mensagem"} - envia uma mensagem manualmente por um Zap (precisa estar conectado)
12. get_stats {"zap": "id ou nome"} - estatisticas de hoje (opcional: sem zap = todas)
13. search_contacts {"query": "nome ou numero"} - procura contatos nas conversas dos Zaps (para achar o numero antes de enviar ou bloquear)
14. server_status {} - estado geral do servidor/VPS (uptime, zaps conectados, RAM, disco, modo)
15. server_command {"comando": "status|zaps|ligar|desligar|conectar <zap>|desconectar <zap>|sincronizar|limpar|ping"} - executa um comando do painel do servidor
16. restart_server {} - reinicia a VPS (ela volta sozinha em cerca de 1 minuto)
17. pairing_code {"zap": "id ou nome"} - gera o codigo de pareamento do WhatsApp de um Zap e devolve para a pessoa digitar no celular

Regras:
- Para mandar mensagem ou bloquear, se voce so tem o NOME da pessoa (@maria), use search_contacts primeiro para achar o numero.
- "zap" pode ser o id ou o nome (parcial serve).
- Perguntas sobre o app, numeros e funcionamento: responda direto usando o estado acima; use get_stats quando precisar de contagem atual.
- Pode executar VARIAS ferramentas em sequencia se a pedir (ex: criar 3 Zaps).
- Acoes destrutivas (delete_zap, delete_training) execute apenas quando a pessoa pedir claramente.
- restart_server execute SOMENTE quando a pessoa pedir claramente para reiniciar a VPS/servidor. Confirme antes com uma pergunta se houver duvida.
- Para conectar um Zap desconectado, use pairing_code e entregue o codigo para a pessoa com as instrucoes.
- Se a pessoa mandar uma imagem, descreva/analise a imagem com o texto dela.`;
  }

  // ----------------------------------------------------------
  // Parse da resposta da IA -> ferramenta
  // ----------------------------------------------------------
  parseTool(raw) {
    let t = String(raw || '').trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        const obj = JSON.parse(t.slice(start, end + 1));
        if (obj && typeof obj.tool === 'string') {
          return { tool: obj.tool, args: (obj.args && typeof obj.args === 'object') ? obj.args : {} };
        }
      } catch (_) {}
    }
    // Fallback: achar "tool" e "args" mesmo com lixo em volta
    const tm = t.match(/"tool"\s*:\s*"([^"]+)"/);
    if (tm) {
      const am = t.match(/"args"\s*:\s*(\{[\s\S]*?\})\s*(?:,|\}|$)/);
      let args = {};
      if (am) {
        try { args = JSON.parse(am[1]); } catch (_) {}
      }
      return { tool: tm[1], args };
    }
    return null;
  }

  // ----------------------------------------------------------
  // Ferramentas
  // ----------------------------------------------------------
  async execute(name, args) {
    const fn = this._tools[String(name || '').toLowerCase()];
    if (!fn) {
      return { ok: false, error: `Ferramenta desconhecida: ${name}. Disponiveis: ${Object.keys(this._tools).join(', ')}` };
    }
    try {
      return await fn.call(this, args || {});
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  get _tools() {
    return {
      list_zaps: async () => {
        const zaps = this.loadZaps();
        return { ok: true, zaps: zaps.map(z => this.zapSummary(z)) };
      },

      add_zap: async (a) => {
        const name = String(a.name || '').trim();
        const phone = this.normNumber(a.phone);
        if (!name) return { ok: false, error: 'Informe o nome do Zap (name).' };
        if (phone.replace(/\D/g, '').length < 10) return { ok: false, error: 'Telefone invalido (use DDD + numero, ex: 5511999999999).' };
        const zaps = this.loadZaps();
        if (zaps.some(z => String(z.phone || '').replace(/\D/g, '') === phone.replace(/\D/g, ''))) {
          return { ok: false, error: `Ja existe um Zap com o telefone ${phone}.` };
        }
        const providers = (this.getProviders() || [])
          .filter(p => { const r = this.resolveProviderKey ? this.resolveProviderKey(p) : p; return r && r.apiKey; })
          .map(p => p.id);
        const now = Date.now();
        const newZap = {
          id: now,
          name,
          phone,
          personality: 'padrao',
          area: '',
          providers,
          model: 'auto',
          autoReply: true,
          enabled: true,
          blockedContacts: [],
          runtimeStatus: 'disconnected',
          status: 'Desconectado',
          statusClass: 'offline',
          createdAt: new Date().toLocaleDateString('pt-BR') + ' as ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        };
        zaps.unshift(newZap);
        this.saveZaps(zaps);
        return { ok: true, zap: { id: newZap.id, name: newZap.name, phone: newZap.phone }, aviso: 'Zap criado. Ele nasce DESCONECTADO - a pessoa precisa conectar pelo botao Conectar.' };
      },

      update_zap: async (a) => {
        const zaps = this.loadZaps();
        const z = this.findZap(a.zap, zaps);
        if (!z) return { ok: false, error: `Zap nao encontrado: ${a.zap}` };
        const changed = [];
        if (a.name !== undefined) { z.name = String(a.name).trim() || z.name; changed.push('nome'); }
        if (a.enabled !== undefined) { z.enabled = !!a.enabled; changed.push('ativo=' + z.enabled); }
        if (a.autoReply !== undefined) { z.autoReply = !!a.autoReply; changed.push('auto-resposta=' + z.autoReply); }
        if (a.instantReply !== undefined) { z.instantReply = !!a.instantReply; changed.push('resposta-instantanea=' + z.instantReply); }
        if (a.personality !== undefined) {
          const p = String(a.personality).toLowerCase();
          if (!['padrao', 'vendedor', 'atendente', 'especialista'].includes(p)) {
            return { ok: false, error: `Personalidade invalida: ${a.personality}. Use: padrao, vendedor, atendente ou especialista.` };
          }
          z.personality = p;
          changed.push('personalidade=' + p);
        }
        if (a.area !== undefined) { z.area = String(a.area); changed.push('area'); }
        if (!changed.length) return { ok: false, error: 'Nenhum campo para alterar. Envie enabled, autoReply, instantReply, personality, area ou name.' };
        this.saveZaps(zaps);
        return { ok: true, zap: { id: z.id, name: z.name }, alterado: changed.join(', ') };
      },

      delete_zap: async (a) => {
        const zaps = this.loadZaps();
        const z = this.findZap(a.zap, zaps);
        if (!z) return { ok: false, error: `Zap nao encontrado: ${a.zap}` };
        const idx = zaps.indexOf(z);
        zaps.splice(idx, 1);
        this.saveZaps(zaps);
        try {
          if (this.whatsapp && this.whatsapp.disconnectZap) {
            await this.whatsapp.disconnectZap(String(z.id), 'zap excluido');
          }
        } catch (_) {}
        const trainings = this.loadTrainings();
        const hadTrainings = (trainings[String(z.id)] || []).length;
        if (trainings[String(z.id)]) {
          delete trainings[String(z.id)];
          this.saveTrainings(trainings);
        }
        try {
          const store = this.getStore ? this.getStore() : null;
          if (store && store.clearForZap) store.clearForZap(String(z.id));
        } catch (_) {}
        return { ok: true, apagado: { id: z.id, name: z.name }, treinamentosRemovidos: hadTrainings };
      },

      block_contact: async (a) => {
        const zaps = this.loadZaps();
        const z = this.findZap(a.zap, zaps);
        if (!z) return { ok: false, error: `Zap nao encontrado: ${a.zap}` };
        const num = this.normNumber(a.number).replace(/\D/g, '');
        if (num.length < 10) return { ok: false, error: `Numero invalido: ${a.number}` };
        if (!Array.isArray(z.blockedContacts)) z.blockedContacts = [];
        const already = z.blockedContacts.some(b => this.normNumber(b).replace(/\D/g, '') === num);
        if (!already) {
          z.blockedContacts.push(num);
          this.saveZaps(zaps);
        }
        return { ok: true, zap: z.name, bloqueado: num, totalBloqueados: z.blockedContacts.length, jaEstava: already };
      },

      unblock_contact: async (a) => {
        const zaps = this.loadZaps();
        const z = this.findZap(a.zap, zaps);
        if (!z) return { ok: false, error: `Zap nao encontrado: ${a.zap}` };
        const num = this.normNumber(a.number).replace(/\D/g, '');
        if (!Array.isArray(z.blockedContacts) || !z.blockedContacts.length) {
          return { ok: false, error: `O Zap ${z.name} nao tem contatos bloqueados.` };
        }
        const before = z.blockedContacts.length;
        z.blockedContacts = z.blockedContacts.filter(b => this.normNumber(b).replace(/\D/g, '') !== num);
        if (z.blockedContacts.length === before) {
          return { ok: false, error: `Numero ${num} nao esta bloqueado no Zap ${z.name}.` };
        }
        this.saveZaps(zaps);
        return { ok: true, zap: z.name, desbloqueado: num, totalBloqueados: z.blockedContacts.length };
      },

      list_blocked: async (a) => {
        const zaps = this.loadZaps();
        const z = this.findZap(a.zap, zaps);
        if (!z) return { ok: false, error: `Zap nao encontrado: ${a.zap}` };
        return { ok: true, zap: z.name, bloqueados: Array.isArray(z.blockedContacts) ? z.blockedContacts : [] };
      },

      block_all_existing: async (a) => {
        const zaps = this.loadZaps();
        const z = this.findZap(a.zap, zaps);
        if (!z) return { ok: false, error: `Zap nao encontrado: ${a.zap}` };
        if (!Array.isArray(z.blockedContacts)) z.blockedContacts = [];
        let added = 0;
        const fs = require('fs');
        const path = require('path');
        // Mesma pasta de dados do backend (LINK_DATA_DIR na VPS) e do modo local.
        const { createPaths } = require('../core/paths');
        const dataDir = createPaths({
          getApp: () => {
            try { return require('electron').app; } catch (_) { return null; }
          }
        }).getDataDir();
        const memoDir = path.join(dataDir, 'memorias', String(z.id));
        const blockedSet = new Set(z.blockedContacts.map(b => String(b).replace(/\D/g, '').replace(/^55/, '')));
        try {
          if (fs.existsSync(memoDir)) {
            for (const file of fs.readdirSync(memoDir)) {
              try {
                const content = fs.readFileSync(path.join(memoDir, file), 'utf8');
                const nums = content.match(/\b(\+?\d{10,14})\b/g) || [];
                for (const n of nums) {
                  const clean = n.replace(/\D/g, '');
                  if (clean.length >= 10) blockedSet.add(clean);
                }
              } catch (_) {}
            }
          }
        } catch (_) {}
        try {
          const convFile = path.join(dataDir, 'conversations.json');
          if (fs.existsSync(convFile)) {
            const data = JSON.parse(fs.readFileSync(convFile, 'utf8'));
            if (Array.isArray(data)) {
              for (const item of data) {
                if (item && item.zapId === String(z.id) && item.contact && item.contact.id) {
                  const clean = String(item.contact.id).replace(/\D/g, '').replace(/^55/, '');
                  if (clean.length >= 10) blockedSet.add(clean);
                }
              }
            }
          }
        } catch (_) {}
        for (const num of blockedSet) {
          if (!z.blockedContacts.some(b => String(b).replace(/\D/g, '').replace(/^55/, '') === num)) {
            z.blockedContacts.push(num);
            added++;
          }
        }
        this.saveZaps(zaps);
        return { ok: true, zap: z.name, adicionados: added, totalBloqueados: z.blockedContacts.length };
      },

      add_training: async (a) => {
        const zaps = this.loadZaps();
        const z = this.findZap(a.zap, zaps);
        if (!z) return { ok: false, error: `Zap nao encontrado: ${a.zap}` };
        const title = String(a.title || '').trim();
        const content = String(a.content || '').trim();
        if (!title) return { ok: false, error: 'Informe o titulo do treinamento (title).' };
        if (!content) return { ok: false, error: 'Informe o conteudo do treinamento (content).' };
        const all = this.loadTrainings();
        const key = String(z.id);
        if (!all[key]) all[key] = [];
        const now = Date.now();
        const training = {
          id: 'tr_' + now + '_' + Math.random().toString(36).slice(2, 8),
          title,
          content,
          images: [],
          links: [],
          enabled: true,
          createdAt: now,
          updatedAt: now
        };
        all[key].push(training);
        this.saveTrainings(all);
        return { ok: true, zap: z.name, treinamento: { id: training.id, title: training.title }, total: all[key].length };
      },

      list_trainings: async (a) => {
        const zaps = this.loadZaps();
        const z = this.findZap(a.zap, zaps);
        if (!z) return { ok: false, error: `Zap nao encontrado: ${a.zap}` };
        const all = this.loadTrainings();
        const list = (all[String(z.id)] || []).map(t => ({
          id: t.id,
          title: t.title,
          enabled: t.enabled !== false,
          preview: String(t.content || '').substring(0, 80)
        }));
        return { ok: true, zap: z.name, treinamentos: list };
      },

      delete_training: async (a) => {
        const zaps = this.loadZaps();
        const z = this.findZap(a.zap, zaps);
        if (!z) return { ok: false, error: `Zap nao encontrado: ${a.zap}` };
        const all = this.loadTrainings();
        const key = String(z.id);
        const list = all[key] || [];
        const idx = list.findIndex(t => String(t.id) === String(a.trainingId));
        if (idx === -1) return { ok: false, error: `Treinamento ${a.trainingId} nao encontrado no Zap ${z.name}.` };
        const [removed] = list.splice(idx, 1);
        this.saveTrainings(all);
        return { ok: true, zap: z.name, apagado: { id: removed.id, title: removed.title }, restantes: list.length };
      },

      send_message: async (a) => {
        const zaps = this.loadZaps();
        const z = this.findZap(a.zap, zaps);
        if (!z) return { ok: false, error: `Zap nao encontrado: ${a.zap}` };
        if (!this.whatsapp || !this.whatsapp.getStatus) return { ok: false, error: 'WhatsApp indisponivel.' };
        const status = this.whatsapp.getStatus(String(z.id));
        if (!status || status.status !== 'ready') {
          return { ok: false, error: `O Zap ${z.name} nao esta conectado. Conecte-o antes de enviar mensagens.` };
        }
        const num = this.normNumber(a.number);
        const texto = String(a.texto !== undefined ? a.texto : (a.text || '')).trim();
        if (!num) return { ok: false, error: 'Informe o numero de destino (number).' };
        if (!texto) return { ok: false, error: 'Informe o texto da mensagem (texto).' };
        await this.whatsapp.sendMessage(String(z.id), num, texto);
        return { ok: true, zap: z.name, enviadoPara: num, texto };
      },

      get_stats: async (a) => {
        const stats = this.getStats();
        let byZap = stats.byZap;
        if (a && a.zap) {
          const zaps = this.loadZaps();
          const z = this.findZap(a.zap, zaps);
          if (!z) return { ok: false, error: `Zap nao encontrado: ${a.zap}` };
          byZap = byZap.filter(b => String(b.zapId) === String(z.id));
        }
        return { ok: true, dia: stats.day, recebidas: stats.totalReceived, respostasIA: stats.totalReplies, porZap: byZap };
      },

      search_contacts: async (a) => {
        const query = String(a.query || '').trim().toLowerCase();
        const qDigits = query.replace(/\D/g, '');
        if (!query) return { ok: false, error: 'Informe o que procurar (query).' };
        if (!this.whatsapp || !this.whatsapp.getConversations) return { ok: false, error: 'WhatsApp indisponivel.' };
        const zaps = this.loadZaps();
        const hits = [];
        for (const z of zaps) {
          let convs = [];
          try { convs = this.whatsapp.getConversations(String(z.id)) || []; } catch (_) { continue; }
          for (const c of convs) {
            const contact = c.contact || {};
            const name = String(contact.name || contact.pushname || contact.shortName || '');
            const number = this.normNumber(contact.number || contact.id || '');
            const digits = number.replace(/\D/g, '');
            const match = (name && name.toLowerCase().includes(query)) ||
              (qDigits.length >= 4 && digits.includes(qDigits));
            if (match) {
              hits.push({ name: name || number, number: digits || number, zapId: z.id, zapName: z.name, chatId: c.chatId });
              if (hits.length >= 10) break;
            }
          }
          if (hits.length >= 10) break;
        }
        return { ok: true, resultados: hits, nota: hits.length ? undefined : 'Nenhum contato encontrado.' };
      },

      server_status: async () => {
        if (!this.getServerOverview) return { ok: false, error: 'Painel do servidor indisponivel neste ambiente.' };
        const ov = await this.getServerOverview();
        if (!ov) return { ok: false, error: 'Sem informacoes do servidor agora.' };
        return { ok: true, servidor: ov };
      },

      server_command: async (a) => {
        if (!this.runServerCommand) return { ok: false, error: 'Terminal do servidor indisponivel neste ambiente.' };
        const cmd = String(a.comando || a.command || '').trim().toLowerCase();
        if (!cmd) return { ok: false, error: 'Informe o comando (comando).' };
        const root = cmd.split(/\s+/)[0];
        const allowed = ['status', 'zaps', 'listar', 'ligar', 'desligar', 'conectar', 'desconectar', 'sincronizar', 'limpar', 'ping', 'ajuda', 'help'];
        if (!allowed.includes(root)) {
          return { ok: false, error: `Comando nao permitido: "${root}". Permitidos: ${allowed.join(', ')}` };
        }
        const out = await this.runServerCommand(cmd);
        const saida = String((out && (out.saida || out.error)) || '').slice(0, 1200) || 'Comando executado. Veja o terminal do painel do servidor.';
        return { ok: !(out && out.ok === false), comando: cmd, saida };
      },

      restart_server: async () => {
        if (!this.restartServer) return { ok: false, error: 'Reinicio do servidor indisponivel neste ambiente.' };
        const out = await this.restartServer();
        if (out && out.ok === false) return { ok: false, error: out.error || 'Nao foi possivel reiniciar.' };
        return { ok: true, aviso: 'Reinicio iniciado. A VPS volta sozinha em cerca de 1 minuto.' };
      },

      pairing_code: async (a) => {
        if (!this.requestServerPairing) return { ok: false, error: 'Geracao de codigo de pareamento indisponivel neste ambiente.' };
        const zaps = this.loadZaps();
        const z = this.findZap(a.zap, zaps);
        if (!z) return { ok: false, error: `Zap nao encontrado: ${a.zap}` };
        const phone = this.normNumber(z.phone);
        if (phone.replace(/\D/g, '').length < 10) {
          return { ok: false, error: `O Zap ${z.name} nao tem telefone valido. Cadastre o telefone do Zap primeiro.` };
        }
        try {
          const req = await this.requestServerPairing(String(z.id), phone);
          if (req && req.ok === false) return { ok: false, error: req.error || 'Falha ao pedir o codigo.' };
        } catch (e) {
          return { ok: false, error: 'Nao consegui pedir o codigo: ' + (e && e.message ? e.message : e) };
        }
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          try {
            if (this.getServerPairingCodes) {
              const codes = await this.getServerPairingCodes();
              const entry = (codes && codes.codes) || codes || {};
              const mine = entry[String(z.id)];
              if (mine && (mine.code || mine.status === 'done' || mine.status === 'erro')) {
                return {
                  ok: !!mine.code,
                  zap: z.name,
                  codigo: mine.code,
                  status: mine.status,
                  dica: 'No celular do Zap: WhatsApp > Aparelhos conectados > Conectar aparelho > digite o codigo.'
                };
              }
            }
            if (this.whatsapp && this.whatsapp.getStatus) {
              const st = this.whatsapp.getStatus(String(z.id));
              if (st && st.pairingCode) {
                return {
                  ok: true,
                  zap: z.name,
                  codigo: st.pairingCode,
                  status: st.status,
                  dica: 'No celular do Zap: WhatsApp > Aparelhos conectados > Conectar aparelho > digite o codigo.'
                };
              }
            }
          } catch (_) {}
          await new Promise(r => setTimeout(r, 2500));
        }
        return { ok: false, error: `O codigo do Zap ${z.name} ainda nao foi gerado (aguardei 30s). Tente de novo em instantes.` };
      }
    };
  }

  // ----------------------------------------------------------
  // Chamada ao modelo (chaves do app + APIs de TODOS os Zaps)
  // ----------------------------------------------------------
  async callModels(messages) {
    const providersData = (this.getProviders && this.getProviders()) || [];
    const tryList = [];
    const seen = new Set();
    const pushEntry = (provider, model) => {
      if (!provider || !provider.apiKey || !model) return;
      const key = `${provider.name}|${provider.baseUrl || ''}|${model.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      tryList.push({ provider, model });
    };

    for (const p of providersData) {
      const resolved = this.resolveProviderKey ? this.resolveProviderKey(p) : p;
      if (!resolved || !resolved.apiKey) continue;
      for (const m of (resolved.models || [])) pushEntry(resolved, m);
    }

    // Qualquer API de qualquer Zap entra na lista de tentativas
    try {
      const zaps = this.loadZaps ? this.loadZaps() : [];
      for (const z of zaps) {
        const list = this.ai.getModelsToTry ? this.ai.getModelsToTry(z, providersData) : [];
        for (const e of (list || [])) pushEntry(e.provider, e.model);
      }
    } catch (_) {}

    if (!tryList.length) {
      throw new Error('Nenhum provedor de IA com chave configurada. Configure em Provedores.');
    }
    let lastErr = null;
    for (const entry of tryList) {
      try {
        const text = await this.ai.callAI(entry.provider, entry.model, messages);
        if (text && String(text).trim()) return String(text);
        lastErr = new Error('resposta vazia');
      } catch (e) {
        lastErr = e;
        this.log('warn', `Agente: falha em ${entry.provider.name}/${entry.model.id}: ${e.message}`);
      }
    }
    throw new Error('A IA nao respondeu agora. Ultimo erro: ' + (lastErr ? lastErr.message : 'desconhecido'));
  }

  // ----------------------------------------------------------
  // Loop principal
  // ----------------------------------------------------------
  async run(payload) {
    const message = String((payload && payload.message) || '').trim();
    const images = Array.isArray(payload && payload.images)
      ? payload.images.filter(im => im && im.dataUrl).slice(0, 4)
      : [];
    if (!message && !images.length) return { reply: 'Escreva uma mensagem para eu ajudar.', steps: [] };

    const mentions = Array.isArray(payload.mentions) ? payload.mentions.slice(0, 30) : [];
    const state = this.buildState();
    const sys = this.buildSystemPrompt(state, mentions);

    const msgs = [{ role: 'system', content: sys }];
    const history = Array.isArray(payload.history) ? payload.history.slice(-MAX_HISTORY) : [];
    for (const h of history) {
      if (!h) continue;
      const role = h.role === 'assistant' ? 'assistant' : 'user';
      const content = String(h.content || '').trim();
      if (content) msgs.push({ role, content });
    }
    if (images.length) {
      const content = [];
      if (message) content.push({ type: 'text', text: message });
      for (const im of images) {
        content.push({ type: 'image_url', image_url: { url: im.dataUrl } });
      }
      msgs.push({ role: 'user', content });
    } else {
      msgs.push({ role: 'user', content: message });
    }

    const steps = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      const text = await this.callModels(msgs);
      const tool = this.parseTool(text);
      if (!tool) {
        return { reply: String(text).trim(), steps };
      }

      const result = await this.execute(tool.tool, tool.args);
      let info = '';
      try {
        info = JSON.stringify(result).substring(0, 140);
      } catch (_) {}
      steps.push({ tool: tool.tool, ok: !!(result && result.ok), info });

      msgs.push({ role: 'assistant', content: text });
      msgs.push({ role: 'user', content: `RESULTADO da ferramenta "${tool.tool}":\n${JSON.stringify(result)}` });
      this.log(result && result.ok ? 'info' : 'error', `Agente: ${tool.tool} -> ${result && result.ok ? 'ok' : 'falha'} (${info})`);
    }

    return {
      reply: 'Fiz varias acoes em sequencia e parei aqui para nao entrar em loop. Me diga o que fazer em seguida.',
      steps
    };
  }
}

module.exports = AppAgent;
