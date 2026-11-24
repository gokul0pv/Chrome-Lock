// Chrome Lock — background service worker.
//
// While locked, the Chrome window you were using stays exactly where it is and
// keeps running: every web page draws a Liquid Glass lock over itself
// (content.js), so the live page shows through heavily blurred frosted glass.
// The passcode is typed into an extension frame (lock.html?mode=embed) that
// the page cannot read.
//
// This worker keeps that lock honest:
// - every other Chrome window is minimized; any window that is restored,
//   created or focused while locked is minimized again,
// - if the locked window is closed or minimized, the next Chrome window that
//   gets focus becomes the locked window (it is already covered),
// - tabs a content script can't cover (New Tab, chrome:// pages, the Web Store,
//   error pages) are sent to a full-page lock screen that returns to the page
//   on unlock,
// - DevTools windows are closed, and changes to the lock state or passcode
//   that didn't come from this worker are reverted.

const LOCK_URL = chrome.runtime.getURL('lock.html');
const LOCK_TAB_URL = `${LOCK_URL}?mode=tab`;
const EXT_ORIGIN = chrome.runtime.getURL('');
const PBKDF2_ITERATIONS = 150000;
const LOCKOUT_STEPS_MIN = [1, 5, 15, 60];
const LOG_LIMIT = 50;
const ALL_WINDOW_TYPES = ['normal', 'popup', 'app', 'devtools'];

const DEFAULT_SETTINGS = {
  autoLockMinutes: 5,        // 0 = never
  lockOnSystemLock: true,
  lockOnStartup: true,
  lockoutThreshold: 5,       // 0 = off
  theme: 'tahoe',
  showClock: true,
  keySound: true,
  reduceMotion: false,
  blurBackground: true,      // live page behind frosted glass (off: opaque wallpaper)
  message: '',
  profileName: '',
  avatar: ''                 // small JPEG data URL, or '' for initials
};

const THEME_KEYS = ['tahoe', 'aurora', 'sunset', 'ocean', 'forest', 'rose', 'graphite', 'midnight'];

const VALIDATORS = {
  autoLockMinutes: (v) => [0, 1, 2, 5, 10, 15, 30, 60].includes(v),
  lockOnSystemLock: (v) => typeof v === 'boolean',
  lockOnStartup: (v) => typeof v === 'boolean',
  lockoutThreshold: (v) => [0, 3, 5, 10].includes(v),
  theme: (v) => THEME_KEYS.includes(v),
  showClock: (v) => typeof v === 'boolean',
  keySound: (v) => typeof v === 'boolean',
  reduceMotion: (v) => typeof v === 'boolean',
  blurBackground: (v) => typeof v === 'boolean',
  message: (v) => typeof v === 'string' && v.length <= 80,
  profileName: (v) => typeof v === 'string' && v.length <= 40,
  avatar: (v) => v === '' || (typeof v === 'string' && v.length <= 200000 &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v))
};

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const local = chrome.storage.local;
const session = chrome.storage.session;

async function getSettings() {
  const { settings } = await local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function getPin() {
  const { pin } = await local.get('pin');
  return pin && pin.hash && pin.salt ? pin : null;
}

async function isLocked() {
  const { isLocked: locked } = await local.get('isLocked');
  return !!locked && !!(await getPin());
}

async function addLog(type, detail = '') {
  const { log = [] } = await local.get('log');
  log.unshift({ t: Date.now(), type, detail });
  await local.set({ log: log.slice(0, LOG_LIMIT) });
}

// ---------------------------------------------------------------------------
// Passcode hashing (PBKDF2-SHA256 with a random per-install salt)
// ---------------------------------------------------------------------------

function toB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

async function derive(pin, saltB64) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromB64(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return toB64(bits);
}

async function makePin(pin) {
  const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
  return { hash: await derive(pin, salt), salt, length: pin.length };
}

function isValidPin(pin) {
  return typeof pin === 'string' && /^(\d{4}|\d{6})$/.test(pin);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Verifies a passcode, applying failed-attempt counting and escalating lockouts.
async function checkPin(pin) {
  const stored = await getPin();
  if (!stored) return { ok: false, error: 'No passcode is set' };

  const { lockoutUntil = 0, failedAttempts = 0 } = await local.get(['lockoutUntil', 'failedAttempts']);
  if (lockoutUntil > Date.now()) return { ok: false, lockoutUntil, error: 'Too many attempts' };

  if (isValidPin(pin) && safeEqual(await derive(pin, stored.salt), stored.hash)) {
    await local.set({ failedAttempts: 0, lockoutUntil: 0 });
    return { ok: true };
  }

  const settings = await getSettings();
  const failed = failedAttempts + 1;
  const result = { ok: false, failedAttempts: failed, error: 'Incorrect passcode' };
  const update = { failedAttempts: failed };

  if (settings.lockoutThreshold > 0) {
    if (failed >= settings.lockoutThreshold) {
      const step = Math.min(failed - settings.lockoutThreshold, LOCKOUT_STEPS_MIN.length - 1);
      update.lockoutUntil = Date.now() + LOCKOUT_STEPS_MIN[step] * 60000;
      result.lockoutUntil = update.lockoutUntil;
      await addLog('lockout', `${LOCKOUT_STEPS_MIN[step]} min after ${failed} failed attempts`);
    } else {
      result.attemptsLeft = settings.lockoutThreshold - failed;
    }
  }
  await local.set(update);
  await addLog('fail', `Failed attempt #${failed}`);
  return result;
}


// ---------------------------------------------------------------------------
// Trusted writes: only this worker may change the lock state or passcode.
// Any other extension context (e.g. DevTools pointed at the lock frame) that
// writes them is reverted by the storage.onChanged guard below.
// ---------------------------------------------------------------------------

const GUARDED = ['isLocked', 'pin'];
const expected = {}; // key -> { value (JSON), at }

function markTrusted(obj) {
  const at = Date.now();
  for (const k of GUARDED) if (k in obj) expected[k] = { value: JSON.stringify(obj[k]), at };
}

async function trustedSet(obj) {
  markTrusted(obj);
  await local.set(obj);
}

async function trustedRemove(keys) {
  markTrusted(Object.fromEntries(keys.map((k) => [k, undefined])));
  await local.remove(keys);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const now = Date.now();
  const revert = {};
  for (const key of GUARDED) {
    const c = changes[key];
    const e = expected[key];
    if (!c || (e && now - e.at < 3000 && JSON.stringify(c.newValue) === e.value)) continue;
    if (key === 'isLocked' && c.oldValue === true && c.newValue !== true) revert.isLocked = true;
    if (key === 'pin' && c.oldValue) revert.pin = c.oldValue;
  }
  if (!Object.keys(revert).length) return;
  trustedSet(revert)
    .then(() => addLog('tamper', 'Blocked a change to the lock that did not come from the lock screen'))
    .then(() => enforce());
});

// ---------------------------------------------------------------------------
// Window and tab enforcement (serialized so events can't race each other)
// ---------------------------------------------------------------------------

let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn).catch((err) => console.warn('[Chrome Lock]', err));
  chain = run;
  return run;
}

// Runs fn only while locked.
function guard(fn) {
  return serial(async () => {
    if (await isLocked()) await fn();
  });
}

async function getWindow(id) {
  try {
    return await chrome.windows.get(id, { windowTypes: ALL_WINDOW_TYPES });
  } catch (_) {
    return null;
  }
}

// The locked window: the one that stays visible, under the glass lock.
async function getHost() {
  const { hostWindowId } = await session.get('hostWindowId');
  if (typeof hostWindowId !== 'number') return null;
  const w = await getWindow(hostWindowId);
  return w && w.state !== 'minimized' ? w : null;
}

async function setHost(id) {
  const { hiddenWindows = {} } = await session.get('hiddenWindows');
  if (String(id) in hiddenWindows) {
    // A window we minimized is being used again: it's the locked window now,
    // so there's nothing to restore for it on unlock.
    delete hiddenWindows[id];
    await session.set({ hiddenWindows });
  }
  await session.set({ hostWindowId: id });
}

// The window being locked: the one you were using, if it's visible.
async function pickHost() {
  const usable = (w) => w && w.type !== 'devtools' && w.state !== 'minimized';
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal', 'popup', 'app'] });
    if (usable(w)) return w;
  } catch (_) { /* no windows */ }
  const all = await chrome.windows.getAll({ windowTypes: ['normal', 'popup', 'app'] });
  return all.find(usable) || null;
}

async function hideWindow(id) {
  const w = await getWindow(id);
  if (!w || w.state === 'minimized') return;
  if (w.type === 'devtools') {
    await chrome.windows.remove(w.id).catch(() => {});
    return;
  }
  const { hiddenWindows = {} } = await session.get('hiddenWindows');
  if (!(String(w.id) in hiddenWindows)) {
    hiddenWindows[w.id] = w.state;
    await session.set({ hiddenWindows });
  }
  await chrome.windows.update(w.id, { state: 'minimized' }).catch(() => {});
}

async function hideOthers(hostId) {
  const wins = await chrome.windows.getAll({ windowTypes: ALL_WINDOW_TYPES });
  for (const w of wins) if (w.id !== hostId) await hideWindow(w.id);
}

async function restoreWindows(focusId) {
  const { hiddenWindows = {} } = await session.get('hiddenWindows');
  await session.remove('hiddenWindows');
  for (const [id, state] of Object.entries(hiddenWindows)) {
    await chrome.windows.update(Number(id), { state: state === 'minimized' ? 'normal' : state }).catch(() => {});
  }
  if (typeof focusId === 'number') await chrome.windows.update(focusId, { focused: true }).catch(() => {});
}

// Asks the tab's content script to raise its lock. Resolves true if the glass
// lock is up. Fails for pages extensions can't script.
function shieldUp(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1000);
    try {
      chrome.tabs.sendMessage(tabId, { action: 'clShield' }, { frameId: 0 }, (res) => {
        clearTimeout(timer);
        void chrome.runtime.lastError;
        resolve(!!(res && res.shield));
      });
    } catch (_) {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

// Pages opened before the extension was installed or reloaded have no content
// script yet: add it now.
async function injectShield(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['lock-overlay.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['themes.js', 'content.js'] });
    return await shieldUp(tabId);
  } catch (_) {
    return false;
  }
}

// Sends a tab the content script can't cover to the full-page lock screen.
// lock.html goes back to the page by itself after unlock.
async function parkTab(tabId) {
  await chrome.tabs.update(tabId, { url: LOCK_TAB_URL }).catch(() => {});
}

async function coverTab(tab) {
  if (!tab || tab.discarded) return;
  const url = tab.pendingUrl || tab.url || '';
  if (url.startsWith(LOCK_URL)) return;
  if (await shieldUp(tab.id)) return;
  // A web page that is still loading gets its content script at document_start;
  // tabs.onUpdated checks it again once it has loaded.
  if (tab.status === 'loading' && /^(https?|file):/i.test(url)) return;
  if (await injectShield(tab.id)) return;
  await parkTab(tab.id);
}

async function coverActiveTab(windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab) await coverTab(tab);
}

function enforce() {
  return guard(async () => {
    let host = await getHost();
    if (!host) {
      host = await pickHost();
      if (host) await setHost(host.id);
    }
    await hideOthers(host ? host.id : null);
    // Cover the visible tab of every window, so a window restored from the
    // taskbar never shows an uncovered page, even for a moment.
    const wins = await chrome.windows.getAll({ windowTypes: ['normal', 'popup', 'app'] });
    for (const w of wins) await coverActiveTab(w.id);
    if (host) await chrome.windows.update(host.id, { focused: true }).catch(() => {});
  });
}

async function engageLock(reason) {
  if (!(await getPin())) return { success: false, error: 'Set a passcode first' };
  const already = await isLocked();
  if (!already) {
    // Choose the window to lock before any focus event can.
    const host = await pickHost();
    await session.remove('hostWindowId');
    if (host) await session.set({ hostWindowId: host.id });
    await trustedSet({ isLocked: true }); // every page raises its glass lock now
    await addLog('lock', reason);
  }
  await enforce();
  return { success: true };
}

function finishUnlock(delay) {
  setTimeout(() => {
    serial(async () => {
      if (await isLocked()) return; // relocked meanwhile
      const { hostWindowId } = await session.get('hostWindowId');
      await session.remove('hostWindowId');
      await restoreWindows(hostWindowId);
    });
  }, delay);
}

// ---------------------------------------------------------------------------
// Idle / startup / install
// ---------------------------------------------------------------------------

async function applyIdleSettings() {
  const s = await getSettings();
  const seconds = s.autoLockMinutes > 0 ? s.autoLockMinutes * 60 : 3600;
  chrome.idle.setDetectionInterval(Math.max(15, seconds));
}

applyIdleSettings();

chrome.idle.onStateChanged.addListener(async (state) => {
  const s = await getSettings();
  if (state === 'locked' && s.lockOnSystemLock) engageLock('Computer locked');
  else if (state === 'idle' && s.autoLockMinutes > 0) engageLock(`Idle for ${s.autoLockMinutes} min`);
});

chrome.runtime.onStartup.addListener(async () => {
  const s = await getSettings();
  const { isLocked: wasLocked } = await local.get('isLocked');
  if (await getPin()) {
    if (s.lockOnStartup || wasLocked) engageLock('Chrome started');
  }
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const legacy = await local.get(['passwordHash', 'autoLockEnabled', 'idleTimeoutMinutes', 'lockOnStartup']);
  if (legacy.passwordHash !== undefined || legacy.autoLockEnabled !== undefined) {
    // v1 used free-text passwords; v2 uses numeric passcodes. Carry settings over, ask for a new passcode.
    const settings = await getSettings();
    if (typeof legacy.lockOnStartup === 'boolean') settings.lockOnStartup = legacy.lockOnStartup;
    if (legacy.autoLockEnabled === false) settings.autoLockMinutes = 0;
    else if (VALIDATORS.autoLockMinutes(legacy.idleTimeoutMinutes)) settings.autoLockMinutes = legacy.idleTimeoutMinutes;
    await local.remove(['passwordHash', 'autoLockEnabled', 'idleTimeoutMinutes', 'lockOnStartup']);
    await local.set({ settings });
    await trustedSet({ isLocked: false });
  }
  // v2.0 kept a separate lock popup window and a page snapshot; drop leftovers.
  await session.remove(['lockWindowId', 'lockState', 'backdrop']);
  await local.remove('lastBounds');
  for (const t of await chrome.tabs.query({})) {
    if (!(t.url || '').startsWith(LOCK_URL) || (t.url || '').includes('mode=')) continue;
    const w = await getWindow(t.windowId);
    if (w && w.type === 'popup') await chrome.windows.remove(w.id).catch(() => {});
  }
  await applyIdleSettings();
  if (!(await getPin()) && (reason === 'install' || reason === 'update')) {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html#setup') });
  } else {
    // Chrome doesn't expose the profile name or photo to extensions, so ask for them once.
    if (reason === 'update' && !(await getSettings()).profileName && !(await isLocked())) {
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html#profile') });
    }
    enforce();
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'lock-now') engageLock('Keyboard shortcut');
});

// Toolbar button: lock straight away (no dropdown). Without a passcode, open setup.
// Settings are on the button's right-click menu (Chrome's built-in "Options").
chrome.action.onClicked.addListener(async () => {
  if (await getPin()) engageLock('Toolbar button');
  else chrome.tabs.create({ url: chrome.runtime.getURL('options.html#setup') });
});

// ---------------------------------------------------------------------------
// Guards: keep everything covered while locked
// ---------------------------------------------------------------------------

const WINDOW_FILTER = { windowTypes: ALL_WINDOW_TYPES };

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  guard(async () => {
    const w = await getWindow(windowId);
    if (!w) return;
    if (w.type === 'devtools') {
      await chrome.windows.remove(w.id).catch(() => {});
      return;
    }
    const host = await getHost();
    if (host && host.id === windowId) {
      await coverActiveTab(windowId);
      return;
    }
    if (host) {
      await hideWindow(windowId);
      await chrome.windows.update(host.id, { focused: true }).catch(() => {});
      return;
    }
    // The locked window was closed or minimized (e.g. taskbar "Close window"):
    // the window you just brought up becomes the locked window. Its pages are
    // already behind the glass lock.
    await setHost(windowId);
    await coverActiveTab(windowId);
    await hideOthers(windowId);
  });
}, WINDOW_FILTER);

chrome.windows.onCreated.addListener((w) => {
  guard(async () => {
    if (w.type === 'devtools') {
      await chrome.windows.remove(w.id).catch(() => {});
      return;
    }
    const host = await getHost();
    if (!host) {
      await setHost(w.id);
      await coverActiveTab(w.id);
    } else if (host.id !== w.id) {
      await hideWindow(w.id);
      await chrome.windows.update(host.id, { focused: true }).catch(() => {});
    }
  });
}, WINDOW_FILTER);

chrome.windows.onRemoved.addListener((windowId) => {
  serial(async () => {
    const { hostWindowId } = await session.get('hostWindowId');
    if (hostWindowId === windowId) await session.remove('hostWindowId');
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  guard(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) await coverTab(tab);
  });
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab.active || !(info.status === 'complete' || info.url || info.discarded === false)) return;
  guard(() => coverTab(tab));
});

// Watchdog: re-check every 30 seconds while locked, in case any event was missed.
chrome.alarms.create('enforce', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'enforce') enforce();
});

// Re-apply enforcement whenever the worker wakes up while locked.
enforce();

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

async function stateResponse() {
  const pin = await getPin();
  const { lockoutUntil = 0, failedAttempts = 0 } = await local.get(['lockoutUntil', 'failedAttempts']);
  return {
    isLocked: await isLocked(),
    hasPasscode: !!pin,
    passcodeLength: pin ? pin.length : 6,
    settings: await getSettings(),
    lockoutUntil: lockoutUntil > Date.now() ? lockoutUntil : 0,
    failedAttempts
  };
}

const handlers = {
  async getState() {
    return stateResponse();
  },

  async lock() {
    return engageLock('Locked manually');
  },

  async unlock({ pin }) {
    if (!(await isLocked())) return { success: true };
    const res = await checkPin(pin);
    if (!res.ok) return { success: false, ...res };
    await trustedSet({ isLocked: false });
    await addLog('unlock', 'Unlocked with passcode');
    const s = await getSettings();
    finishUnlock(s.reduceMotion ? 150 : 800);
    return { success: true };
  },

  async setup({ pin }) {
    if (await getPin()) return { success: false, error: 'A passcode is already set' };
    if (!isValidPin(pin)) return { success: false, error: 'Passcode must be 4 or 6 digits' };
    await trustedSet({ pin: await makePin(pin), isLocked: false });
    await local.set({ failedAttempts: 0, lockoutUntil: 0 });
    await addLog('setup', `${pin.length}-digit passcode turned on`);
    return { success: true };
  },

  async verify({ pin }) {
    const res = await checkPin(pin);
    return { success: res.ok, ...res };
  },

  async changePasscode({ currentPin, newPin }) {
    if (await isLocked()) return { success: false, error: 'Unlock first' };
    if (!isValidPin(newPin)) return { success: false, error: 'Passcode must be 4 or 6 digits' };
    const res = await checkPin(currentPin);
    if (!res.ok) return { success: false, ...res };
    await trustedSet({ pin: await makePin(newPin) });
    await addLog('change', `Passcode changed (${newPin.length} digits)`);
    return { success: true };
  },

  async removePasscode({ pin }) {
    if (await isLocked()) return { success: false, error: 'Unlock first' };
    const res = await checkPin(pin);
    if (!res.ok) return { success: false, ...res };
    await trustedRemove(['pin']);
    await local.remove(['failedAttempts', 'lockoutUntil']);
    await trustedSet({ isLocked: false });
    await addLog('remove', 'Passcode turned off');
    await serial(() => restoreWindows());
    return { success: true };
  },

  async saveSettings({ settings }) {
    if (await isLocked()) return { success: false, error: 'Unlock first' };
    if (!settings || typeof settings !== 'object') return { success: false, error: 'Invalid settings' };
    const current = await getSettings();
    for (const [key, value] of Object.entries(settings)) {
      if (!VALIDATORS[key] || !VALIDATORS[key](value)) return { success: false, error: `Invalid value for ${key}` };
      current[key] = value;
    }
    await local.set({ settings: current });
    await applyIdleSettings();
    return { success: true, settings: current };
  },

  async getLog() {
    if (await isLocked()) return { success: false, error: 'Unlock first' };
    const { log = [] } = await local.get('log');
    return { success: true, log };
  },

  async clearLog() {
    if (await isLocked()) return { success: false, error: 'Unlock first' };
    await local.set({ log: [] });
    return { success: true };
  }
};

// Web pages' content scripts may only ask for their own tab to be covered.
const contentHandlers = {
  // The glass lock couldn't be shown properly on this page (its lock frame was
  // blocked, or something docked into the window, such as DevTools): move the
  // tab to the full-page lock screen.
  async parkMe(_msg, sender) {
    if (!(await isLocked())) return { success: false };
    await parkTab(sender.tab.id);
    return { success: true };
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message && message.action;
  const fromExtensionPage = sender.id === chrome.runtime.id && (sender.url || '').startsWith(EXT_ORIGIN);
  let handler = null;
  if (fromExtensionPage) handler = handlers[action];
  else if (sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0) handler = contentHandlers[action];
  if (!handler) return false; // e.g. key relays meant for the lock frame

  handler(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ success: false, error: err?.message || 'Something went wrong' }));
  return true;
});
