// Barramento de eventos simples: substitui `webContents.send` no backend e
// permite que o Setup local faca o mesmo papel via IPC sem duplicar logica.
function createEventBus() {
  const listeners = new Map();

  function on(event, handler) {
    if (typeof handler !== 'function') return () => {};
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => off(event, handler);
  }

  function once(event, handler) {
    const unsubscribe = on(event, (payload) => {
      unsubscribe();
      handler(payload);
    });
    return unsubscribe;
  }

  function off(event, handler) {
    const set = listeners.get(event);
    if (!set) return;
    if (handler) set.delete(handler);
    else set.clear();
    if (set.size === 0) listeners.delete(event);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (set) {
      for (const handler of [...set]) {
        try { handler(payload); } catch (e) { /* um listener ruim nao derruba os outros */ }
      }
    }
    const all = listeners.get('*');
    if (all) {
      for (const handler of [...all]) {
        try { handler(event, payload); } catch (_) {}
      }
    }
  }

  function listenerCount(event) {
    return (listeners.get(event) || new Set()).size;
  }

  return { on, once, off, emit, listenerCount };
}

module.exports = { createEventBus };
