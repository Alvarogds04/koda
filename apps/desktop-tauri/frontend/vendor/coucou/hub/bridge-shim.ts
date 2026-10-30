// Abito-owned event-only adapter. No invoke commands.
export async function onEvent<T>(name: string, handler: (payload: T) => void): Promise<() => void> {
  const listen = (globalThis as any).window?.__TAURI__?.event?.listen;
  if (!listen) return () => {};
  try { return await listen(name, (event: { payload: T }) => handler(event.payload)); }
  catch { return () => {}; }
}
