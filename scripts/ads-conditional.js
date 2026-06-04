(function () {
  'use strict';

  var _loaded = false;

  function injectBannerScripts() {
    // Rimuove il CSS di nascondimento iniettato da ads-loader.js
    if (window._adsHideStyle) { window._adsHideStyle.remove(); window._adsHideStyle = null; }
    document.querySelectorAll('.ad-banner-top, .ad-banner-bottom').forEach(function (el) {
      if (el.dataset.adsLoaded) return;
      el.dataset.adsLoaded = '1';
      el.style.display = 'flex';
      var s1 = document.createElement('script');
      s1.text = "atOptions={'key':'0b2dec717b137030d01a6e9ac6e0481b','format':'iframe','height':50,'width':320,'params':{}};";
      var s2 = document.createElement('script');
      s2.src = 'https://www.highperformanceformat.com/0b2dec717b137030d01a6e9ac6e0481b/invoke.js';
      s2.async = true;
      el.appendChild(s1);
      el.appendChild(s2);
    });
  }

  function injectScript(src) {
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.referrerPolicy = 'no-referrer-when-downgrade';
    document.body.appendChild(s);
  }

  function injectPopunder() {
    // prizefamily.com — push subscriber / popunder (presente su tutte le pagine)
    (function (bpy) {
      var d = document, s = d.createElement('script'), l = d.scripts[d.scripts.length - 1];
      s.settings = bpy || {};
      s.src = '//prizefamily.com/bSXLVOssd.GDlC0OYTWocr/XezmR9FuRZaUul/kdPsTgc_xAMDDuUo1bMhDCk/tlNVzuE/w/NqT/UwxwMnwI';
      s.async = true;
      s.referrerPolicy = 'no-referrer-when-downgrade';
      l.parentNode.insertBefore(s, l);
    })({});

    // prizefamily.com secondo script + effectivecpmnetwork (solo index.html)
    if (window.location.pathname.replace(/.*\//, '') === 'index.html' || window.location.pathname === '/') {
      (function (xp) {
        var d = document, s = d.createElement('script'), l = d.scripts[d.scripts.length - 1];
        s.settings = xp || {};
        s.src = '//prizefamily.com/bwXPVBs.d/GslO0RYOWFcB/beCm/9bujZWUIlJk/PFTScvxoMHD/cmwfMNDNkStdN/zhEBwrNPzrANxjMVwh';
        s.async = true;
        s.referrerPolicy = 'no-referrer-when-downgrade';
        l.parentNode.insertBefore(s, l);
      })({});
      injectScript('https://pl29630920.effectivecpmnetwork.com/ea/68/41/ea68416143381fd4a6e542ebd2614603.js');
    }
  }

  window.KaraokeAds = {
    initForAnonymous: function () {
      if (_loaded) return;
      _loaded = true;
      if (window.loadAds) window.loadAds(); // Monetag (gestisce ADS_ENABLED)
      injectBannerScripts();
      injectPopunder();
      // Push notifications (5gvci) se consenso già dato
      try {
        if (localStorage.getItem('kt_push_consent') === '1' && window.ktLoadPushScript) {
          window.ktLoadPushScript();
        }
      } catch (_) {}
    },

    // Chiamato quando l'utente è loggato: nasconde i contenitori
    disableForUser: function () {
      document.querySelectorAll('.ad-banner-top, .ad-banner-bottom').forEach(function (el) {
        el.style.display = 'none';
      });
    },
  };
})();
