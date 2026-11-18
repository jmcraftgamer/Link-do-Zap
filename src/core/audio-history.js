'use strict';

// O audio chega do WhatsApp como base64 dentro de messageData.audio.
// O pipeline da IA precisa desse base64 apenas enquanto transcreve; depois
// disso ele e peso morto: a interface usa `hasMedia` e baixa a midia sob
// demanda (o app.js nao le `.audio` em lugar nenhum).
//
// Guardar o base64 no historico da conversa mantinha ~1,9 GB de RAM em
// regime com 30 Zaps (30 x 20 chats x 200 mensagens x ~20% de audio).
// Estas funcoes removem o campo pesado e preservam so o que a UI usa.

function sanitizeAudio(audio) {
  if (!audio || typeof audio !== 'object') return null;
  return {
    mimetype: audio.mimetype || '',
    size: Number(audio.size) || 0
  };
}

// Devolve o MESMO objeto quando ja esta limpo. Isso mantem getMessages()
// barato: com 200 mensagens por conversa nao faz sentido copiar tudo a cada
// abertura de chat.
function sanitizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  if (!msg.audio || !msg.audio.data) return msg;
  return { ...msg, audio: sanitizeAudio(msg.audio) };
}

function sanitizeMessages(list) {
  if (!Array.isArray(list)) return [];
  return list.map(sanitizeMessage);
}

module.exports = { sanitizeAudio, sanitizeMessage, sanitizeMessages };
