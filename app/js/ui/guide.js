// Guide: Settings › Guide, and the tap-to-explain popups on Now Playing's numbers.
import { registerScreen, go } from './app.js';
import { html, icon, openSheet, $ } from './dom.js';
import { GUIDE, TOPIC } from '../guide-content.js';

const para = (p) => (p.startsWith('• ') ? html`<li>${p.slice(2)}</li>` : html`<p>${p}</p>`);
/** Paragraphs, with runs of "• " lines grouped into one list. */
function body(lines) {
  const out = [];
  let list = null;
  for (const p of lines) {
    if (p.startsWith('• ')) { (list ||= []).push(para(p)); continue; }
    if (list) { out.push(html`<ul>${list}</ul>`); list = null; }
    out.push(para(p));
  }
  if (list) out.push(html`<ul>${list}</ul>`);
  return out;
}

/** Small sheet explaining one term, with a way into the full guide. */
export function explain(id) {
  const t = TOPIC.get(id);
  if (!t) return;
  openSheet({
    title: t.title, className: 'guidesheet',
    body: html`<p class="guide-short">${t.short}</p><div class="guide-body">${body(t.body)}</div>`,
    footer: html`<button class="btn grow" data-act="all">${icon('info')} Full guide</button><button class="btn primary grow" data-act="close">Got it</button>`,
    actions: { all: (b, e, api) => { api.close(); document.dispatchEvent(new CustomEvent('hibiki:closenp')); go('guide', id); } },
  });
}

registerScreen('guide', {
  top: () => ({ back: true, title: 'Guide', noSettings: true, noSearch: true }),
  render(el, st) {
    const open = st?.params?.id || null;
    el.innerHTML = String(html`<div class="page narrow guide">
      <p class="ink2" style="margin:4px 0 14px">What every number and setting in Hibiki means, and how it affects what you hear. In Now Playing, tap a number (Depth, Rate, Peak…) to see its entry.</p>
      ${GUIDE.map((sec) => html`<div class="sectionlabel"><span>${sec.title}</span></div>
        ${sec.topics.map((t) => html`<details class="note-card" id="g-${t.id}" ${t.id === open ? 'open' : ''}>
          <summary><span class="grow"><span class="g-t">${t.title}</span><span class="g-s">${t.short}</span></span>${icon('down')}</summary>
          <div class="note-b guide-body">${body(t.body)}</div></details>`)}`)}
    </div>`);
    if (open) requestAnimationFrame(() => $('#g-' + CSS.escape(open), el)?.scrollIntoView({ block: 'start' }));
  },
});
