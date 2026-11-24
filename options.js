const $ = (id) => document.getElementById(id);

const SWITCHES = ['blurBackground', 'lockOnSystemLock', 'lockOnStartup', 'showClock', 'keySound', 'reduceMotion'];
const SELECTS = ['autoLockMinutes', 'lockoutThreshold'];
const PANES = ['profile', 'passcode', 'autolock', 'lockscreen', 'activity'];

let state = null;
let field = null;
let toastTimer = null;
const typingTimers = {};

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(res || {});
    });
  });
}

function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

function showPane(name) {
  if (!PANES.includes(name)) name = 'passcode';
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${name}`));
  document.querySelectorAll('[data-pane]').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  $('pane-title').textContent = $(`pane-${name}`).dataset.title;
  document.querySelector('.scroller').scrollTop = 0;
  history.replaceState(null, '', `#${name}`);
}

document.querySelectorAll('[data-pane]').forEach((b) => b.addEventListener('click', () => showPane(b.dataset.pane)));

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function load() {
  state = await send({ action: 'getState' });
  if (!state.settings) {
    $('status-text').textContent = state.error || 'Could not load settings';
    return;
  }
  render();
  renderLog();
}

function render() {
  const s = state.settings;
  const has = state.hasPasscode;

  clApplyTheme(document.documentElement, s.theme);
  document.documentElement.classList.toggle('reduce-motion', s.reduceMotion);

  // Profile
  const name = (s.profileName || '').trim();
  $('side-name').textContent = name || 'Your Name';
  $('hero-name').textContent = name || 'Your Name';
  [$('side-avatar'), $('big-avatar'), $('pv-avatar')].forEach((el) => clRenderAvatar(el, s));
  if (document.activeElement !== $('profileName')) $('profileName').value = s.profileName || '';
  $('remove-photo').disabled = !s.avatar;

  // Passcode status
  $('side-status').innerHTML = has
    ? '<i class="on"></i>Protected'
    : '<i class="off"></i>Not protected';
  $('status-ic').classList.toggle('on', has);
  $('status-title').textContent = has ? 'Passcode is on' : 'Passcode is off';
  $('status-text').textContent = has
    ? `Chrome is protected with a ${state.passcodeLength}-digit passcode.`
    : 'Turn on a passcode to lock all of Chrome. Nothing is visible until it’s entered.';
  $('lock-now').disabled = !has;
  $('row-turn-on').classList.toggle('hidden', has);
  $('row-change').classList.toggle('hidden', !has);
  $('row-turn-off').classList.toggle('hidden', !has);

  SWITCHES.forEach((k) => { $(k).checked = !!s[k]; });
  SELECTS.forEach((k) => { $(k).value = String(s[k]); $(k).syncMenu?.(); });
  if (document.activeElement !== $('message')) $('message').value = s.message || '';

  renderSwatches();
  renderPreview();
}

function renderSwatches() {
  const wrap = $('swatches');
  const current = state.settings.theme;
  if (!wrap.children.length) {
    Object.keys(CL_THEMES).forEach((key) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.key = key;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', CL_THEMES[key].name);
      b.title = CL_THEMES[key].name;
      b.style.background = clThemeSwatch(key);
      b.addEventListener('click', () => save({ theme: key }, 'Wallpaper updated'));
      wrap.appendChild(b);
    });
  }
  [...wrap.children].forEach((b) => b.setAttribute('aria-checked', String(b.dataset.key === current)));
  $('wall-name').textContent = CL_THEMES[current]?.name || '';
}

function renderPreview() {
  if (!state?.settings) return;
  const now = new Date();
  const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).formatToParts(now);
  $('pv-time').textContent = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
  $('pv-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  $('pv-msg').textContent = $('message').value;
  $('pv-name').textContent = clDisplayName({ profileName: $('profileName').value });
  $('pv-field').innerHTML = '<i></i>'.repeat(state.passcodeLength || 6);
  $('preview').classList.toggle('pv-no-clock', !state.settings.showClock);
  $('preview').classList.toggle('pv-blur', state.settings.blurBackground !== false);
}

const LOG_META = {
  lock:    { title: 'Locked',             color: '#0a84ff', icon: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>' },
  unlock:  { title: 'Unlocked',           color: '#30d158', icon: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>' },
  fail:    { title: 'Wrong Passcode',     color: '#ff9f0a', icon: '<path d="M7 7l10 10M17 7L7 17"/>' },
  lockout: { title: 'Unlocking Disabled', color: '#ff453a', icon: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M12 9v4M12 16h.01"/>' },
  setup:   { title: 'Passcode On',        color: '#8e8e93', icon: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>' },
  change:  { title: 'Passcode Changed',   color: '#8e8e93', icon: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>' },
  remove:  { title: 'Passcode Off',       color: '#8e8e93', icon: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>' }
};

function relTime(t) {
  const diff = (t - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return 'Just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(t).toLocaleDateString();
}

async function renderLog() {
  const res = await send({ action: 'getLog' });
  const card = $('log-card');
  card.querySelectorAll('.log-row').forEach((n) => n.remove());
  const log = (res.log || []).slice(0, 20);
  $('log-empty').classList.toggle('hidden', log.length > 0);
  $('clear-log').classList.toggle('hidden', log.length === 0);

  for (const entry of log) {
    const meta = LOG_META[entry.type] || LOG_META.lock;
    const row = document.createElement('div');
    row.className = 'row log-row';
    row.innerHTML = `
      <span class="ic" style="--ic:${meta.color}"><svg viewBox="0 0 24 24">${meta.icon}</svg></span>
      <span class="log-main"><span class="log-title"></span><span class="log-detail"></span></span>
      <span class="log-time"></span>`;
    row.querySelector('.log-title').textContent = meta.title;
    row.querySelector('.log-detail').textContent = entry.detail || '';
    row.querySelector('.log-time').textContent = relTime(entry.t);
    row.querySelector('.log-time').title = new Date(entry.t).toLocaleString();
    card.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function save(partial, okText = 'Saved') {
  const res = await send({ action: 'saveSettings', settings: partial });
  if (!res.success) {
    toast(res.error || 'Could not save', true);
    render();
    return false;
  }
  state.settings = res.settings;
  render();
  if ('theme' in partial) {
    $('preview').classList.remove('bump');
    void $('preview').offsetWidth;
    $('preview').classList.add('bump');
  }
  toast(okText);
  return true;
}

SWITCHES.forEach((k) => $(k).addEventListener('change', (e) => save({ [k]: e.target.checked })));
SELECTS.forEach((k) => $(k).addEventListener('change', (e) => save({ [k]: Number(e.target.value) })));

// ---------------------------------------------------------------------------
// Liquid Glass pop-up menus (replace the native <select> drop-downs)
// ---------------------------------------------------------------------------

const CHECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRONS_SVG = '<svg viewBox="0 0 10 16" aria-hidden="true"><path d="M2 6l3-3 3 3M2 10l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let openMenuState = null;

function enhanceSelect(sel) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'popup';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const labelText = sel.closest('.row')?.querySelector('.label')?.textContent;
  if (labelText) btn.setAttribute('aria-label', labelText);
  const text = document.createElement('span');
  btn.append(text);
  btn.insertAdjacentHTML('beforeend', CHEVRONS_SVG);
  sel.hidden = true;
  sel.classList.remove('popup');
  sel.after(btn);
  sel.syncMenu = () => { text.textContent = sel.selectedOptions[0]?.textContent || ''; };
  sel.syncMenu();
  btn.addEventListener('click', () => (openMenuState?.btn === btn ? closeMenu() : openMenu(sel, btn)));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(sel, btn); }
  });
}

function openMenu(sel, btn) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu glass';
  menu.setAttribute('role', 'listbox');
  let selectedItem = null;

  [...sel.options].forEach((opt) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(opt.selected));
    item.innerHTML = `<span class="menu-check">${opt.selected ? CHECK_SVG : ''}</span>`;
    item.append(opt.textContent);
    item.addEventListener('click', () => {
      closeMenu(true);
      if (sel.value === opt.value) return;
      sel.value = opt.value;
      sel.syncMenu();
      sel.dispatchEvent(new Event('change'));
    });
    item.addEventListener('pointermove', () => item.focus({ preventScroll: true }));
    if (opt.selected) selectedItem = item;
    menu.appendChild(item);
  });

  menu.addEventListener('keydown', (e) => {
    const items = [...menu.children];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, i + 1)].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(0, i - 1)].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(true); }
  });

  document.body.appendChild(menu);

  // macOS style: the checked item opens right on top of the button.
  const r = btn.getBoundingClientRect();
  const anchor = selectedItem || menu.firstElementChild;
  menu.style.minWidth = `${Math.max(menu.offsetWidth, r.width + 30)}px`;
  let top = r.top + r.height / 2 - (anchor.offsetTop + anchor.offsetHeight / 2);
  top = Math.max(8, Math.min(top, innerHeight - menu.offsetHeight - 8));
  let left = r.left - 22;
  left = Math.max(8, Math.min(left, innerWidth - menu.offsetWidth - 8));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.transformOrigin = `${r.left - left + r.width / 2}px ${r.top - top + r.height / 2}px`;

  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('open');
  anchor.focus({ preventScroll: true });
  openMenuState = { menu, btn };
}

function closeMenu(refocus = false) {
  if (!openMenuState) return;
  const { menu, btn } = openMenuState;
  openMenuState = null;
  btn.setAttribute('aria-expanded', 'false');
  btn.classList.remove('open');
  menu.classList.add('closing');
  setTimeout(() => menu.remove(), 140);
  if (refocus) btn.focus();
}

document.addEventListener('pointerdown', (e) => {
  if (openMenuState && !openMenuState.menu.contains(e.target) && !openMenuState.btn.contains(e.target)) closeMenu();
}, true);
addEventListener('resize', () => closeMenu());
addEventListener('blur', () => closeMenu());
document.querySelector('.scroller').addEventListener('scroll', () => closeMenu(), { passive: true });

SELECTS.forEach((k) => enhanceSelect($(k)));

function saveWhileTyping(id, okText, onInput) {
  $(id).addEventListener('input', () => {
    onInput?.();
    clearTimeout(typingTimers[id]);
    typingTimers[id] = setTimeout(() => save({ [id]: $(id).value.trim() }, okText), 600);
  });
}

saveWhileTyping('message', 'Message saved', renderPreview);
saveWhileTyping('profileName', 'Name saved', () => {
  const live = { ...state.settings, profileName: $('profileName').value };
  const name = live.profileName.trim() || 'Your Name';
  $('side-name').textContent = name;
  $('hero-name').textContent = name;
  if (!live.avatar) [$('side-avatar'), $('big-avatar'), $('pv-avatar')].forEach((el) => clRenderAvatar(el, live));
  renderPreview();
});

// Profile picture: centre-crop to a 256px square JPEG so it stays small in storage.
async function setPhoto(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
    bmp.close();
    await save({ avatar: canvas.toDataURL('image/jpeg', 0.86) }, 'Picture updated');
  } catch (_) {
    toast('Couldn’t read that image', true);
  }
}

const pickPhoto = () => $('photo-input').click();
$('pick-photo').addEventListener('click', pickPhoto);
$('pick-photo-2').addEventListener('click', pickPhoto);
$('photo-input').addEventListener('change', (e) => {
  setPhoto(e.target.files[0]);
  e.target.value = '';
});
$('remove-photo').addEventListener('click', () => save({ avatar: '' }, 'Picture removed'));

$('shortcut-btn').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

chrome.commands.getAll((cmds) => {
  const c = cmds.find((x) => x.name === 'lock-now');
  $('shortcut').textContent = c && c.shortcut ? c.shortcut.replace(/\+/g, ' + ') : 'Not set';
});

$('lock-now').addEventListener('click', async () => {
  const res = await send({ action: 'lock' });
  if (!res.success) toast(res.error || 'Could not lock', true);
});

$('clear-log').addEventListener('click', async () => {
  await send({ action: 'clearLog' });
  renderLog();
  toast('Activity cleared');
});

// ---------------------------------------------------------------------------
// Passcode sheet flows
// ---------------------------------------------------------------------------

function openSheet(opts) {
  const sheet = $('sheet');
  document.activeElement?.blur();
  sheet.hidden = false;
  sheet.classList.remove('closing');
  $('app').inert = true;
  field = new PasscodeField($('sheet-field'), {
    keyboard: true,
    sound: !!state.settings.keySound,
    hint: '',
    onCancel: closeSheet,
    ...opts
  });
}

function closeSheet() {
  const sheet = $('sheet');
  if (sheet.hidden) return;
  sheet.classList.add('closing');
  field?.setKeyboard(false);
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove('closing');
    $('app').inert = false;
    field?.destroy();
    field = null;
  }, 260);
}

$('sheet-cancel').addEventListener('click', closeSheet);
$('sheet').addEventListener('pointerdown', (e) => { if (e.target === $('sheet')) field?.nudge(); });

function slideStep(fn) {
  const root = $('sheet-field');
  root.animate(
    [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(-28px)' }],
    { duration: 150, easing: 'ease-in', fill: 'forwards' }
  ).onfinish = () => {
    fn();
    root.animate(
      [{ opacity: 0, transform: 'translateX(28px)' }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' }
    );
  };
}

function failure(res) {
  field.shake();
  if (res.lockoutUntil) {
    const mins = Math.ceil((res.lockoutUntil - Date.now()) / 60000);
    field.setSubtitle(`Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 'error');
  } else if (typeof res.attemptsLeft === 'number') {
    field.setSubtitle(`Incorrect passcode · ${res.attemptsLeft} attempt${res.attemptsLeft === 1 ? '' : 's'} left`, 'error');
  } else {
    field.setSubtitle(res.error || 'Incorrect passcode', 'error');
  }
}

// Asks for a new passcode twice, then calls onDone(newPin).
function newPasscodeSteps(title, onDone) {
  let length = 6;
  let first = null;
  const optionsLabel = () => (length === 6 ? 'Use a 4-digit passcode' : 'Use a 6-digit passcode');

  const enterNew = (subtitle = '', tone = '') => {
    first = null;
    field.setLength(length);
    field.setTitle(title, 'Type the digits on your keyboard');
    if (subtitle) field.setSubtitle(subtitle, tone);
    field.setOptionsLabel(optionsLabel());
    field.opts.onOptions = () => {
      length = length === 6 ? 4 : 6;
      field.setLength(length);
      field.setOptionsLabel(optionsLabel());
    };
    field.opts.onComplete = (pin) => {
      first = pin;
      slideStep(() => {
        field.reset();
        field.setTitle('Verify your new passcode', 'Type it once more');
        field.setOptionsLabel('');
        field.opts.onComplete = (again) => {
          if (again !== first) {
            field.shake();
            setTimeout(() => slideStep(() => enterNew('Passcodes didn’t match. Try again.', 'error')), 500);
            return;
          }
          onDone(again);
        };
      });
    };
  };
  enterNew();
}

function finish(text) {
  field.success();
  setTimeout(closeSheet, 300);
  toast(text);
  load();
}

function startSetup() {
  openSheet({ length: 6 });
  newPasscodeSteps('Choose a passcode', async (pin) => {
    const res = await send({ action: 'setup', pin });
    if (!res.success) return failure(res);
    finish('Passcode turned on');
    if (state.settings.profileName) {
      showPane('passcode');
    } else {
      // Next: the name and picture shown on the lock screen.
      showPane('profile');
      setTimeout(() => $('profileName').focus(), 350);
    }
  });
}

function startChange() {
  openSheet({ length: state.passcodeLength, title: 'Enter your current passcode' });
  field.opts.onComplete = async (oldPin) => {
    const check = await send({ action: 'verify', pin: oldPin });
    if (!check.success) return failure(check);
    slideStep(() => {
      newPasscodeSteps('Enter a new passcode', async (newPin) => {
        const res = await send({ action: 'changePasscode', currentPin: oldPin, newPin });
        if (!res.success) return failure(res);
        finish('Passcode changed');
      });
    });
  };
}

function startRemove() {
  openSheet({ length: state.passcodeLength, title: 'Turn off passcode', subtitle: 'Enter your passcode. Chrome will no longer be protected.' });
  field.opts.onComplete = async (pin) => {
    const res = await send({ action: 'removePasscode', pin });
    if (!res.success) return failure(res);
    finish('Passcode turned off');
  };
}

$('turn-on').addEventListener('click', startSetup);
$('change').addEventListener('click', startChange);
$('turn-off').addEventListener('click', startRemove);

// Keep the page in sync with changes made elsewhere (lock screen, other tabs).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.pin || changes.isLocked || changes.settings || changes.log) {
    clearTimeout(load._t);
    load._t = setTimeout(load, 150);
  }
});

setInterval(renderPreview, 30000);

const initialHash = location.hash.slice(1);
showPane(initialHash === 'setup' ? 'passcode' : initialHash);
if (initialHash === 'profile') setTimeout(() => $('profileName').focus(), 400);
load().then(() => {
  if (initialHash === 'setup' && state && !state.hasPasscode) startSetup();
});
