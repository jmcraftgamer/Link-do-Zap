// Indicador "digitando..." e tempo realista de digitacao.
// Depende apenas da interface do WhatsAppManager e de um emissor de eventos.
function createTypingService(deps) {
  const getWhatsapp = deps.getWhatsapp;
  const emit = typeof deps.emit === 'function' ? deps.emit : () => {};
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  function clientPage(zapId) {
    const manager = getWhatsapp && getWhatsapp();
    if (!manager || !manager.clients) return null;
    const clientData = manager.clients.get(String(zapId));
    if (!clientData || !clientData.client || !clientData.client.pupPage) return null;
    return clientData.client.pupPage;
  }

  async function send(zapId, chatId, silent = false) {
    try {
      const page = clientPage(zapId);
      if (!page) {
        if (!silent) log(zapId, 'warning', 'Indicador digitando: cliente ou pagina pupPage indisponivel');
        return false;
      }
      const success = await page.evaluate(async (id) => {
        try {
          let wid = window.require('WAWebWidFactory').createWid(id);
          if (wid.isLid && wid.isLid()) {
            try {
              const pn = window.require('WAWebApiContact').getPhoneNumber(wid);
              if (pn) wid = pn;
            } catch (_) {}
          }
          const ChatState = window.require('WAWebChatStateBridge');
          await ChatState.sendChatStateComposing(wid);
          return true;
        } catch (err) {
          return { error: err.message };
        }
      }, chatId);

      if (success === true) {
        emit('typing', { zapId: String(zapId), chatId, isTyping: true });
        if (!silent) log(zapId, 'info', 'Indicador digitando enviado no WhatsApp');
        return true;
      }
      log(zapId, 'warning', `Falha ao enviar digitando via page.evaluate: ${success && success.error ? success.error : 'desconhecido'}`);
      return false;
    } catch (e) {
      log(zapId, 'warning', `Nao foi possivel enviar digitando: ${e.message}`);
      return false;
    }
  }

  async function clear(zapId, chatId) {
    try {
      const page = clientPage(zapId);
      if (!page) return false;
      await page.evaluate(async (id) => {
        try {
          let wid = window.require('WAWebWidFactory').createWid(id);
          if (wid.isLid && wid.isLid()) {
            try {
              const pn = window.require('WAWebApiContact').getPhoneNumber(wid);
              if (pn) wid = pn;
            } catch (_) {}
          }
          const ChatState = window.require('WAWebChatStateBridge');
          await ChatState.sendChatStatePaused(wid);
        } catch (_) {}
      }, chatId).catch(() => {});
      emit('typing', { zapId: String(zapId), chatId, isTyping: false });
      return true;
    } catch (_) {
      return false;
    }
  }

  // Espera o tempo que uma pessoa levaria digitando essa mensagem.
  // Renova o indicador a cada 20s porque o WhatsApp expira "digitando" em ~25s.
  async function waitRealistic(zapId, chatId, typingStart, text) {
    const CARACTERES_POR_SEGUNDO = 10;
    const chars = String(text || '').length;
    const humanTypingMs = Math.round((chars / CARACTERES_POR_SEGUNDO) * 1000);
    const targetTypingMs = Math.min(12000, Math.max(3000, humanTypingMs));
    const typingElapsed = Date.now() - typingStart;
    const remainingMs = targetTypingMs - typingElapsed;

    log(zapId, 'info',
      `Digitacao realista: ${chars} caracteres = ~${(humanTypingMs / 1000).toFixed(1)}s de pessoa digitando; ` +
      `indicador ligado ha ${(typingElapsed / 1000).toFixed(1)}s (alvo ${(targetTypingMs / 1000).toFixed(1)}s).`);

    if (remainingMs > 0) {
      log(zapId, 'info', `Faltam ${(remainingMs / 1000).toFixed(1)}s com "digitando..." antes de enviar...`);
      const deadline = Date.now() + remainingMs;
      while (Date.now() < deadline) {
        const left = deadline - Date.now();
        await new Promise((resolve) => setTimeout(resolve, Math.min(20000, left)));
        if (Date.now() < deadline) await send(zapId, chatId, true);
      }
    }
  }

  return { send, clear, waitRealistic };
}

module.exports = { createTypingService };
