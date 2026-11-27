(() => {
  'use strict';
  const listeners = new Map();
  let ready;
  let resolveReady;
  let connected = false;
  const connection = new Promise(resolve => { resolveReady = resolve; });
  let playerOrigin = '';
  try { playerOrigin = new URL(document.referrer).origin; } catch (_) {}

  function post(message) {
    if (window.parent === window || !playerOrigin) throw new Error('WhosaidMultiplayer must run inside the Whosaid game player.');
    window.parent.postMessage({ source: 'whosaid-game-sdk', ...message }, playerOrigin);
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== playerOrigin || !event.data || event.data.source !== 'whosaid-player') return;
    const message = event.data;
    if (message.type === 'init') {
      ready = Object.freeze(message.session);
      connected = true;
      resolveReady(ready);
      emit('connected', ready);
    } else if (message.type === 'event') {
      emit(message.event.type, message.event);
      emit('event', message.event);
      if (message.event.type === 'agent-action') emit('agentAction', message.event.data);
    } else if (message.type === 'disconnected') {
      connected = false;
      emit('disconnected', {});
    }
  });

  function emit(type, value) {
    for (const listener of listeners.get(type) || []) {
      try { listener(value); } catch (error) { setTimeout(() => { throw error; }); }
    }
  }

  const api = {
    async connect() {
      if (ready) return ready;
      post({ type: 'ready' });
      return connection;
    },
    send(type, data) {
      if (!connected) throw new Error('Connect to a room before sending game events.');
      post({ type: 'send', eventType: String(type), data });
    },
    publishAgentState(state, legalActions) {
      if (!connected) throw new Error('Connect to a room before publishing AI state.');
      post({ type: 'agent-state', state, legalActions });
    },
    on(type, listener) {
      if (typeof listener !== 'function') throw new TypeError('Listener must be a function.');
      const items = listeners.get(type) || new Set();
      items.add(listener);
      listeners.set(type, items);
      return () => items.delete(listener);
    },
    get session() { return ready; },
  };

  Object.defineProperty(window, 'WhosaidMultiplayer', { value: Object.freeze(api), configurable: false, writable: false });
})();
