'use strict';
// Real-layout playwright regression: runner must allow Chromium's virtual address reservation.
const assert = require('node:assert/strict');
const { open } = require('./island-geometry-harness.cjs');
(async () => {
  const h = await open({ chat: true, quick: true });
  if (!h) { console.log('SKIP R23: Playwright unavailable'); return; }
  try {
    for (const [i, agent] of ['codex', 'claude-code', 'pi', 'codex', 'claude-code', 'pi'].entries()) {
      await h.page.evaluate(() => {
        window.__emit('question:state', { available: true, pending: null });
        window.__islandSetView('chat', 720, 240);
        document.getElementById('chat-input').value = 'draft: no enviar';
        document.getElementById('conversations').hidden = false;
        document.getElementById('settings').dataset.open = 'true';
        document.getElementById('capsule').dataset.settings = 'open';
      });
      await h.page.waitForTimeout(400);
      // Before the asynchronous leave-chat settles, CSS and inert must already admit the card.
      const immediate = await h.page.evaluate(({ i, agent }) => {
        window.__emit('question:state', { available: true, native_transition: 'idle', pending: {
          id: `0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6${i}`, kind: i < 3 ? 'approval' : 'question', agent,
          text: '¿Permitir?', options: [{ index: 0, label: 'Sí' }, { index: 1, label: 'No' }],
          expires_at: Date.now() + 60000,
        } });
        const q = document.getElementById('question');
        return { visible: getComputedStyle(q).visibility, inert: q.inert };
      }, { i, agent });
      assert.equal(immediate.visible, 'visible', `${agent}: visible even before chat settles`);
      assert.equal(immediate.inert, false);
      await h.page.waitForTimeout(900);
      const height = await h.page.evaluate(() => window.__grantedWindowHeight || 340);
      await h.page.setViewportSize({ width: 752, height });
      const state = await h.page.evaluate(() => ({
        view: document.getElementById('capsule').dataset.view,
        draft: document.getElementById('chat-input').value,
        back: window.__chatCalls?.at(-1),
      }));
      assert.equal(state.view, 'overview');
      assert.equal(state.back, 'back');
      assert.equal(state.draft, 'draft: no enviar');
      const hits = await h.hit('#question-options button, #question-approval-actions button');
      assert.ok(hits.length >= 2, 'question has answer buttons');
      assert.ok(hits.every(x => x.ok), JSON.stringify(hits));
    }
    console.log('PASS R23: 3 agents × question/approval; immediate visibility/actionability, chat back, panel hit-tests, draft preserved');
  } finally { await h.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
