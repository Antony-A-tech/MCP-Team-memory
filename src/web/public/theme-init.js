// Theme initialization — runs synchronously before CSS to prevent flash
(function() {
  var t = localStorage.getItem('tm-theme');
  if (t) document.documentElement.dataset.theme = t;
})();
