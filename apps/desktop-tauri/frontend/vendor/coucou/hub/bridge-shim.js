// Abito-owned event-only adapter. No invoke commands.
async function onEvent(name, handler) {
  const listen = globalThis.window?.__TAURI__?.event?.listen;
  if (!listen) return () => {
  };
  try {
    return await listen(name, (event) => handler(event.payload));
  } catch {
    return () => {
    };
  }
}
export {
  onEvent
};
