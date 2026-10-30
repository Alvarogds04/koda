'use strict';
/* #371 (OD002/OD024/GD031) — the DOM builder for the chat transcript's
   tool-call receipts and approval-decision cards. Loaded by the island page
   as a classic script (window.AbitoChatCards) and by
   test-node/transcript-cards-check.cjs through `module.exports`.
   - Text nodes only: every string goes through textContent; icons come from
     the closed registry already parsed by chat.js's iconNode (passed in).
     Never a markup-assignment path, never markup from data.
   - The row li carries the machine state in `dataset.state` /
     `dataset.decision` (CSS reads it to colour the status icon) and the full
     one-line sentence in its aria-label, so the whole card is announced as
     text. The cards carry no interactive control: nothing to decide inside
     the transcript (decisions happen on the #338 island card), so there is
     nothing to operate by keyboard and nothing can trap focus. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoChatCards = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  // `doc` is the optional document handle (tests inject a stub); the island
  // page omits it and gets the real one.
  function render(li, row, iconNode, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!li || !row || typeof row !== 'object' || !d) return;
    const approval = row.kind === 'approval';
    const card = d.createElement('div');
    card.className = 'chat-card';
    const head = d.createElement('div');
    head.className = 'chat-card-head';
    const ico = d.createElement('span');
    ico.className = 'ico';
    const node = typeof iconNode === 'function' ? iconNode(row.icon) : null;
    if (node) ico.append(node); // the icon is optional decoration, never a name
    const name = d.createElement('span');
    name.className = 'chat-card-name';
    name.textContent = approval ? row.operation : row.name; // already bounded text
    const word = d.createElement('span');
    word.className = 'chat-card-state';
    word.textContent = row.short;
    head.append(ico, name, word);
    card.append(head);
    if (typeof row.summary === 'string' && row.summary) {
      const summary = d.createElement('div');
      summary.className = 'chat-card-summary';
      summary.textContent = row.summary;
      card.append(summary);
    }
    if (approval) li.dataset.decision = row.decision;
    else li.dataset.state = row.state;
    li.setAttribute('aria-label', row.text);
    li.append(card);
  }
  return { render };
});
