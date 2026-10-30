// Adapted from Coucou src/settings/main.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Notch sections keep the original settings DOM; Flow uses hub/ui cards instead.
import { h } from '../views/dom.js';
export const notchSection = (title: string, ...children: HTMLElement[]) =>
  h('section', {}, h('h2', {}, h('span', { text: title })), ...children);
// A section whose explanation sits in an ⓘ next to its title (0.2.1 S7).
export const notchTipSection = (title: string, tip: string, ...children: HTMLElement[]) =>
  h('section', {}, h('h2', {}, h('span', { text: title }), infoTip(tip, `Más información: ${title}`)), ...children);
export const notchRow = (title: string, ...controls: HTMLElement[]) =>
  h('div', { class: 'row' }, h('label', { text: title }), ...controls);
// Same row with its explanation folded into an ⓘ next to the label (0.2.1 S7).
export const notchTipRow = (title: string, tip: string | null, ...controls: HTMLElement[]) =>
  h('div', { class: 'row' }, h('label', { text: title }), ...(tip ? [infoTip(tip, `Más información: ${title}`)] : []), ...controls);
export const notchHint = (text: string) => h('div', { class: 'hint', text });
// #503 S18+: the chosen Ajustes design groups controls by task into titled cards (a `section` styled as a card).
export const notchCard = (title: string, ...children: HTMLElement[]) =>
  h('section', { class: 'abito-card', 'aria-label': title }, h('h2', {}, h('span', { text: title })), ...children);

// 0.2.1 Ajustes (S7, L1): explanations live in an ⓘ, not in standing copy. The tip shows on hover AND on keyboard focus, hides when the
// pointer leaves or the focus moves away (CSS `:hover` / `:focus-within`), and Escape dismisses it while focused. The button is described
// by the tip (aria-describedby), so assistive tech reads it without anyone hovering.
let tipSeq = 0;
export const infoTip = (text: string, label = 'Más información'): HTMLElement => {
  const id = `hub-tip-${++tipSeq}`;
  const tip = h('span', { class: 'hub-tip', id, role: 'tooltip', text });
  const button = h('button', { class: 'hub-info', type: 'button', 'aria-label': label, 'aria-describedby': id, text: 'ⓘ' });
  const wrap = h('span', { class: 'hub-info-wrap' }, button, tip);
  button.addEventListener('keydown', (e: Event) => {
    if ((e as KeyboardEvent).key !== 'Escape') return;
    wrap.classList.toggle('dismissed', true);
    e.stopPropagation();
  });
  const rearm = () => wrap.classList.toggle('dismissed', false);
  button.addEventListener('blur', rearm);
  wrap.addEventListener('mouseleave', rearm);
  return wrap;
};
/** A label followed by its ⓘ: the short visible name plus the explanation that used to be standing copy. */
export const withTip = (title: string, tip: string | null): HTMLElement =>
  h('span', { class: 'hub-titled' }, h('span', { class: 'hub-titled-text', text: title }), ...(tip ? [infoTip(tip, `Más información: ${title}`)] : []));
