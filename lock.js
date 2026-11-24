// Lock screen. Two modes (lock.html?mode=…):
//   embed — inside a web page, over the live page (content.js blurs the page
//           underneath). Transparent background.
//   tab   — full page, for tabs a content script can't cover (New Tab,
//           chrome:// pages). Wallpaper background; goes back to the page
//           that was there once Chrome is unlocked.
const $ = (id) => document.getElementById(id);
const body = document.body;
const MODE = new URLSearchParams(location.search).get('mode') === 'embed' ? 'embed' : 'tab';

let settings = {};
let field = null;
let lockoutTimer = null;
let unlocking = false;
let myTabId = null;

document.documentElement.classList.add(`mode-${MODE}`);

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(res || {});
    });
  });
}

// ---------- Clock ----------
function tickClock() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).formatToParts(now);
  $('time').textContent = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
  $('date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
}

// ---------- Appearance ----------
function applySettings(s) {
  settings = s || {};
  clApplyTheme(document.documentElement, settings.theme);
  document.documentElement.classList.toggle('reduce-motion', !!settings.reduceMotion);
  // Over a live page the wallpaper only shows when the live page is turned off.
  body.classList.toggle('show-wallpaper', MODE === 'tab' || settings.blurBackground === false);
  body.classList.toggle('no-clock', settings.showClock === false);
  $('message').textContent = settings.message || '';
  $('name').textContent = clDisplayName(settings);
  clRenderAvatar($('avatar'), settings);
  document.title = `${clDisplayName(settings)} · Locked`;
}

// ---------- Lockout ----------
function formatRemaining(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s} seconds`;
}

function startLockout(until) {
  clearInterval(lockoutTimer);
  field.setDisabled(true);
  const update = () => {
    const left = until - Date.now();
    if (left <= 0) {
      clearInterval(lockoutTimer);
      field.setDisabled(false);
      field.setSubtitle('');
      return;
    }
    field.setSubtitle(`Too many attempts. Try again in ${formatRemaining(left)}`, 'error');
  };
  update();
  lockoutTimer = setInterval(update, 1000);
}

// ---------- Unlock ----------
async function tryUnlock(pin) {
  const res = await send({ action: 'unlock', pin });
  if (res.success) return playUnlock();

  field.shake();
  body.classList.remove('wrong');
  void body.offsetWidth;
  body.classList.add('wrong');
  if (res.lockoutUntil) {
    setTimeout(() => startLockout(res.lockoutUntil), 520);
  } else if (typeof res.attemptsLeft === 'number' && res.attemptsLeft <= 2) {
    field.setSubtitle(`Incorrect passcode · ${res.attemptsLeft} attempt${res.attemptsLeft === 1 ? '' : 's'} left`, 'error');
  } else if (res.error && res.error !== 'Incorrect passcode') {
    field.setSubtitle(res.error, 'error');
  } else {
    field.setSubtitle('Incorrect passcode', 'error');
  }
}

function playUnlock() {
  if (unlocking) return;
  unlocking = true;
  field?.setKeyboard(false);
  field?.success();
  body.classList.add('unlocking');
  if (MODE === 'tab') setTimeout(leave, settings.reduceMotion ? 150 : 650);
}

// Full-page mode: return to whatever the tab showed before it was covered.
function leave() {
  if (history.length > 1) {
    history.back();
    return;
  }
  chrome.tabs.getCurrent((tab) => {
    if (chrome.runtime.lastError || !tab) return;
    chrome.tabs.update(tab.id, { url: 'chrome://newtab/' });
  });
}

// ---------- Keys ----------
// Digits relayed by this tab's content script while the page itself had focus.
const relayedKey = (key) => ({
  key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}
});

function numLockHint(code, numLockOn) {
  if (!field || unlocking || numLockOn || !/^Numpad[0-9]$/.test(code)) return;
  field.setSubtitle('Num Lock is off', 'transient');
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.action !== 'clKey' || MODE !== 'embed' || !field) return;
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.tab.id !== myTabId || sender.frameId !== 0) return;
  if ((sender.url || '').startsWith(chrome.runtime.getURL(''))) return; // only the page's content script
  numLockHint(msg.code, msg.numLock);
  if (typeof msg.key === 'string' && /^([0-9]|Backspace|Escape)$/.test(msg.key)) field.onKey(relayedKey(msg.key));
});

// Swallow browser shortcuts the lock screen is allowed to cancel (reload,
// DevTools, the Chrome menu, back/forward, find, print, save…).
document.addEventListener('keydown', (e) => {
  numLockHint(e.code, e.getModifierState('NumLock'));
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (plain && (/^[0-9]$/.test(e.key) || e.key === 'Backspace' || e.key === 'Escape')) return; // the passcode field
  e.preventDefault();
}, true);
document.addEventListener('pointerdown', (e) => {
  if (field && !unlocking && !e.target.closest('.pf-field')) field.nudge();
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('dragstart', (e) => e.preventDefault());
document.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

// Live updates: an unlock from another tab or window, or a relock.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.isLocked && changes.isLocked.newValue === false) playUnlock();
  if (changes.settings && changes.settings.newValue) applySettings(changes.settings.newValue);
});

// ---------- Init ----------
async function init() {
  const [state, tab] = await Promise.all([
    send({ action: 'getState' }),
    new Promise((resolve) => chrome.tabs.getCurrent((t) => { void chrome.runtime.lastError; resolve(t || null); }))
  ]);
  myTabId = tab ? tab.id : null;
  applySettings(state.settings);

  field = new PasscodeField($('field'), {
    length: state.passcodeLength || 6,
    sound: !!settings.keySound,
    keyboard: true,
    hint: 'Enter Passcode',
    onComplete: tryUnlock
  });

  tickClock();
  setInterval(tickClock, 1000);

  if (state.lockoutUntil) startLockout(state.lockoutUntil);

  // Tell the page's content script the lock frame is up (it fades us in and
  // stops waiting before falling back to the full-page lock).
  if (MODE === 'embed' && myTabId !== null) {
    chrome.tabs.sendMessage(myTabId, { action: 'clFrameReady' }, { frameId: 0 }, () => void chrome.runtime.lastError);
  }
  window.focus();

  if (!state.isLocked) playUnlock(); // opened after unlocking (e.g. a restored tab)

  requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('booting')));
}

init();
