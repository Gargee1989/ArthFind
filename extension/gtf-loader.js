/* Optional visibility helpers. No PDF.js hooks, timers or animation loop. */
(() => {
  'use strict';
  const overlay = () => document.getElementById('pdf-loading-overlay');
  function syncVisibility() {
    overlay()?.toggleAttribute('data-paused', document.hidden);
  }
  window.GTFLoader = Object.freeze({
    show() {
      const element = overlay();
      if (!element) return;
      element.hidden = false;
      element.style.removeProperty('display');
      syncVisibility();
    },
    hide() {
      const element = overlay();
      if (element) element.style.display = 'none';
    }
  });
  document.addEventListener('visibilitychange', syncVisibility);
  syncVisibility();
})();
