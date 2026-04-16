// Theme initialization — runs synchronously before CSS to prevent flash.
// Default theme: 'nothing'. Existing users keep their previously chosen theme.
(function() {
  var t = localStorage.getItem('tm-theme');
  var valid = ['nothing', 'brutalist', 'gazette', 'sport', 'dashboard'];
  document.documentElement.dataset.theme =
    (t && valid.indexOf(t) !== -1) ? t : 'nothing';
})();
