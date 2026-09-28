/* webapi.js — dashboard.js'i Chrome eklentisi OLMADAN, düz bir web sayfası olarak çalıştırır.
   Supabase'e doğrudan bu tarayıcıdan bağlanır (Auth ile giriş yapar, sonra REST/RPC çağırır).
   Ayarlar config.js dosyasındaki window.TY_CONFIG = { url, anonKey } içinden okunur. */
(function () {
  'use strict';
  const KEY = 'ty_session_v1';
  const cfg = () => {
    const c = window.TY_CONFIG || {};
    if (!c.url || !c.anonKey) throw new Error('config.js dosyasına Supabase adresini ve anon key\'i yazmalısın.');
    return c;
  };

  function loadSession() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function saveSession(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* özel pencere olabilir */ } }
  function clearSession() { try { localStorage.removeItem(KEY); } catch (e) { /* yoksay */ } }

  async function tokenRequest(grant, body) {
    const c = cfg();
    const r = await fetch(`${c.url}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: c.anonKey }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.msg || j.message || `Giriş hatası (${r.status})`);
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, email: (j.user && j.user.email) || body.email || '' };
  }

  let refreshLock = null;
  async function refreshSession(s) {
    if (!refreshLock) {
      refreshLock = tokenRequest('refresh_token', { refresh_token: s.refresh_token })
        .then((ns) => { ns.email = ns.email || s.email; saveSession(ns); return ns; })
        .finally(() => { refreshLock = null; });
    }
    return refreshLock;
  }

  async function getSession(forceRefresh) {
    const s = loadSession();
    if (!s) throw new Error('Giriş yapılmamış.');
    if (forceRefresh || s.expires_at - Date.now() < 60000) return refreshSession(s);
    return s;
  }

  function decodeJwt(token) {
    try {
      const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(b64).split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  async function whoAmI(forceRefresh) {
    const s = await getSession(forceRefresh);
    const p = decodeJwt(s.access_token);
    if (!p || !p.sub) throw new Error('Kullanıcı kimliği okunamadı, tekrar giriş yapın.');
    return { id: p.sub, email: p.email || s.email || '' };
  }

  async function api(method, path, body, prefer, forceRefresh) {
    if (!/^\/rest\/v1\/(rpc\/ty_[a-z_]+|(v_)?ty_[a-z_]+|expenses)(\?.*)?$/.test(path)) throw new Error('İzin verilmeyen adres');
    const c = cfg();
    const s = await getSession(forceRefresh);
    const headers = { apikey: c.anonKey, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const r = await fetch(`${c.url}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && !forceRefresh) return api(method, path, body, prefer, true);
    const txt = await r.text();
    let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { /* boş yanıt */ }
    if (!r.ok) throw new Error((j && (j.message || j.hint || j.details)) || `Sunucu hatası (${r.status})`);
    return j;
  }

  async function changePassword(newPassword, forceRefresh) {
    const c = cfg();
    const s = await getSession(forceRefresh);
    const r = await fetch(`${c.url}/auth/v1/user`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', apikey: c.anonKey, Authorization: `Bearer ${s.access_token}` },
      body: JSON.stringify({ password: newPassword }),
    });
    if (r.status === 401 && !forceRefresh) return changePassword(newPassword, true);
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && (j.message || j.error_description || j.msg)) || `Sunucu hatası (${r.status})`);
    return { ok: true };
  }

  async function apiAll(path) {
    const out = []; const sep = path.includes('?') ? '&' : '?';
    for (let off = 0; off < 200000; off += 1000) {
      const page = await api('GET', `${path}${sep}limit=1000&offset=${off}`);
      if (!Array.isArray(page)) break;
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  }

  // ---------- giriş ekranı ----------
  function showLogin() {
    return new Promise((resolve) => {
      let box = document.getElementById('login');
      if (!box) { box = document.createElement('div'); box.id = 'login'; document.body.appendChild(box); }
      box.innerHTML = '';
      box.style.display = 'flex';

      const form = document.createElement('form');
      form.innerHTML = `
        <h2>Sipariş &amp; Ürün Takip</h2>
        <div class="muted" style="margin-bottom:10px">Giriş yapmak için Supabase hesabının e-posta ve şifresini kullan.</div>
        <div class="row"><label>E-posta</label><input type="email" id="lgEmail" required autocomplete="username"></div>
        <div class="row"><label>Şifre</label><input type="password" id="lgPass" required autocomplete="current-password"></div>
        <button type="submit">Giriş Yap</button>
        <div class="err" id="lgErr"></div>`;
      box.appendChild(form);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = form.querySelector('#lgErr');
        err.textContent = 'Giriş yapılıyor…';
        try {
          const email = form.querySelector('#lgEmail').value.trim();
          const password = form.querySelector('#lgPass').value;
          const s = await tokenRequest('password', { email, password });
          saveSession(s);
          box.style.display = 'none';
          resolve(s);
        } catch (e2) { err.textContent = 'Giriş başarısız: ' + e2.message; }
      });
    });
  }

  async function ready() {
    const s = loadSession();
    if (s) {
      try { await getSession(false); return; } catch (e) { clearSession(); }
    }
    await showLogin();
  }

  async function call(msg) {
    // dashboard.js'in call() sarmalayıcısıyla aynı sözleşme: veriyi doğrudan döner, hatada fırlatır.
    if (msg.type === 'API') return api(msg.method || 'GET', msg.path, msg.body, msg.prefer);
    if (msg.type === 'API_ALL') return apiAll(msg.path);
    if (msg.type === 'WHOAMI') return whoAmI();
    if (msg.type === 'CHANGE_PASSWORD') return changePassword(msg.password);
    throw new Error('Bilinmeyen komut');
  }

  function logout() { clearSession(); location.reload(); }

  window.WebApi = { ready, call, logout };
})();
