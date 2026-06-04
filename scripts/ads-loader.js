// Il tag Monetag è presente come script statico nell'<head> (#ads-monetag).
// Questo loader lo rimuove se gli ads sono disabilitati.
// KT_ADS_BLOCKED: true se l'utente ha una sessione attiva in localStorage.
// Viene letto sincronicamente dagli script inline nelle pagine.
window.KT_ADS_BLOCKED = (function () {
  try {
    var keys = Object.keys(localStorage);
    for (var i = 0; i < keys.length; i++) {
      if (/^sb-.+-auth-token$/.test(keys[i])) {
        var d = JSON.parse(localStorage.getItem(keys[i]) || 'null');
        if (d && d.access_token) return true;
      }
    }
  } catch (_) {}
  return false;
})();

(function () {
  function removeAdTag() {
    var tag = document.getElementById('ads-monetag');
    if (tag) tag.remove();
  }

  function checkAndMaybeDisable() {
    var cfg = window.config;
    if (cfg && cfg.ADS_ENABLED === false) { removeAdTag(); return; }
    if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;
    fetch(cfg.SUPABASE_URL + '/rest/v1/impostazioni_pubbliche?select=ads_enabled&id=eq.1', {
      headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + cfg.SUPABASE_ANON_KEY },
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (Array.isArray(data) && data.length && data[0].ads_enabled === false) removeAdTag();
      })
      .catch(function () {});
  }

  // Carica lo script push 5gvci solo se l'utente ha dato il consenso
  function loadPushScript() {
    var s = document.createElement('script');
    s.src = 'https://5gvci.com/act/files/tag.min.js?z=11096095';
    s.setAttribute('data-cfasync', 'false');
    s.async = true;
    document.head.appendChild(s);
  }

  // Controlla il consenso al caricamento della pagina (skip se utente loggato)
  function checkPushConsent() {
    try {
      if (localStorage.getItem('kt_push_consent') === '1' && !window.KT_ADS_BLOCKED) loadPushScript();
    } catch (_) {}
  }

  window.loadAds = checkAndMaybeDisable;
  window.ktLoadPushScript = loadPushScript; // esposto per chiamata da index.html al consenso

  if (!window.ADS_MANUAL_LOAD) checkAndMaybeDisable();
  checkPushConsent();
})();
