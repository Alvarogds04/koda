'use strict';
/* F025: deliberately small grammar. Message bytes only become text nodes;
   HTTP/HTTPS anchors cancel browser navigation and only call the guarded host. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoChatMarkdown = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  function safeWebUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2000 || /[\s\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  function blocks(value) {
    const lines = String(value).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let paragraph = [];
    const flush = () => { if (paragraph.length) { out.push({ kind: 'paragraph', text: paragraph.join('\n') }); paragraph = []; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]; let m;
      if (line.startsWith('```')) {
        flush(); const lang = line.slice(3).trim(); const code = [];
        while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
        out.push({ kind: 'code', lang, text: code.join('\n') });
      } else if ((m = /^(#+) (.*)$/.exec(line))) {
        flush(); out.push({ kind: 'heading', level: Math.min(m[1].length, 6), text: m[2] });
      } else if (/^(---|\*\*\*|___)$/.test(line.trim())) {
        flush(); out.push({ kind: 'rule' });
      } else if ((m = /^( *)([-*+] |\d+\.\s+)(.*)$/.exec(line))) {
        flush(); out.push({ kind: 'item', indent: Math.floor(m[1].length / 2), marker: m[2].trim(), text: m[3] });
      } else if (line === '>' || (m = /^> (.*)$/.exec(line))) {
        flush(); out.push({ kind: 'quote', text: line === '>' ? '' : m[1] });
      } else if (!line.trim()) flush();
      else paragraph.push(line);
    }
    flush(); return out;
  }

  function inline(value) {
    const text = String(value); const out = [];
    // One scanner, no lookbehind: underscore's left boundary is checked below.
    const re = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_([^_]+)_|\[([^\]]+)\]\(([^)]+)\)/g;
    let end = 0, m;
    const plain = s => {
      if (!s) return;
      const last = out[out.length - 1];
      if (last && last.kind === 'text') last.text += s;
      else out.push({ kind: 'text', text: s });
    };
    while ((m = re.exec(text))) {
      plain(text.slice(end, m.index));
      if ((m[5] && m.index > 0 && /\w/.test(text[m.index - 1])) || (m[6] && text[m.index - 1] === '!')) plain(m[0]);
      else if (m[1]) out.push({ kind: 'code', text: m[1] });
      else if (m[2] || m[3]) out.push({ kind: 'bold', text: m[2] || m[3] });
      else if (m[4] || m[5]) out.push({ kind: 'em', text: m[4] || m[5] });
      else {
        const url = safeWebUrl(m[7]);
        if (url) out.push({ kind: 'link', text: m[6], url });
        else plain(m[0]);
      }
      end = re.lastIndex;
    }
    plain(text.slice(end)); return out;
  }

  function render(container, value, options = {}) {
    const doc = options.document || container.ownerDocument;
    const element = (tag, text, className) => {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const invokeSafely = (fn, arg) => {
      try { Promise.resolve(fn && fn(arg)).catch(() => {}); } catch { /* no unhandled host/clipboard error */ }
    };
    const spans = (node, text) => {
      for (const token of inline(text)) {
        if (token.kind === 'text') node.append(doc.createTextNode(token.text));
        else if (token.kind === 'link') {
          const link = element('a', token.text, 'md-link');
          link.setAttribute('href', token.url); link.setAttribute('title', token.url);
          link.setAttribute('aria-label', `${token.text}: ${token.url} (abrir en el navegador)`);
          link.addEventListener('click', e => {
            e.preventDefault();
            if (e.isTrusted) invokeSafely(options.openUrl, token.url);
          });
          node.append(link);
        } else node.append(element({ code: 'code', bold: 'strong', em: 'em' }[token.kind], token.text));
      }
    };
    const nodes = [];
    for (const block of blocks(value)) {
      let node;
      if (block.kind === 'code') {
        node = element('div', undefined, 'md-fence');
        const header = element('div', undefined, 'md-code-header');
        header.append(element('span', block.lang, 'md-language'));
        const button = element('button', 'Copiar', 'md-copy'); button.setAttribute('type', 'button');
        button.setAttribute('aria-label', 'Copiar código');
        button.addEventListener('click', e => { if (e.isTrusted) invokeSafely(options.copyCode, block.text); });
        header.append(button); const pre = element('pre'); pre.append(element('code', block.text));
        node.append(header, pre);
      } else if (block.kind === 'rule') node = element('hr');
      else if (block.kind === 'item') {
        node = element('div', undefined, 'md-item'); node.style.paddingLeft = `${block.indent * 12}px`;
        node.append(element('span', /^\d/.test(block.marker) ? block.marker : '•', 'md-marker'));
        const body = element('span'); spans(body, block.text); node.append(body);
      } else {
        node = element(block.kind === 'heading' ? `h${block.level}` : block.kind === 'quote' ? 'blockquote' : 'p');
        spans(node, block.text);
      }
      nodes.push(node);
    }
    container.replaceChildren(...nodes);
  }
  return { blocks, inline, safeWebUrl, render };
});
