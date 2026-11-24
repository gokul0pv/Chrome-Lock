// Content script — the glass lock over every web page while Chrome is locked.
//
// The page keeps running underneath. A frosted veil (backdrop-filter) blurs it
// heavily, and the lock screen itself is an extension frame on top
// (lock.html?mode=embed), so the passcode is typed into a document the page
// cannot read. Keys typed while the page still has focus are swallowed and
// relayed to that frame.
//
// The lock is a closed shadow root in a manual popover, so it sits in the top
// layer above page dialogs, and it is re-raised if the page opens its own.
(() => {
  if (window.top !== window) return; // top frame only; frames are under the veil
  if (window.__chromeLockShield) return; // already injected (scripting fallback)
  window.__chromeLockShield = true;

  const FRAME_URL = chrome.runtime.getURL('lock.html?mode=embed');
  const MASK_TITLE = 'Locked';
  const MASK_ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.5 11V7.6a4.5 4.5 0 0 1 9 0V11" fill="none" stroke="#8e8e93" stroke-width="2.2" stroke-linecap="round"/><rect x="4.5" y="10.5" width="15" height="11" rx="3" fill="#8e8e93"/></svg>');

  const HOST_STYLE = [
    'all:initial', 'position:fixed', 'inset:0', 'width:auto', 'height:auto', 'margin:0', 'padding:0',
    'border:0', 'display:block', 'overflow:hidden', 'background:transparent', 'z-index:2147483647',
    'visibility:visible', 'opacity:1', 'transform:none', 'filter:none', 'clip-path:none', 'pointer-events:auto'
  ].map((d) => d + '!important').join(';');

  const SHIELD_CSS = `
    :host { all: initial; }
    .wrap { position: fixed; inset: 0; overflow: hidden; color-scheme: only light; }
    .veil {
      position: absolute; inset: -2px;
      -webkit-backdrop-filter: blur(46px) saturate(1.9) brightness(.8);
      backdrop-filter: blur(46px) saturate(1.9) brightness(.8);
      transition: backdrop-filter .75s cubic-bezier(.2,.8,.2,1), -webkit-backdrop-filter .75s cubic-bezier(.2,.8,.2,1);
    }
    /* Tint: a whisper of the wallpaper's colours, a top-down sheen, and enough
       shade at the top and bottom for white text over bright pages. */
    .tint {
      position: absolute; inset: 0;
      background:
        radial-gradient(120% 70% at 50% -12%, rgba(255,255,255,.18), transparent 58%),
        radial-gradient(80% 60% at 8% 4%, color-mix(in srgb, var(--c3) 30%, transparent), transparent 70%),
        radial-gradient(80% 70% at 96% 100%, color-mix(in srgb, var(--c2) 26%, transparent), transparent 70%),
        linear-gradient(180deg, rgba(8,10,20,.38) 0%, rgba(8,10,20,.2) 42%, rgba(8,10,20,.52) 100%);
      transition: opacity .65s ease;
    }
    /* Wallpaper mode (live page turned off): opaque, nothing shows through. */
    .solid .veil { backdrop-filter: none; -webkit-backdrop-filter: none; }
    .solid .tint {
      background:
        radial-gradient(circle at 20% 15%, var(--c3), transparent 55%),
        radial-gradient(circle at 85% 30%, var(--c2), transparent 60%),
        radial-gradient(circle at 40% 90%, var(--c1), transparent 65%),
        var(--base);
    }
    iframe {
      position: absolute; inset: 0; width: 100%; height: 100%;
      border: 0; background: transparent;
      /* Must equal lock.css's root color-scheme. An explicit value also ignores the
         page's <meta name=color-scheme>; a mismatch makes Chrome paint the frame
         opaque (white on pages that opt into dark mode, e.g. GitHub). */
      color-scheme: only light;
      opacity: 0; transition: opacity .3s ease;
    }
    iframe.ready { opacity: 1; }
    .unlocking .veil { backdrop-filter: blur(0) saturate(1) brightness(1); -webkit-backdrop-filter: blur(0) saturate(1) brightness(1); }
    .unlocking .tint { opacity: 0; }
    .solid.unlocking .tint { transition-delay: .2s; }
    .reduce-motion * { transition-duration: .01s !important; transition-delay: 0s !important; }
    @media (prefers-reduced-motion: reduce) { * { transition-duration: .01s !important; } }
  `;

  let locked = false;
  let hasPin = false;
  let settings = {};
  let host = null;
  let wrap = null;
  let frame = null;
  let shown = false;
  let observer = null;
  let ticker = null;
  let hideTimer = null;
  let readyTimer = null;
  let savedTitle = null;
  let iconLink = null;
  let base = null; // viewport size when the lock went up

  // ---------- Build ----------
  function build() {
    host = document.createElement('chrome-lock-shield');
    host.setAttribute('style', HOST_STYLE);
    host.setAttribute('popover', 'manual');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${SHIELD_CSS}</style><div class="wrap"><div class="veil"></div><div class="tint"></div></div>`;
    wrap = root.querySelector('.wrap');
    frame = document.createElement('iframe');
    frame.setAttribute('allowtransparency', 'true');
    frame.setAttribute('aria-label', 'Chrome is locked');
    frame.addEventListener('load', focusFrame);
    wrap.appendChild(frame);
  }

  function styleFor(s) {
    const t = (self.CL_THEMES || {})[s.theme] || { c1: '#2563eb', c2: '#7c3aed', c3: '#19b5d8', base: '#061230' };
    wrap.style.cssText = `--c1:${t.c1};--c2:${t.c2};--c3:${t.c3};--base:${t.base}`;
    wrap.classList.toggle('solid', s.blurBackground === false);
    wrap.classList.toggle('reduce-motion', !!s.reduceMotion);
  }

  function raise() {
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch (_) { /* popover unsupported, or host not connected yet */ }
  }

  function attach() {
    if (!host.isConnected) {
      (document.documentElement || document).appendChild(host);
      raise();
    }
  }

  // ---------- Show / hide ----------
  function show() {
    clearTimeout(hideTimer);
    if (!host) build();
    styleFor(settings);
    wrap.classList.remove('unlocking');
    if (!document.documentElement) return; // shown once the document exists
    document.documentElement.setAttribute('data-chrome-lock', settings.blurBackground === false ? 'solid' : 'glass');
    attach();
    if (shown) return;
    shown = true;

    frame.classList.remove('ready');
    frame.src = FRAME_URL;
    // If the lock frame never comes up (e.g. the page blocks cross-origin
    // frames), move this tab to the full-page lock screen.
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      if (shown && !frame.classList.contains('ready')) park();
    }, 4000);

    observer = new MutationObserver(() => {
      if (!shown) return;
      if (!host.isConnected) attach();
      if (!document.documentElement.hasAttribute('data-chrome-lock')) {
        document.documentElement.setAttribute('data-chrome-lock', settings.blurBackground === false ? 'solid' : 'glass');
      }
    });
    observer.observe(document.documentElement, { childList: true, attributes: true, attributeFilter: ['data-chrome-lock'] });

    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    maskTab();
    base = measure();
    ticker = setInterval(tick, 500);
  }

  function hide(animated) {
    if (!shown) return;
    shown = false;
    observer?.disconnect();
    observer = null;
    clearInterval(ticker);
    clearTimeout(readyTimer);
    unmaskTab();
    const finish = () => {
      try { host.hidePopover(); } catch (_) {}
      host.remove();
      frame.removeAttribute('src');
      document.documentElement?.removeAttribute('data-chrome-lock');
    };
    if (animated) {
      wrap.classList.add('unlocking');
      hideTimer = setTimeout(finish, settings.reduceMotion ? 120 : 800);
    } else {
      finish();
    }
  }

  function apply(animated) {
    if (locked && hasPin) show();
    else hide(animated);
  }

  function park() {
    try { chrome.runtime.sendMessage({ action: 'parkMe' }, () => void chrome.runtime.lastError); } catch (_) {}
  }

  function focusFrame() {
    if (!shown || !frame) return;
    try { frame.focus(); frame.contentWindow?.focus(); } catch (_) {}
  }

  // ---------- Tab title and icon ----------
  function maskTab() {
    if (savedTitle === null) savedTitle = document.title;
    if (document.title !== MASK_TITLE) document.title = MASK_TITLE;
    if (!iconLink && document.head) {
      iconLink = document.createElement('link');
      iconLink.rel = 'icon';
      iconLink.href = MASK_ICON;
      document.head.appendChild(iconLink);
    } else if (iconLink && document.head && document.head.lastElementChild !== iconLink) {
      document.head.appendChild(iconLink); // stay the last icon
    }
  }

  function unmaskTab() {
    if (savedTitle !== null && document.title === MASK_TITLE) document.title = savedTitle;
    savedTitle = null;
    iconLink?.remove();
    iconLink = null;
  }

  // ---------- Watchdog (every 500 ms while shown) ----------
  function measure() {
    const dpr = window.devicePixelRatio || 1;
    return { w: innerWidth * dpr, h: innerHeight * dpr, ow: outerWidth, oh: outerHeight };
  }

  function tick() {
    if (!shown) return;
    attach();
    // The page changed its title: remember it for unlock, keep the tab masked.
    if (document.title !== MASK_TITLE) savedTitle = document.title;
    maskTab();
    // Page dialogs, popovers or fullscreen opened after the lock: get back on top.
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    try {
      const others = [...document.querySelectorAll(':modal, :popover-open')].some((n) => n !== host);
      if (others) raise();
    } catch (_) {}
  }

  // Something docked into the window (DevTools, a side panel) shrinks the page
  // without the window changing size. DevTools would show the page's content,
  // so the tab moves to the full-page lock screen.
  addEventListener('resize', () => {
    if (!shown || !base) return;
    const now = measure();
    const sameWindow = Math.abs(now.ow - base.ow) < 4 && Math.abs(now.oh - base.oh) < 4;
    if (!sameWindow) { base = now; return; }
    if (base.w - now.w > 160 || base.h - now.h > 160) park();
  });

  // ---------- Input: nothing reaches the page while locked ----------
  const relay = (e) => {
    const digit = /^[0-9]$/.test(e.key);
    const numpad = /^Numpad[0-9]$/.test(e.code);
    if (!digit && !numpad && e.key !== 'Backspace' && e.key !== 'Escape') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    try {
      chrome.runtime.sendMessage({
        action: 'clKey', key: e.key, code: e.code, numLock: e.getModifierState('NumLock')
      }, () => void chrome.runtime.lastError);
    } catch (_) {}
  };

  const swallow = (e) => {
    if (!shown) return;
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
    if (e.type === 'keydown') {
      relay(e);
      focusFrame();
    }
  };
  for (const type of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'paste', 'copy', 'cut',
    'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
    'wheel', 'touchstart', 'touchmove', 'dragstart', 'drop']) {
    addEventListener(type, swallow, { capture: true, passive: false });
  }
  addEventListener('focus', () => focusFrame());
  document.addEventListener('fullscreenchange', () => {
    if (shown && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  });

  // ---------- State ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg) return;
    if (msg.action === 'clShield') {
      // The background only asks while locked.
      locked = true;
      hasPin = true;
      show();
      sendResponse({ shield: !!(host && host.isConnected) });
    } else if (msg.action === 'clFrameReady' && shown) {
      clearTimeout(readyTimer);
      frame.classList.add('ready');
      focusFrame();
    }
  });

  chrome.storage.local.get(['isLocked', 'pin', 'settings'], (r) => {
    if (chrome.runtime.lastError) return;
    settings = r.settings || {};
    locked = !!r.isLocked;
    hasPin = !!r.pin;
    apply(false);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) settings = changes.settings.newValue || {};
    if (changes.isLocked || changes.pin) {
      if (changes.isLocked) locked = !!changes.isLocked.newValue;
      if (changes.pin) hasPin = !!changes.pin.newValue;
      apply(true);
    }
  });

  // document_start runs before <html> exists on some pages: retry then.
  if (!document.documentElement) {
    new MutationObserver((_, obs) => {
      if (document.documentElement) { obs.disconnect(); if (locked && hasPin) show(); }
    }).observe(document, { childList: true });
  }
})();
