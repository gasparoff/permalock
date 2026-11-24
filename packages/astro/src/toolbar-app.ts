import { defineToolbarApp } from 'astro/toolbar';

interface Status {
  path: string;
  key?: string;
  entry?: { type: string; to?: string; source?: string; reason?: string };
  inbound: { from: string; reason?: string }[];
  total: number;
  hasLockfile: boolean;
  warnings: string[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function render(s: Status): string {
  let state: string;
  if (!s.hasLockfile) state = `<p>No <code>permalock.json</code> yet. Run <code>astro build</code> once and commit it: from then on every URL is protected.</p>`;
  else if (!s.entry)
    state = `<p><astro-dev-toolbar-badge badge-style="purple">new URL</astro-dev-toolbar-badge> This URL is not in <code>permalock.json</code> yet. It will be locked at the next build.</p>`;
  else if (s.entry.type === 'page')
    state = `<p><astro-dev-toolbar-badge badge-style="green">locked</astro-dev-toolbar-badge> Once published, this URL must keep working. If you move this page, Permalock redirects the old URL for you.</p>${
      s.entry.source ? `<p class="muted">Identity: <code>${esc(s.entry.source)}</code></p>` : ''
    }`;
  else if (s.entry.type === 'redirect')
    state = `<p><astro-dev-toolbar-badge badge-style="blue">redirect</astro-dev-toolbar-badge> In production this URL answers 301 to <code>${esc(s.entry.to ?? '')}</code>.</p>`;
  else state = `<p><astro-dev-toolbar-badge badge-style="red">removed</astro-dev-toolbar-badge> Declared removed${s.entry.reason ? `: ${esc(s.entry.reason)}` : ''}. A page here will be locked again at the next build.</p>`;
  const inbound = s.inbound.length
    ? `<h3>${s.inbound.length} old URL${s.inbound.length > 1 ? 's lead' : ' leads'} here</h3><ul>${s.inbound
        .slice(0, 20)
        .map((i) => `<li><code>${esc(i.from)}</code></li>`)
        .join('')}</ul>`
    : '';
  const warnings = s.warnings.length ? `<h3>Watch out</h3><ul>${s.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
  return `<style>
    :host astro-dev-toolbar-window { max-width: 520px; }
    h2 { margin: 0 0 8px; font-size: 18px; } h3 { margin: 16px 0 6px; font-size: 14px; }
    p { margin: 6px 0; line-height: 1.5; } astro-dev-toolbar-badge { display: inline-block; vertical-align: middle; margin-right: 6px; } ul { margin: 0; padding-left: 18px; } li { margin: 2px 0; }
    code { font-size: 12px; background: rgba(255,255,255,.08); padding: 1px 4px; border-radius: 4px; }
    .muted { opacity: .7; font-size: 13px; }
  </style>
  <astro-dev-toolbar-window>
    <h2>Permalock</h2>
    <p class="muted"><code>${esc(s.path)}</code> · ${s.total.toLocaleString('en-US')} URLs locked</p>
    ${state}${inbound}${warnings}
  </astro-dev-toolbar-window>`;
}

export default defineToolbarApp({
  init(canvas, app, server) {
    let last: Status | undefined;
    const ask = () => server.send('permalock:query', { path: location.pathname });
    server.on<Status>('permalock:status', (s) => {
      if (s.path !== location.pathname) return;
      last = s;
      canvas.innerHTML = render(s);
      app.toggleNotification(s.warnings.length ? { state: true, level: 'warning' } : { state: false });
    });
    server.on<{ message: string }>('permalock:warning', () => ask());
    app.onToggled(({ state }) => {
      if (state) ask();
    });
    document.addEventListener('astro:page-load', ask);
    ask();
    void last;
  },
});
