// Passcode field: a row of 4 or 6 dots inside a Liquid Glass capsule.
// Digits come from the physical keyboard (or a paste). There is no on-screen keypad.
(function () {
  const LOCK_SVG =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path class="pf-shackle" d="M7.5 11V7.6a4.5 4.5 0 0 1 9 0V11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '<rect x="4.5" y="10.5" width="15" height="11" rx="3" fill="currentColor"/>' +
    '</svg>';

  let audioCtx = null;
  function tick() {
    try {
      audioCtx = audioCtx || new AudioContext();
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1800, t);
      osc.frequency.exponentialRampToValueAtTime(700, t + 0.03);
      gain.gain.setValueAtTime(0.045, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.06);
    } catch (_) { /* audio unavailable */ }
  }

  function el(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  class PasscodeField {
    constructor(root, opts) {
      this.root = root;
      this.opts = Object.assign({
        length: 6,
        title: '',
        hint: 'Enter Passcode',   // resting text under the field
        subtitle: '',
        sound: false,
        keyboard: true,
        optionsLabel: '',
        onOptions: null,
        onCancel: null,
        onComplete: () => {}
      }, opts);
      this.value = '';
      this.disabled = false;
      this.busy = false;
      this.keyboardEnabled = !!this.opts.keyboard;
      this.onKey = this.onKey.bind(this);
      this.onPaste = this.onPaste.bind(this);
      this.build();
      document.addEventListener('keydown', this.onKey, true);
      document.addEventListener('paste', this.onPaste, true);
    }

    build() {
      const r = this.root;
      r.classList.add('pf');
      r.innerHTML = '';

      this.titleEl = el('h2', 'pf-title');

      this.fieldEl = el('div', 'pf-field glass');
      this.fieldEl.setAttribute('role', 'img');
      this.dotsEl = el('div', 'pf-dots');
      this.fieldEl.appendChild(this.dotsEl);
      this.fieldEl.addEventListener('pointerdown', () => this.nudge());

      this.subEl = el('p', 'pf-sub');
      this.subEl.setAttribute('role', 'status');
      this.subEl.setAttribute('aria-live', 'polite');

      this.optionsBtn = el('button', 'pf-options');
      this.optionsBtn.type = 'button';
      this.optionsBtn.addEventListener('click', () => this.opts.onOptions && this.opts.onOptions());

      r.append(this.titleEl, this.fieldEl, this.subEl, this.optionsBtn);
      this.setTitle(this.opts.title, this.opts.subtitle);
      this.setOptionsLabel(this.opts.optionsLabel);
      this.renderDots();
      this.setKeyboard(this.keyboardEnabled);
    }

    renderDots() {
      this.dotsEl.innerHTML = '';
      this.dotsEl.dataset.len = this.opts.length;
      for (let i = 0; i < this.opts.length; i++) this.dotsEl.appendChild(el('span', 'pf-dot'));
      this.updateDots();
    }

    updateDots() {
      const n = this.value.length;
      [...this.dotsEl.children].forEach((d, i) => {
        d.classList.toggle('on', i < n);
        d.classList.toggle('next', i === n && !this.disabled);
      });
      this.fieldEl.setAttribute('aria-label', `Passcode, ${n} of ${this.opts.length} digits entered`);
    }

    setTitle(title, subtitle = '') {
      this.titleEl.textContent = title || '';
      this.titleEl.hidden = !title;
      this.setSubtitle(subtitle);
    }

    // Text under the field. Empty text falls back to the resting hint.
    // Tones 'error' and 'transient' are cleared again by the next keypress.
    setSubtitle(text, tone = '') {
      if (tone !== 'error' && tone !== 'transient') this.restText = text || '';
      this.subEl.textContent = text || this.opts.hint || '';
      this.subEl.dataset.tone = text ? tone : '';
    }

    setOptionsLabel(label) {
      this.optionsBtn.textContent = label || '';
      this.optionsBtn.hidden = !label;
    }

    setLength(n) {
      this.opts.length = n;
      this.value = '';
      this.renderDots();
    }

    setDisabled(disabled) {
      this.disabled = disabled;
      this.root.classList.toggle('disabled', disabled);
      this.updateDots();
    }

    setKeyboard(enabled) {
      this.keyboardEnabled = enabled;
      this.root.classList.toggle('ready', enabled);
    }

    // Clicking the capsule: remind the user to type, since there is no keypad.
    nudge() {
      this.fieldEl.classList.remove('nudge');
      void this.fieldEl.offsetWidth;
      this.fieldEl.classList.add('nudge');
      if (!this.disabled && !this.value && this.subEl.dataset.tone !== 'error') {
        this.setSubtitle('Type your passcode on the keyboard', 'transient');
      }
    }

    press(d) {
      if (this.disabled || this.busy || this.value.length >= this.opts.length) return;
      const tone = this.subEl.dataset.tone;
      if (tone === 'error' || tone === 'transient') this.setSubtitle(this.restText);
      if (this.opts.sound) tick();
      this.value += d;
      this.updateDots();
      if (this.value.length === this.opts.length) {
        this.busy = true;
        const pin = this.value;
        setTimeout(() => {
          this.busy = false;
          this.opts.onComplete(pin);
        }, 140);
      }
    }

    back() {
      if (this.disabled || this.busy || !this.value) return;
      this.value = this.value.slice(0, -1);
      this.updateDots();
    }

    reset() {
      this.value = '';
      this.updateDots();
    }

    shake() {
      this.fieldEl.classList.remove('shake');
      void this.fieldEl.offsetWidth;
      this.fieldEl.classList.add('shake');
      setTimeout(() => {
        this.fieldEl.classList.remove('shake');
        this.reset();
      }, 520);
    }

    success() {
      this.root.classList.add('unlocked');
    }

    active() {
      return this.keyboardEnabled && this.root.isConnected && this.root.offsetParent !== null;
    }

    onKey(e) {
      if (!this.active()) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        if (!e.repeat) this.press(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        this.back();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (this.value) this.reset();
        else if (this.opts.onCancel) this.opts.onCancel();
      }
    }

    onPaste(e) {
      if (!this.active()) return;
      e.preventDefault();
      const digits = (e.clipboardData?.getData('text') || '').replace(/\D/g, '');
      for (const d of digits) this.press(d);
    }

    destroy() {
      document.removeEventListener('keydown', this.onKey, true);
      document.removeEventListener('paste', this.onPaste, true);
      this.root.innerHTML = '';
    }
  }

  window.PasscodeField = PasscodeField;
  window.CL_LOCK_SVG = LOCK_SVG;
})();
