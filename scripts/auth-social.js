(function () {
  'use strict';

  var _db = null;
  var _user = null;
  var _listeners = [];

  function notifyListeners(user) {
    _listeners.forEach(function (fn) { try { fn(user); } catch (_) {} });
  }

  function updateNavUI(user) {
    var loginBtns = document.getElementById('nav-login-btns');
    var userInfo  = document.getElementById('nav-user-info');
    var userName  = document.getElementById('nav-user-name');
    var userAvatar = document.getElementById('nav-user-avatar');
    if (!loginBtns || !userInfo) return;
    if (user) {
      loginBtns.style.display = 'none';
      userInfo.style.display  = 'flex';
      if (userName)  userName.textContent = user.display_name || user.email || 'Utente';
      if (userAvatar) {
        if (user.avatar_url) {
          userAvatar.src = user.avatar_url;
          userAvatar.style.display = 'block';
        } else {
          userAvatar.style.display = 'none';
        }
      }
    } else {
      loginBtns.style.display = 'flex';
      userInfo.style.display  = 'none';
    }
  }

  async function upsertProfile(supabaseUser) {
    if (!_db || !supabaseUser) return;
    var meta = supabaseUser.user_metadata || {};
    var provider = (supabaseUser.app_metadata && supabaseUser.app_metadata.provider) || null;
    try {
      await _db.from('profiles').upsert({
        id:           supabaseUser.id,
        display_name: meta.full_name || meta.name || meta.user_name || null,
        avatar_url:   meta.avatar_url || meta.picture || null,
        provider:     provider,
        updated_at:   new Date().toISOString(),
      }, { onConflict: 'id' });
    } catch (_) {}
  }

  var KaraokeAuth = {
    init: function (supabaseClient) {
      _db = supabaseClient;
      _db.auth.getSession().then(function (result) {
        var session = result.data && result.data.session;
        _user = session ? session.user : null;
        if (_user) upsertProfile(_user);
        updateNavUI(_user);
        notifyListeners(_user);
      }).catch(function () {});

      _db.auth.onAuthStateChange(function (_event, session) {
        _user = session ? session.user : null;
        if (_user) upsertProfile(_user);
        updateNavUI(_user);
        notifyListeners(_user);
      });
    },

    signInWithGoogle: function () {
      if (!_db) return;
      var redirectTo = window.location.origin + '/auth-callback.html';
      localStorage.setItem('auth_redirect', window.location.href);
      _db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo } });
    },

    signInWithFacebook: function () {
      if (!_db) return;
      var redirectTo = window.location.origin + '/auth-callback.html';
      localStorage.setItem('auth_redirect', window.location.href);
      _db.auth.signInWithOAuth({ provider: 'facebook', options: { redirectTo: redirectTo } });
    },

    signOut: function () {
      if (!_db) return;
      _db.auth.signOut();
    },

    getUser: function () {
      return _user;
    },

    onUserChange: function (callback) {
      _listeners.push(callback);
    },
  };

  window.KaraokeAuth = KaraokeAuth;
})();
