// src/web/public/components/modal.js
//
// Themed confirm/prompt/alert modals — replacement for native browser
// dialogs (window.confirm/prompt/alert) which look unstyled, don't follow
// the project theme, can't be focus-trapped or keyboard-tested, and break
// the UX of a polished UI.
//
// Promise-based API for drop-in replacement of native dialogs:
//
//   if (!await showConfirmModal({ message: 'Delete X?' })) return;
//   const name = await showPromptModal({ message: 'New name:' });
//   await showAlertModal({ message: 'Done!' });
//
// Phase 2.A of docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.

(function () {
  'use strict';

  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  let activeModal = null; // { backdrop, focusTrapHandler, escHandler, previousFocus, onClose }

  /**
   * Preempt marker. When openModal() is called while another modal is open,
   * the previous one's promise is rejected with this error so callers that
   * `await showConfirmModal()` get a clear unhandled rejection / catch path
   * instead of either of the wrong behaviours:
   *   - resolve(false) → "if (!await confirm)" treats preempt as user-cancel,
   *     so a destructive flow may be silently dropped.
   *   - resolve(symbol) → truthy → destructive flow PROCEEDS without user
   *     consent.
   * Rejection is the only safe default. Callers that explicitly want to
   * survive preempts can wrap in try/catch and check `err.name === 'AppModalPreemptedError'`.
   */
  class AppModalPreemptedError extends Error {
    constructor() {
      super('app-modal: preempted by a newer openModal() call');
      this.name = 'AppModalPreemptedError';
    }
  }

  function closeActiveModal(returnValue, { preempted = false } = {}) {
    if (!activeModal) return;
    const { backdrop, focusTrapHandler, escHandler, previousFocus, resolve, reject } = activeModal;
    document.removeEventListener('keydown', escHandler);
    document.removeEventListener('keydown', focusTrapHandler);
    backdrop.remove();
    activeModal = null;
    if (previousFocus && typeof previousFocus.focus === 'function') {
      // Defer focus restore so the unmount doesn't fight the browser's focus
      // recalculation.
      setTimeout(() => previousFocus.focus(), 0);
    }
    if (preempted) {
      reject(new AppModalPreemptedError());
    } else {
      resolve(returnValue);
    }
  }

  function buildFocusTrap(backdrop) {
    return (e) => {
      if (e.key !== 'Tab') return;
      const focusables = backdrop.querySelectorAll(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /**
   * Opens a modal with the given inner HTML and a buttons configuration.
   * Returns a Promise that resolves with the value passed to the button's
   * `value` once it's clicked (or with `cancelValue` on ESC / backdrop click
   * if `dismissable !== false`).
   */
  function openModal({
    title,
    bodyHtml,
    buttons, // array of { label, value, kind?: 'primary'|'danger'|'secondary' }
    cancelValue = null,
    dismissable = true,
    initialFocusSelector,
    onMount, // (root) => void  — called after DOM insert, before show
  }) {
    // If another modal is open, preempt it via rejection — see
    // AppModalPreemptedError docstring for rationale.
    if (activeModal) closeActiveModal(undefined, { preempted: true });

    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal app-modal active';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'app-modal-title');

    const titleHtml = title ? `
      <div class="modal-header">
        <h2 id="app-modal-title">${escapeHtml(title)}</h2>
      </div>` : '';

    const buttonsHtml = buttons.map((b, i) => {
      const cls = b.kind === 'danger'
        ? 'btn-danger'
        : b.kind === 'primary'
          ? 'btn-primary'
          : 'btn-secondary';
      return `<button type="button" class="btn ${cls}" data-modal-button="${i}">${escapeHtml(b.label)}</button>`;
    }).join('');

    backdrop.innerHTML = `
      <div class="modal-content app-modal-content" role="document">
        ${titleHtml}
        <div class="modal-body app-modal-body">${bodyHtml}</div>
        <div class="modal-footer">${buttonsHtml}</div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const resolved = new Promise((resolve, reject) => {
      const focusTrapHandler = buildFocusTrap(backdrop);
      const escHandler = (e) => {
        if (e.key === 'Escape' && dismissable) {
          e.preventDefault();
          closeActiveModal(cancelValue);
        }
      };

      activeModal = { backdrop, focusTrapHandler, escHandler, previousFocus, resolve, reject, cancelValue };

      document.addEventListener('keydown', focusTrapHandler);
      document.addEventListener('keydown', escHandler);

      // Button wiring
      buttons.forEach((b, i) => {
        const btn = backdrop.querySelector(`[data-modal-button="${i}"]`);
        if (btn) btn.addEventListener('click', () => closeActiveModal(b.value));
      });

      // Backdrop click dismisses (only if click is on backdrop itself, not on
      // the modal content).
      if (dismissable) {
        backdrop.addEventListener('click', (e) => {
          if (e.target === backdrop) closeActiveModal(cancelValue);
        });
      }

      if (typeof onMount === 'function') onMount(backdrop);

      // Initial focus: first focusable element, or a specific one.
      const initial = initialFocusSelector
        ? backdrop.querySelector(initialFocusSelector)
        : backdrop.querySelector(FOCUSABLE_SELECTOR);
      if (initial) initial.focus();
    });

    return resolved;
  }

  /**
   * Themed replacement for window.confirm(). Resolves to true on confirm,
   * false on cancel/ESC/backdrop.
   *
   * @param {{ title?: string, message: string, confirmText?: string, cancelText?: string, danger?: boolean }} opts
   * @returns {Promise<boolean>}
   */
  function showConfirmModal(opts) {
    const {
      title = 'Подтверждение',
      message,
      confirmText = 'Подтвердить',
      cancelText = 'Отмена',
      danger = false,
    } = opts || {};
    return openModal({
      title,
      bodyHtml: `<p class="app-modal-message">${escapeHtml(message)}</p>`,
      buttons: [
        { label: cancelText, value: false, kind: 'secondary' },
        { label: confirmText, value: true, kind: danger ? 'danger' : 'primary' },
      ],
      cancelValue: false,
    });
  }

  /**
   * Themed replacement for window.alert(). Resolves to undefined when
   * acknowledged (OK button, ESC, or backdrop).
   *
   * @param {{ title?: string, message: string, okText?: string }} opts
   * @returns {Promise<void>}
   */
  function showAlertModal(opts) {
    const { title = 'Информация', message, okText = 'ОК' } = opts || {};
    return openModal({
      title,
      bodyHtml: `<p class="app-modal-message">${escapeHtml(message)}</p>`,
      buttons: [{ label: okText, value: undefined, kind: 'primary' }],
      cancelValue: undefined,
    });
  }

  /**
   * Themed replacement for window.prompt(). Resolves to the entered string
   * on submit, or null on cancel/ESC.
   *
   * @param {{ title?: string, message?: string, label?: string, defaultValue?: string, placeholder?: string, submitText?: string, cancelText?: string }} opts
   * @returns {Promise<string|null>}
   */
  function showPromptModal(opts) {
    const {
      title = 'Ввод',
      message,
      label,
      defaultValue = '',
      placeholder = '',
      submitText = 'Сохранить',
      cancelText = 'Отмена',
    } = opts || {};
    const labelHtml = label
      ? `<label class="form-label" for="app-modal-prompt-input">${escapeHtml(label)}</label>`
      : '';
    const messageHtml = message
      ? `<p class="app-modal-message">${escapeHtml(message)}</p>`
      : '';
    return openModal({
      title,
      bodyHtml: `
        ${messageHtml}
        ${labelHtml}
        <input type="text" id="app-modal-prompt-input"
               class="form-input app-modal-prompt-input"
               value="${escapeHtml(defaultValue)}"
               placeholder="${escapeHtml(placeholder)}">
      `,
      // Submit button's value is set dynamically in onMount so it captures
      // the current input value at the moment of click (avoids reading after
      // backdrop is removed from DOM).
      buttons: [
        { label: cancelText, value: null, kind: 'secondary' },
        { label: submitText, value: null /* overridden in onMount */, kind: 'primary' },
      ],
      cancelValue: null,
      initialFocusSelector: '#app-modal-prompt-input',
      onMount: (root) => {
        const input = root.querySelector('#app-modal-prompt-input');
        const submitBtn = root.querySelector('[data-modal-button="1"]');
        if (!input || !submitBtn) return;
        // Pre-select text so the user can type-over the default immediately.
        setTimeout(() => input.select(), 0);
        // Replace the default click handler — we need to read input.value at
        // click time, not at modal-construction time.
        const newHandler = () => closeActiveModal(input.value);
        submitBtn.replaceWith(submitBtn.cloneNode(true));
        const fresh = root.querySelector('[data-modal-button="1"]');
        fresh.addEventListener('click', newHandler);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            closeActiveModal(input.value);
          }
        });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Legacy modal a11y wrapper
  //
  // `openModal()` above creates a *new* backdrop with generated HTML. Legacy
  // modals (entry / read / note / chat-delete / projects / domain / theme,
  // declared in index.html) already exist in the DOM and have their own
  // structure — they can't use `openModal()` directly. `attachModalA11y()`
  // adds focus trap + ESC + role/aria + previous-focus restore to an
  // already-rendered `.modal` element, and returns a cleanup function the
  // caller invokes when closing the modal.
  //
  // Stacking: confirm/prompt/alert (`activeModal`) always wins ESC handling.
  // Among legacy modals, only the top of `legacyA11yStack` responds — opening
  // a legacy modal while another is open pushes onto the stack; closing pops.
  // In practice legacy modals don't stack on top of each other in this app,
  // but the discipline keeps multi-handler firing safe.
  // ---------------------------------------------------------------------------

  const legacyA11yStack = [];

  function isLegacyTop(modalEl) {
    return legacyA11yStack.length > 0 &&
      legacyA11yStack[legacyA11yStack.length - 1].modalEl === modalEl;
  }

  function detachLegacyA11y(entry, { restoreFocus }) {
    document.removeEventListener('keydown', entry.focusTrapHandler);
    document.removeEventListener('keydown', entry.escHandler);
    const idx = legacyA11yStack.indexOf(entry);
    if (idx !== -1) legacyA11yStack.splice(idx, 1);
    if (restoreFocus && entry.previousFocus &&
        typeof entry.previousFocus.focus === 'function' &&
        document.contains(entry.previousFocus)) {
      setTimeout(() => entry.previousFocus.focus(), 0);
    }
  }

  /**
   * Attach a11y plumbing to an existing modal element. Returns a cleanup
   * function that must be called when the modal is hidden (clicks on close
   * button, backdrop, programmatic close — all paths).
   *
   * @param {HTMLElement} modalEl  The `.modal` backdrop element.
   * @param {{
   *   onClose: () => void,            // invoked on ESC if dismissable
   *   dismissable?: boolean,          // default true
   *   initialFocusSelector?: string,  // CSS selector inside modalEl, else first focusable
   * }} opts
   * @returns {() => void} cleanup (idempotent)
   */
  function attachModalA11y(modalEl, opts) {
    if (!modalEl) return () => {};
    const { onClose, dismissable = true, initialFocusSelector } = opts || {};

    // Re-entrancy: if open() called twice without close() in between, detach
    // the stale entry to avoid duplicate listeners.
    const existingIdx = legacyA11yStack.findIndex((m) => m.modalEl === modalEl);
    if (existingIdx !== -1) {
      detachLegacyA11y(legacyA11yStack[existingIdx], { restoreFocus: false });
    }

    if (!modalEl.hasAttribute('role')) modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');

    const previousFocus = document.activeElement;

    const focusTrapHandler = (e) => {
      if (e.key !== 'Tab') return;
      // If a confirm/alert/prompt modal is open, let it trap.
      if (activeModal) return;
      if (!isLegacyTop(modalEl)) return;
      const focusables = modalEl.querySelectorAll(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    const escHandler = (e) => {
      if (e.key !== 'Escape' || !dismissable) return;
      if (activeModal) return; // confirm modal on top — its ESC wins
      if (!isLegacyTop(modalEl)) return;
      e.preventDefault();
      if (typeof onClose === 'function') onClose();
    };

    document.addEventListener('keydown', focusTrapHandler);
    document.addEventListener('keydown', escHandler);

    const entry = { modalEl, focusTrapHandler, escHandler, previousFocus, onClose };
    legacyA11yStack.push(entry);

    // Defer initial focus so DOM updates from open() settle first.
    setTimeout(() => {
      let el = null;
      if (initialFocusSelector) el = modalEl.querySelector(initialFocusSelector);
      if (!el) el = modalEl.querySelector(FOCUSABLE_SELECTOR);
      if (el && typeof el.focus === 'function') el.focus();
    }, 0);

    let detached = false;
    return function cleanup() {
      if (detached) return;
      detached = true;
      detachLegacyA11y(entry, { restoreFocus: true });
    };
  }

  // Export to global scope so app.js can call them like the native dialogs.
  window.showConfirmModal = showConfirmModal;
  window.showAlertModal = showAlertModal;
  window.showPromptModal = showPromptModal;
  window.attachModalA11y = attachModalA11y;
  window.AppModalPreemptedError = AppModalPreemptedError;

  // Silence preempt rejections from default `unhandledrejection` console
  // noise. Callers can still `.catch(err => { if (err.name === 'AppModal…')
  // … })` explicitly. The rejection-on-preempt design exists so destructive
  // actions don't proceed silently; the actual console.error is just noise.
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason && e.reason.name === 'AppModalPreemptedError') {
      e.preventDefault();
    }
  });
})();
