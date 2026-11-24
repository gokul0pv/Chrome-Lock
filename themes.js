// Shared wallpaper palettes + avatar helper. Loaded by extension pages and the content script.
// Each theme: three glow colours + a deep base colour.
(function (global) {
  const THEMES = {
    tahoe:    { name: 'Tahoe',    c1: '#2563eb', c2: '#7c3aed', c3: '#19b5d8', base: '#061230' },
    aurora:   { name: 'Aurora',   c1: '#6d5dfc', c2: '#b44cf0', c3: '#22c3e6', base: '#0b0b22' },
    sunset:   { name: 'Sunset',   c1: '#ff7a45', c2: '#ff3d8b', c3: '#8b5cf6', base: '#1d0b26' },
    ocean:    { name: 'Ocean',    c1: '#1da1f2', c2: '#2b59ff', c3: '#14d1b5', base: '#04172e' },
    forest:   { name: 'Forest',   c1: '#22c55e', c2: '#0f766e', c3: '#a3e635', base: '#03170f' },
    rose:     { name: 'Rose Gold', c1: '#ff8fa3', c2: '#e0457b', c3: '#ffc078', base: '#2a0d17' },
    graphite: { name: 'Graphite', c1: '#7c8597', c2: '#3c4252', c3: '#b9c0cc', base: '#0a0b0e' },
    midnight: { name: 'Midnight', c1: '#3346d3', c2: '#5b21b6', c3: '#0e7490', base: '#020414' }
  };

  function applyTheme(el, key) {
    const t = THEMES[key] || THEMES.tahoe;
    el.style.setProperty('--c1', t.c1);
    el.style.setProperty('--c2', t.c2);
    el.style.setProperty('--c3', t.c3);
    el.style.setProperty('--base', t.base);
    return t;
  }

  function swatch(key) {
    const t = THEMES[key] || THEMES.tahoe;
    return `radial-gradient(circle at 25% 25%, ${t.c3}, transparent 60%),` +
      `radial-gradient(circle at 80% 30%, ${t.c2}, transparent 65%),` +
      `radial-gradient(circle at 40% 85%, ${t.c1}, transparent 70%), ${t.base}`;
  }

  const PERSON_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="4.2" fill="currentColor"/>' +
    '<path d="M3.8 21.2c.9-4.2 4.2-6.6 8.2-6.6s7.3 2.4 8.2 6.6" fill="currentColor"/></svg>';

  function initials(name) {
    return (name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
      .map((w) => [...w][0].toUpperCase()).join('');
  }

  // Fills `el` with the profile photo, initials, or a generic person glyph.
  function renderAvatar(el, settings) {
    const s = settings || {};
    el.textContent = '';
    if (s.avatar) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = s.avatar;
      el.appendChild(img);
      el.dataset.kind = 'photo';
      return;
    }
    const text = initials(s.profileName);
    if (text) {
      el.textContent = text;
      el.dataset.kind = 'initials';
    } else {
      el.innerHTML = PERSON_SVG;
      el.dataset.kind = 'none';
    }
  }

  function displayName(settings) {
    return ((settings && settings.profileName) || '').trim() || 'Chrome';
  }

  global.CL_THEMES = THEMES;
  global.clApplyTheme = applyTheme;
  global.clThemeSwatch = swatch;
  global.clRenderAvatar = renderAvatar;
  global.clDisplayName = displayName;
})(typeof window !== 'undefined' ? window : self);
