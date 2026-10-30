'use strict';
// Explicit test-only preview; not packaged, no native facade/config/data access.
(() => {
  AbitoClay.setManual(true);
  const clay = AbitoClay.create(document.getElementById('character'), { live: false, seed: 505 });
  const picker = document.getElementById('state');
  for (const state of [...AbitoClay.ORDER, 'thinking']) {
    const option = document.createElement('option'); option.value = state; option.textContent = state; picker.appendChild(option);
  }
  const print = () => { document.getElementById('sample').textContent = JSON.stringify(clay.sample()); };
  const set = () => { clay.setState(picker.value === 'thinking' ? 'think' : picker.value); print(); };
  const emote = document.getElementById('emote');
  for (const name of AbitoClay.EMOTES) { const o = document.createElement('option'); o.value = name; o.textContent = name; emote.appendChild(o); }
  emote.addEventListener('change', () => { if (emote.value) clay.triggerEmote(emote.value); print(); });
  picker.addEventListener('change', set);
  document.getElementById('step').addEventListener('click', () => { clay.step(16); print(); });
  document.getElementById('still').addEventListener('click', () => { clay.staticPose(); print(); });
  print();
})();
