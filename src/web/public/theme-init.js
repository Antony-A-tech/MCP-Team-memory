// Theme initialization — runs synchronously before CSS to prevent flash
(function() {
  var t = localStorage.getItem('tm-theme');
  var valid = ['brutalist', 'gazette', 'sport', 'dashboard'];
  if (t && valid.indexOf(t) !== -1) document.documentElement.dataset.theme = t;
})();
