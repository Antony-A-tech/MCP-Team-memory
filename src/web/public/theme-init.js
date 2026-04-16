// Theme initialization — runs synchronously before CSS to prevent flash.
// Default theme: 'nothing'. Existing users keep their previously chosen theme.
// Legacy 'default' value (from before Nothing replaced the base palette) is migrated to 'nothing'.
(function() {
  var t = localStorage.getItem('tm-theme');
  if (t === 'default') { localStorage.removeItem('tm-theme'); t = null; }
  var valid = ['nothing', 'brutalist', 'gazette', 'sport', 'dashboard'];
  document.documentElement.dataset.theme =
    (t && valid.indexOf(t) !== -1) ? t : 'nothing';
})();
