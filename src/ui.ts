/**
 * ui.ts — static markup + a modal helper for Snake Royale menus and panels.
 * Rendering the live game is render.ts's job; this is the surrounding chrome.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export const FOOTER_HTML = `
  <footer class="site-footer">
    Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
    · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
  </footer>`;

export function menuHTML(best: number): string {
  return `
    <section class="screen menu">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <span class="dot d1"></span><span class="dot d2"></span><span class="dot d3"></span>
        </div>
        <h1 class="title">Snake&nbsp;Royale</h1>
        <p class="tagline">Eat, grow, cut them off. Last snake slithering wins.</p>
      </div>
      <div class="menu-actions">
        <button class="btn btn-primary" data-act="solo">▶ Play — Endless</button>
        <button class="btn" data-act="friends">👥 Play with friends</button>
        <div class="menu-row">
          <button class="btn btn-ghost" data-act="howto">How to play</button>
          <button class="btn btn-ghost" data-act="about">About</button>
          <button class="btn btn-ghost" data-act="mute" aria-pressed="false"></button>
        </div>
      </div>
      <p class="best-line">${best > 0 ? `Best endless run: <strong>${best}</strong>` : 'Grab pellets to start your first run.'}</p>
    </section>`;
}

export function friendsSetupHTML(): string {
  return `
    <section class="screen friends-setup">
      <button class="back" data-act="back" aria-label="Back to menu">‹ Menu</button>
      <div class="lobby-mount" id="entryMount"></div>
    </section>`;
}

export const HOWTO_HTML = `
  <p>Your snake never stops moving. Steer it to eat the glowing gold pellets — each one grows you and scores a point.</p>
  <ul class="howto-list">
    <li><strong>Don't</strong> hit the walls, another snake, or your own tail.</li>
    <li><strong>Endless:</strong> play solo for the longest snake and your best score.</li>
    <li><strong>Royale:</strong> 2–6 friends share one arena — the last snake alive wins the round. A beaten snake bursts into pellets, so boxing a rival in also feeds you.</li>
  </ul>
  <p class="howto-controls">
    <strong>Turn:</strong> Arrow keys / WASD, swipe, or the on-screen pad.<br />
    <strong>Pause:</strong> P or Esc (solo). <strong>Mute:</strong> M.
  </p>`;

export const ABOUT_HTML = `
  <p>Snake Royale is a free, instant-play take on the arcade classic — one snake for a quick solo run, or a shared arena for a last-one-standing round with friends.</p>
  <p>It runs entirely in your browser with no accounts and no game server. Multiplayer is <strong>peer-to-peer</strong> over WebRTC: a free public signaling relay only helps your devices find each other for the initial handshake — after that, game data flows directly between players and nothing is stored on any server.</p>
  <p>No cookies, no tracking, no third-party fonts. Anonymous, cookie-less page-view counts come from Cloudflare Web Analytics.</p>
  <p>Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a> · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>.</p>`;

let activeModal: HTMLElement | null = null;

export function openModal(title: string, bodyHTML: string): void {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal-head">
        <h2 class="modal-title">${escapeHtml(title)}</h2>
        <button class="modal-close" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">${bodyHTML}</div>
    </div>`;
  document.body.appendChild(overlay);
  activeModal = overlay;
  const close = () => closeModal();
  overlay.querySelector('.modal-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
      window.removeEventListener('keydown', onKey);
    }
  };
  window.addEventListener('keydown', onKey);
}

export function closeModal(): void {
  activeModal?.remove();
  activeModal = null;
}
