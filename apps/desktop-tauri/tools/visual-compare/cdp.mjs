// Minimal Chrome DevTools Protocol client over the shared headless Chromium
// (chrome-devtools-shared.service, 127.0.0.1:9222). Node >= 22 (global WebSocket).
// It only opens its own targets (pages) and closes them; it never launches or stops a browser.

export async function connect(port = 9222) {
  const meta = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(meta.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')); });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || '')})`)) : res(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, { res, rej });
    ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
  });

  async function openPage({ width, height, colorScheme = 'dark' }) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => send(m, p, sessionId);
    const logs = [];
    listeners.push((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled') logs.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      if (msg.method === 'Runtime.exceptionThrown') logs.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
    });
    await call('Page.enable'); await call('Runtime.enable');
    // The browser is shared and long-lived: never reuse JS/CSS from an earlier run (stale results).
    await call('Network.enable'); await call('Network.setCacheDisabled', { cacheDisabled: true });
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
    return {
      logs,
      addInitScript: (source) => call('Page.addScriptToEvaluateOnNewDocument', { source }),
      goto: async (url) => { await call('Page.navigate', { url }); await new Promise((r) => setTimeout(r, 400)); },
      eval: async (expression) => {
        const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      // Trusted click (the apps ignore synthetic events): real input through CDP.
      click: async (selector) => {
        const r = await call('Runtime.evaluate', { expression: `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`, returnByValue: true });
        const p = r.result.value; if (!p) throw new Error('click target not found: ' + selector);
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      },
      screenshot: async () => Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
      close: () => send('Target.closeTarget', { targetId }),
    };
  }
  return { openPage, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
