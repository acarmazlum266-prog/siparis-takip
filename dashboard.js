/* dashboard.js — Sipariş & Ürün Takip paneli. Veriyi arka plan (background.js) üzerinden Supabase'ten okur. */
(function () {
  'use strict';

  // ---------- SİSTEME ÖZEL AYARLAR (config.js) ----------
  // Bu dosya (dashboard.js) HER kurulumda AYNIDIR. Mağaza adı, hesap adları gibi kuruluma özel
  // her şey config.js içindeki window.TY_CONFIG'ten okunur — buraya ASLA isim/marka/e-posta yazma.
  const CFG = (typeof window !== 'undefined' && window.TY_CONFIG) || {};
  const APP_NAME = CFG.appName || 'Sipariş ve Ürün Takip';
  const DEF_ACCT = CFG.defaultAccount || 'Ana Hesap';
  const CFG_ACCOUNTS = Array.isArray(CFG.accounts) && CFG.accounts.length ? CFG.accounts : [DEF_ACCT];
  const CFG_PAYERS = Array.isArray(CFG.payers) && CFG.payers.length ? CFG.payers : [DEF_ACCT, 'Şirket'];
  function applyBranding() {
    try {
      document.title = APP_NAME;
      const h = document.getElementById('appTitle') || document.querySelector('#brandHome h1'); if (h) h.textContent = APP_NAME;
      const img = document.querySelector('#brandHome img.logo'); if (img) img.alt = CFG.brand || '';
    } catch (e) { /* marka gösterimi kritik değil */ }
  }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyBranding); else applyBranding(); }

  // ---------- küçük yardımcılar ----------
  const $ = (s, r = document) => r.querySelector(s);
  const pad = (n) => String(n).padStart(2, '0');
  const lc = (s) => String(s == null ? '' : s).toLocaleLowerCase('tr');
  const num = (v) => Number(v) || 0;
  const money = (n) => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(num(n));
  const moneyC = (n, c) => { try { return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: c || 'TRY' }).format(num(n)); } catch (e) { return money(n); } };
  const int = (n) => new Intl.NumberFormat('tr-TR').format(num(n));
  const fdate = (s) => (s ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : '');
  // Tarih + saat. DÜZELTME (Umit'in ekran görüntüsüyle doğruladığı): burada HİÇBİR saat dilimi
  // çevirisi YAPILMIYOR — depoda saklanan tarih metninin saat kısmı (HH:MM) fdate()'in tarih
  // kısmını okuduğu gibi olduğu gibi okunuyor. (Daha önce +3 saat eklemeyi denemiştim ama bu YANLIŞ
  // çıktı — Trendyol'un/depodaki saat zaten Türkiye saatiyle uyumluydu, üstüne +3 eklemek siparişleri
  // bir sonraki güne kaydırdı. fdate() zaten hep doğru günü gösteriyordu, o yüzden dokunmuyoruz.)
  const fdatetime = (s) => (s ? fdate(s) + ' ' + s.slice(11, 16) : '');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const serial = (s) => { if (!s) return null; const [y, m, d] = s.slice(0, 10).split('-').map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5); };

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) n.setAttribute(k, v);
    });
    kids.flat().forEach((c) => { if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  }
  const link = (url, text) => (/^https:\/\//.test(url || '') ? el('a', { href: url, target: '_blank', rel: 'noopener', text }) : document.createTextNode(text || ''));

  // ---------- durum grupları ----------
  // NOT: "durumu bilinmiyor" ayrı bir grup değil — Hazırlanıyor'a dahil edildi (kafa karıştırıyordu).
  // Bir kalemin GERÇEK durumu hâlâ "Bilinmiyor" olarak görünür (STATUS_TR / rozet metni), sadece
  // hangi gruba/karta sayıldığı Hazırlanıyor ile birleştirildi.
  const GROUPS = {
    delivered: { label: 'Teslim edildi', color: '#16a34a' },
    onway: { label: 'Yolda', color: '#2563eb' },
    preparing: { label: 'Hazırlanıyor', color: '#d97706' },
    closed: { label: 'İptal / İade', color: '#dc2626' },
  };
  const GMAP = { delivered: 'delivered', shipped: 'onway', in_transit: 'onway', out_for_delivery: 'onway', ordered: 'preparing', preparing: 'preparing', cancelled: 'closed', returned: 'closed' };
  const grp = (s) => GMAP[s] || 'preparing';
  const STATUS_TR = { delivered: 'Teslim edildi', shipped: 'Kargoya verildi', in_transit: 'Yolda', out_for_delivery: 'Dağıtımda', ordered: 'Sipariş alındı', preparing: 'Hazırlanıyor', cancelled: 'İptal', returned: 'İade', unknown: 'Bilinmiyor' };
  const badge = (status) => el('span', { class: 'badge g-' + grp(status), text: STATUS_TR[status] || 'Bilinmiyor' });

  // ---------- durum ----------
  let rows = [], stock = [], orders = [], expenses = [], invoices = [], sellerProfit = [], sellerOrders = [], sellerLastSync = null, me = null;
  let sellerSettlements = [], sellerOtherFin = [], sellerPayouts = [];
  let sellerSubtab = 'products';
  const SRF = { q: '', mode: null }; // Hakediş Raporu: sipariş no arama kutusu + kart tıklamasıyla açılan detay kategorisi
  const F = { from: '', to: '', brands: new Set(), sellers: new Set(), groups: new Set(), accounts: new Set(), sources: new Set(), q: '', services: false };
  const IF = { onlyUnchecked: true };
  const SF = { onlyMissing: false };
  const OF = { status: '', hideCancelled: false };
  const EF = { categories: new Set(), methods: new Set(), vendors: new Set(), q: '' };
  let activeTab = 'overview';
  let ovTab = 'buy';
  const charts = {};
  const multis = {};

  // ---------- veri ----------
  const WEB = typeof window !== 'undefined' && !!window.WebApi;      // web sitesi modu
  const call = async (msg) => {
    if (WEB) return window.WebApi.call(msg);
    const r = await chrome.runtime.sendMessage(msg);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Bağlantı hatası');
    return r.data;
  };
  const getAll = (path) => call({ type: 'API_ALL', path });

  function banner(msg) {
    const b = $('#banner');
    b.textContent = msg || '';
    b.classList.toggle('hide', !msg);
  }

  async function load() {
    banner('');
    $('#sub').textContent = 'Veriler yükleniyor…';
    try {
      const [r, s, o, ex, inv, sp, sl, so, se, of, po, who] = await Promise.all([
        getAll('/rest/v1/v_ty_order_items_report?select=*&order=order_date.desc.nullslast,order_no.desc,order_item_id'),
        getAll('/rest/v1/v_ty_product_stock?select=*&order=product_name,product_id'),
        getAll('/rest/v1/ty_orders?select=id,order_no,order_date,status,total_amount,subtotal,shipping_fee,item_count,package_count,order_url,last_synced_at,invoice_no,notes&order=order_date.desc.nullslast,id'),
        getAll('/rest/v1/expenses?select=*&order=expense_date.desc.nullslast,created_at.desc'),
        getAll('/rest/v1/v_ty_invoice_checklist?select=*&order=order_date.desc.nullslast').catch(() => []),
        getAll('/rest/v1/v_ty_seller_profitability?select=*&order=revenue.desc.nullslast').catch(() => []),
        getAll('/rest/v1/ty_seller_sync_log?select=*&order=ran_at.desc&limit=1').catch(() => []),
        getAll('/rest/v1/v_ty_seller_orders_detail?select=*&order=order_date.desc.nullslast').catch(() => []),
        // Hakediş Raporu: Trendyol'un ham hakediş (settlement) ve diğer kesinti (kargo/ceza/platform)
        // kayıtları — daha önce sadece ürün bazlı komisyon hesabında arka planda kullanılıyordu,
        // artık ayrı bir raporda da gösteriliyor.
        getAll('/rest/v1/ty_seller_settlements?select=*&order=transaction_date.desc').catch(() => []),
        getAll('/rest/v1/ty_seller_other_financials?select=*&order=transaction_date.desc').catch(() => []),
        // Gerçek ödemeler: Trendyol'un banka hesabına GERÇEKTEN aktardığı ("PAID") toplu ödeme
        // emirleri — hakediş kaydından farklı, "ne zaman ne kadar hesabıma yattı" sorusunun cevabı.
        getAll('/rest/v1/ty_seller_payouts?select=*&order=payout_date.desc').catch(() => []),
        me ? Promise.resolve(me) : call({ type: 'WHOAMI' }).catch(() => null),
      ]);
      rows = r; stock = s; orders = o; expenses = ex; invoices = inv || []; sellerProfit = sp || []; sellerLastSync = (sl && sl[0]) || null; sellerOrders = so || []; sellerSettlements = se || []; sellerOtherFin = of || []; sellerPayouts = po || []; me = who;
      const t = new Date();
      $('#sub').textContent = `${int(stock.length)} Ürün · ${int(orders.length)} Alış · ${int(sellerOrders.length)} Satış · güncelleme ${pad(t.getHours())}:${pad(t.getMinutes())}`;
      refreshOptions();
      renderAll();
    } catch (e) {
      $('#sub').textContent = '';
      const m = String(e.message || e);
      if (WEB && /Giriş yapılmamış|Oturum/.test(m)) { await window.WebApi.ready(); return load(); }
      banner(/Giriş yapılmamış|ayarlarını/.test(m) ? m + ' (Eklenti simgesine tıkla → giriş yap → tekrar aç.)' : 'Veri alınamadı: ' + m);
    }
  }

  // ---------- filtreler ----------
  const hay = (r) => lc([r.brand, r.product_name, r.order_no, r.seller_name, r.tracking_no, r.invoice_no, r.shipment_no].join(' '));
  function filteredRows() {
    const q = lc(F.q.trim());
    return rows.filter((r) =>
      (F.services || r.item_type !== 'service') &&
      (!F.from || (r.order_date && r.order_date >= F.from)) &&
      (!F.to || (r.order_date && r.order_date <= F.to)) &&
      (!F.brands.size || F.brands.has(r.brand || 'Markasız')) &&
      (!F.sellers.size || F.sellers.has(r.seller_name || 'Bilinmiyor')) &&
      (!F.groups.size || F.groups.has(grp(r.item_status))) &&
      (!F.accounts.size || F.accounts.has(r.buyer_account || DEF_ACCT)) &&
      (!F.sources.size || F.sources.has(r.order_source || 'trendyol')) &&
      (!q || hay(r).includes(q)));
  }
  function filteredStock() {
    const q = lc(F.q.trim());
    return stock.filter((p) =>
      (!F.brands.size || F.brands.has(p.brand || 'Markasız')) &&
      (!q || lc([p.brand, p.product_name].join(' ')).includes(q)));
  }

  // Stoktaki bir ürünün birim maliyeti: önce son 5 alımın ortalaması, yoksa son fiyat,
  // o da yoksa ömür boyu ortalama fiyat — "Ne Kazanırım?" simülasyonuyla AYNI sıralama.
  function stockUnitCost(p) {
    const v = p.recent_avg_price != null ? p.recent_avg_price : (p.last_unit_price != null ? p.last_unit_price : p.avg_unit_price);
    return v == null ? 0 : num(v);
  }
  function stockTotalValue(list) {
    return sumBy(list, (p) => Math.max(0, num(p.current_stock)) * stockUnitCost(p));
  }

  const expHay = (e) => lc([e.title, e.vendor, e.category, e.payment_method, e.notes].join(' '));
  function filteredExpenses() {
    const q = lc(EF.q.trim());
    return expenses.filter((e) =>
      (!F.from || (e.expense_date && e.expense_date >= F.from)) &&
      (!F.to || (e.expense_date && e.expense_date <= F.to)) &&
      (!EF.categories.size || EF.categories.has(e.category || 'Kategorisiz')) &&
      (!EF.methods.size || EF.methods.has(e.payment_method || 'Belirtilmemiş')) &&
      (!EF.vendors.size || EF.vendors.has(e.vendor || 'Belirtilmemiş')) &&
      (!q || expHay(e).includes(q)));
  }

  function multi(host, label, getOptions, set) {
    const d = el('details', { class: 'ms' });
    const sum = el('summary');
    const list = el('div', { class: 'ms-list' });
    d.append(sum, list);
    const upd = () => { sum.textContent = label + (set.size ? ` (${set.size})` : ' — hepsi'); };
    const draw = () => {
      list.replaceChildren();
      getOptions().forEach((o) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = set.has(o.value);
        cb.addEventListener('change', () => { cb.checked ? set.add(o.value) : set.delete(o.value); upd(); renderAll(); });
        list.append(el('label', {}, cb, o.label));
      });
      upd();
    };
    host.replaceChildren(d);
    draw();
    return { draw };
  }
  const uniq = (arr) => [...new Set(arr)].sort((a, b) => a.localeCompare(b, 'tr'));
  function refreshOptions() {
    multis.brand.draw(); multis.seller.draw(); multis.account.draw();
    if (multis.expCategory) { multis.expCategory.draw(); multis.expMethod.draw(); multis.expVendor.draw(); }
    populateSellerBrandOptions();
  }

  function setPreset(v) {
    const t = new Date();
    let from = '', to = '';
    if (v === 'today') from = iso(t);
    else if (v === 'yesterday') { const y = iso(new Date(t.getTime() - 864e5)); from = y; to = y; }
    else if (v === 'week') { const dow = (t.getDay() + 6) % 7; from = iso(new Date(t.getTime() - dow * 864e5)); }
    else if (v === 'month') from = iso(new Date(t.getFullYear(), t.getMonth(), 1));
    else if (v === 'lastmonth') { from = iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)); to = iso(new Date(t.getFullYear(), t.getMonth(), 0)); }
    else if (v === '30') from = iso(new Date(t.getTime() - 30 * 864e5));
    else if (v === '90') from = iso(new Date(t.getTime() - 90 * 864e5));
    else if (v === 'year') from = iso(new Date(t.getFullYear(), 0, 1));
    if (v !== 'custom') { F.from = from; F.to = to; $('#from').value = from; $('#to').value = to; }
    if ($('#preset')) $('#preset').value = v;
    document.querySelectorAll('#quickChips button').forEach((b) => b.classList.toggle('on', b.dataset.preset === v));
  }

  // ---------- özet / kartlar ----------
  function summarize(rs) {
    const g = {}; Object.keys(GROUPS).forEach((k) => { g[k] = { q: 0, t: 0 }; });
    const os = new Set(), ps = new Set();
    rs.forEach((r) => {
      const k = grp(r.item_status);
      g[k].q += num(r.quantity); g[k].t += num(r.line_total);
      if (k !== 'closed') { os.add(r.order_no); ps.add(r.product_id); }
    });
    const tq = g.delivered.q + g.onway.q + g.preparing.q;
    const tt = g.delivered.t + g.onway.t + g.preparing.t;
    return { g, tq, tt, orders: os.size, products: ps.size, avg: tq ? tt / tq : 0 };
  }

  function renderCards(rs) {
    const s = summarize(rs);
    const listFor = (k) => rs.filter((r) => (k === 'all' ? grp(r.item_status) !== 'closed' : grp(r.item_status) === k));
    const card = (cls, lbl, q, t, sub, onClick) => el('div', { class: 'card clickable ' + cls, title: 'Detay listesi için tıkla', onclick: onClick },
      el('div', { class: 'lbl', text: lbl }), el('div', { class: 'big', text: int(q) + ' adet' }),
      el('div', { class: 'money', text: money(t) }), el('div', { class: 'sub', text: sub || '' }));
    const share = (k) => (s.tq ? Math.round((s.g[k].q / s.tq) * 100) + '% (toplamın)' : '');
    $('#cards').replaceChildren(
      card('total', 'Toplam satın alınan', s.tq, s.tt, `${int(s.orders)} sipariş · ${int(s.products)} farklı ürün`,
        () => openItemListModal('Toplam satın alınan', listFor('all'))),
      card('delivered', 'Teslim edildi', s.g.delivered.q, s.g.delivered.t, share('delivered'),
        () => openItemListModal('Teslim edildi', listFor('delivered'))),
      card('onway', 'Yolda (kargoda)', s.g.onway.q, s.g.onway.t, share('onway'),
        () => openItemListModal('Yolda (kargoda)', listFor('onway'))),
      card('preparing', 'Hazırlanıyor', s.g.preparing.q, s.g.preparing.t, share('preparing'),
        () => openItemListModal('Hazırlanıyor', listFor('preparing'))),
      card('closed', 'İptal / İade', s.g.closed.q, s.g.closed.t, 'toplama dahil değil',
        () => openItemListModal('İptal / İade', listFor('closed'))),
      el('div', { class: 'card clickable', title: 'Detay listesi için tıkla', onclick: () => openItemListModal('Toplam satın alınan', listFor('all')) },
        el('div', { class: 'lbl', text: 'Ortalama birim fiyat' }),
        el('div', { class: 'big', text: money(s.avg) }), el('div', { class: 'sub', text: 'iptal/iade hariç' })),
      el('div', { class: 'card clickable', title: 'Detay listesi için tıkla', onclick: () => openItemListModal('Toplam satın alınan', listFor('all')) },
        el('div', { class: 'lbl', text: 'Ortalama sipariş tutarı' }),
        el('div', { class: 'big', text: money(s.orders ? s.tt / s.orders : 0) }), el('div', { class: 'sub', text: `${int(s.orders)} sipariş üzerinden` })),
      el('div', { class: 'card clickable', title: 'Detay için Ürün & Stok sekmesine git', onclick: () => { activeTab = 'stock'; renderAll(); } },
        el('div', { class: 'lbl', text: 'Stoğumdaki Ürünlerin Toplam Maliyeti' }),
        el('div', { class: 'big', text: money(stockTotalValue(stock)) }),
        el('div', { class: 'sub', text: `${int(stock.filter((p) => num(p.current_stock) > 0).length)} ürün · son 5 alım ort. / son fiyat / ort. fiyat üzerinden` })));
  }

  function openItemListModal(title, items) {
    const modal = $('#modal');
    const host = el('div', {});
    modal.replaceChildren(el('div', { class: 'mbox wide' },
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px' },
        el('h2', { text: title, style: 'margin:0' }),
        el('button', { class: 'btn sm', text: 'Kapat', onclick: closeModal })),
      host));
    modal.classList.remove('hide');
    makeTable(host, itemModalCols, () => items, { sortKey: 'order_date', sortDir: -1, empty: 'Kayıt yok',
      summary: (d) => `${int(d.length)} kalem · ${int(sumBy(d, (r) => r.quantity))} adet · ${money(sumBy(d, (r) => r.line_total))}` }).render();
  }

  // ---------- grafikler ----------
  const groupBy = (arr, fn) => { const m = new Map(); arr.forEach((r) => { const k = fn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }); return m; };
  const sumBy = (arr, f) => arr.reduce((a, r) => a + num(f(r)), 0);

  function drawChart(id, cfg) {
    const host = $('#' + id);
    if (!host) return; // eski önbelleğe alınmış HTML'de bu canvas yoksa sessizce atla
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(host, cfg);
  }

  function renderCharts(rs) {
    if (typeof Chart === 'undefined') return;
    Chart.defaults.font.family = 'system-ui, sans-serif';
    const act = rs.filter((r) => grp(r.item_status) !== 'closed');
    const base = { responsive: true, maintainAspectRatio: false };
    const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

    // aylık
    const mm = groupBy(act, (r) => r.order_month || 'Tarihsiz');
    const months = [...mm.keys()].sort();
    drawChart('cMonthly', { type: 'bar',
      data: { labels: months.map((k) => (/^\d{4}-\d{2}$/.test(k) ? k.slice(5) + '.' + k.slice(0, 4) : k)),
        datasets: [{ label: 'Harcama', data: months.map((k) => sumBy(mm.get(k), (r) => r.line_total)), backgroundColor: '#f27a1a', borderRadius: 6 }] },
      options: { ...base, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + money(c.parsed.y) } } } } });

    // durum (adet)
    const keys = Object.keys(GROUPS).filter((k) => rs.some((r) => grp(r.item_status) === k));
    drawChart('cStatus', { type: 'doughnut',
      data: { labels: keys.map((k) => GROUPS[k].label), datasets: [{ data: keys.map((k) => sumBy(rs.filter((r) => grp(r.item_status) === k), (r) => r.quantity)), backgroundColor: keys.map((k) => GROUPS[k].color) }] },
      options: { ...base, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${int(c.parsed)} adet` } } } } });

    // marka
    const bm = [...groupBy(act, (r) => r.brand || 'Markasız').entries()].map(([k, v]) => [k, sumBy(v, (r) => r.line_total)]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    drawChart('cBrand', { type: 'bar',
      data: { labels: bm.map((x) => trunc(x[0], 26)), datasets: [{ data: bm.map((x) => x[1]), backgroundColor: '#2563eb', borderRadius: 6 }] },
      options: { ...base, indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + money(c.parsed.x) } } } } });

    // hesap bazlı (config.js'teki hesap adları)
    const am = [...groupBy(act, (r) => r.buyer_account || 'Diğer').entries()].map(([k, v]) => [k, sumBy(v, (r) => r.line_total)]).sort((a, b) => b[1] - a[1]);
    drawChart('cAccount', { type: 'doughnut',
      data: { labels: am.map((x) => x[0]), datasets: [{ data: am.map((x) => x[1]), backgroundColor: ['#f27a1a', '#2563eb', '#16a34a', '#d97706', '#7c3aed'] }] },
      options: { ...base, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${money(c.parsed)}` } } } } });

    // ürün (adet)
    const pm = [...groupBy(act, (r) => r.product_id).entries()].map(([, v]) => [v[0].product_name, sumBy(v, (r) => r.quantity)]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    drawChart('cProducts', { type: 'bar',
      data: { labels: pm.map((x) => trunc(x[0], 34)), datasets: [{ data: pm.map((x) => x[1]), backgroundColor: '#16a34a', borderRadius: 6 }] },
      options: { ...base, indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${int(c.parsed.x)} adet` } } } } });

    // ---- mağaza satışları (Trendyol'a satılan — üstteki tarih filtresi burayı da etkiler) ----
    const so = sellerOrders.filter((r) => {
      const d = r.order_date ? String(r.order_date).slice(0, 10) : '';
      return (!F.from || (d && d >= F.from)) && (!F.to || (d && d <= F.to));
    });
    const soCards = $('#storeSalesCards');
    if (soCards) {
      // Siparişler sekmesi/Mağaza & Karlılık ile BİREBİR aynı hesap yöntemi (profitAgg) — üç yerde de
      // aynı rakamlar görünsün diye. Karta tıklayınca detaylı "Siparişler" sekmesine gidiyor.
      const active = so.filter((r) => !isCancelledOrder(r));
      const activeGross = sumBy(active, (r) => r.gross_amount);
      const allGross = sumBy(so, (r) => r.gross_amount);
      const agg = profitAgg(so);
      const goToOrders = () => { activeTab = 'storeOrders'; renderAll(); };
      const sc = (cls, lbl, big, sub) => el('div', { class: 'card clickable ' + cls, title: 'Detay için Siparişler sekmesine git', onclick: goToOrders },
        el('div', { class: 'lbl', text: lbl }), el('div', { class: 'big', text: big }), el('div', { class: 'sub', text: sub || '' }));
      soCards.replaceChildren(
        sc('total', 'Toplam Mağaza Satışı (İptaller Hariç)', money(activeGross), `${int(active.length)} sipariş · ${int(sumBy(active, (r) => r.qty))} adet`),
        sc('preparing', 'Toplam Mağaza Satışı (İptaller Dahil)', money(allGross), `${int(so.length)} sipariş · ${int(sumBy(so, (r) => r.qty))} adet`),
        sc('onway', 'Toplam Komisyon', money(-agg.commission), 'sipariş anında kesinleşen oran'),
        sc('preparing', 'Toplam Giderler', money(-agg.allDeductions), 'kargo+ceza+platform+stopaj+diğer'),
        sc('onway', 'Toplam Ürün Maliyeti', money(agg.cost), 'FİFO (alım sırasına göre); veri yoksa son alımların ortalaması'),
        sc(agg.netEstimated < 0 ? 'closed' : 'delivered', 'Tahmini Net Kâr', money(agg.netEstimated), 'satış − (komisyon+giderler+ürün maliyeti)'));
    }
    const smm = groupBy(so, (r) => (r.order_date ? String(r.order_date).slice(0, 7) : 'Tarihsiz'));
    const smonths = [...smm.keys()].sort();
    drawChart('cStoreSales', { type: 'bar',
      data: { labels: smonths.map((k) => (/^\d{4}-\d{2}$/.test(k) ? k.slice(5) + '.' + k.slice(0, 4) : k)),
        datasets: [
          { label: 'Brüt satış', data: smonths.map((k) => sumBy(smm.get(k), (r) => r.gross_amount)), backgroundColor: '#f27a1a', borderRadius: 6 },
          { label: 'Tahmini Net Kâr', data: smonths.map((k) => profitAgg(smm.get(k)).netEstimated), backgroundColor: '#16a34a', borderRadius: 6 },
        ] },
      options: { ...base, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${money(c.parsed.y)}` } } } } });

    // marka bazlı mağaza satışı (ürün bazlı kârlılık verisinden — ciro)
    const sbm = [...groupBy(sellerProfit, (r) => r.brand || 'Markasız').entries()].map(([k, v]) => [k, sumBy(v, (r) => r.revenue)]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    drawChart('cStoreBrand', { type: 'bar',
      data: { labels: sbm.map((x) => trunc(x[0], 26)), datasets: [{ data: sbm.map((x) => x[1]), backgroundColor: '#f27a1a', borderRadius: 6 }] },
      options: { ...base, indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + money(c.parsed.x) } } } } });

    const sLabel = { delivered: 'Teslim edildi', onway: 'Yolda/Kargoda', preparing: 'Hazırlanıyor', closed: 'İptal/İade', unknown: 'Bilinmiyor' };
    const sColor = { delivered: '#16a34a', onway: '#2563eb', preparing: '#d97706', closed: '#dc2626', unknown: '#6b7280' };
    const skeys = Object.keys(sLabel).filter((k) => so.some((r) => sellerStatusGroup(r.status) === k));
    drawChart('cStoreStatus', { type: 'doughnut',
      data: { labels: skeys.map((k) => sLabel[k]), datasets: [{ data: skeys.map((k) => so.filter((r) => sellerStatusGroup(r.status) === k).length), backgroundColor: skeys.map((k) => sColor[k]) }] },
      options: { ...base, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${int(c.parsed)} sipariş` } } } } });
  }

  // ---------- genel tablo bileşeni ----------
  const PAGE = 50;
  function makeTable(host, cols, getData, opts) {
    const st = { key: opts.sortKey, dir: opts.sortDir || -1, page: 0 };
    function render() {
      if (!host) return; // eski (önbelleğe alınmış) HTML'de bu tablo elemanı yoksa sessizce atla
      let data = getData().slice();
      const col = cols.find((c) => c.key === st.key);
      if (col && col.sort) {
        data.sort((a, b) => {
          const x = col.sort(a), y = col.sort(b);
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          const c = typeof x === 'string' ? x.localeCompare(y, 'tr') : (x < y ? -1 : x > y ? 1 : 0);
          return c * st.dir;
        });
      }
      const pages = Math.max(1, Math.ceil(data.length / PAGE));
      st.page = Math.min(st.page, pages - 1);
      const slice = data.slice(st.page * PAGE, st.page * PAGE + PAGE);

      const pager = el('div', { class: 'pager' },
        el('button', { class: 'btn sm', text: '‹', onclick: () => { st.page = Math.max(0, st.page - 1); render(); } }),
        `${data.length ? st.page * PAGE + 1 : 0}–${Math.min(data.length, (st.page + 1) * PAGE)} / ${int(data.length)}`,
        el('button', { class: 'btn sm', text: '›', onclick: () => { st.page = Math.min(pages - 1, st.page + 1); render(); } }));
      const info = el('div', { class: 'tinfo' }, el('div', { text: opts.summary ? opts.summary(data) : '' }), pager);

      const thead = el('tr', {}, cols.map((c) => el('th', {
        class: c.num ? 'num' : '', text: c.label + (st.key === c.key ? (st.dir > 0 ? ' ▲' : ' ▼') : ''),
        title: c.title || '',
        onclick: () => { if (!c.sort) return; if (st.key === c.key) st.dir *= -1; else { st.key = c.key; st.dir = c.num ? -1 : 1; } st.page = 0; render(); },
      })));
      const tbody = el('tbody', {}, slice.map((r) => el('tr', { class: opts.rowClass ? opts.rowClass(r) : '' }, cols.map((c) => el('td', { class: c.num ? 'num' : '' }, c.cell(r))))));
      const body = data.length ? el('div', { class: 'twrap' }, el('table', {}, el('thead', {}, thead), tbody)) : el('div', { class: 'empty', text: opts.empty || 'Kayıt yok' });
      host.replaceChildren(info, body);
    }
    return { render };
  }

  const thumb = (u) => { if (!/^https:\/\//.test(u || '')) return el('span'); const i = el('img', { src: u, referrerpolicy: 'no-referrer', loading: 'lazy' }); i.addEventListener('error', () => { i.style.visibility = 'hidden'; }); return i; };
  const T = (f) => (r) => f(r) || '';

  const itemCols = [
    { key: 'order_date', label: 'Tarih', sort: (r) => r.order_date, cell: (r) => fdate(r.order_date) },
    { key: 'order_no', label: 'Sipariş No', sort: (r) => r.order_no, cell: (r) => link(r.order_url, r.order_no) },
    { key: 'buyer_account', label: 'Hesap', sort: (r) => r.buyer_account, cell: T((r) => r.buyer_account) },
    { key: 'seller_name', label: 'Satıcı', sort: (r) => r.seller_name, cell: T((r) => r.seller_name) },
    { key: 'brand', label: 'Marka', sort: (r) => r.brand, cell: T((r) => r.brand) },
    { key: 'product_name', label: 'Ürün', sort: (r) => r.product_name, cell: (r) => el('div', { class: 'prod' }, thumb(r.image_url), link(r.product_url, r.product_name)) },
    { key: 'variant', label: 'Varyant', sort: (r) => r.variant, cell: T((r) => r.variant) },
    { key: 'quantity', label: 'Adet', num: true, sort: (r) => num(r.quantity), cell: (r) => int(r.quantity) },
    { key: 'unit_price', label: 'Birim fiyat', num: true, sort: (r) => num(r.unit_price), cell: (r) => money(r.unit_price) },
    { key: 'line_total', label: 'Toplam', num: true, sort: (r) => num(r.line_total), cell: (r) => money(r.line_total) },
    { key: 'item_status', label: 'Durum', sort: (r) => STATUS_TR[r.item_status] || '', cell: (r) => badge(r.item_status) },
    { key: 'tracking_no', label: 'Takip No', sort: (r) => r.tracking_no, cell: T((r) => r.tracking_no) },
    { key: 'shipment_no', label: 'Teslimat No', sort: (r) => r.shipment_no, cell: T((r) => r.shipment_no) },
  ];
  // Genel Bakış kartlarındaki "detay listesi" modalında kullanılan, daha kompakt sütun seti
  const itemModalCols = itemCols.filter((c) => ['order_date', 'order_no', 'brand', 'product_name', 'quantity', 'line_total', 'item_status'].includes(c.key));

  function orderRows(rs) {
    const om = new Map(orders.map((o) => [o.id, o]));
    return [...groupBy(rs, (r) => r.order_id).entries()].map(([id, items]) => {
      const o = om.get(id) || {};
      return { order_id: id, order_no: items[0].order_no, order_date: items[0].order_date, order_url: items[0].order_url,
        sellers: uniq(items.map((i) => i.seller_name).filter(Boolean)).join(', '),
        shipmentNos: uniq(items.map((i) => i.shipment_no).filter(Boolean)).join(', '),
        qty: sumBy(items, (i) => i.quantity), itemsTotal: sumBy(items, (i) => i.line_total),
        paid: o.total_amount, g: summarize(items).g, synced: o.last_synced_at,
        account: items[0].buyer_account, source: items[0].order_source || 'trendyol',
        invoiceNo: o.invoice_no || items[0].invoice_no, notes: o.notes || items[0].order_notes };
    });
  }
  const orderCols = [
    { key: 'order_date', label: 'Tarih', sort: (r) => r.order_date, cell: (r) => fdate(r.order_date) },
    { key: 'order_no', label: 'Sipariş No', sort: (r) => r.order_no, cell: (r) => link(r.order_url, r.order_no) },
    { key: 'account', label: 'Hesap', sort: (r) => r.account, cell: T((r) => r.account) },
    { key: 'source', label: 'Kaynak', sort: (r) => r.source, cell: (r) => el('span', { class: 'badge ' + (r.source === 'manual' ? 'g-preparing' : 'g-onway'), text: r.source === 'manual' ? 'Manuel' : 'Trendyol' }) },
    { key: 'invoiceNo', label: 'Fatura No', sort: (r) => r.invoiceNo, cell: (r) => r.invoiceNo || '' },
    { key: 'shipmentNos', label: 'Teslimat No', sort: (r) => r.shipmentNos, cell: (r) => r.shipmentNos || '' },
    { key: 'sellers', label: 'Satıcılar', sort: (r) => r.sellers, cell: (r) => r.sellers },
    { key: 'qty', label: 'Adet', num: true, sort: (r) => r.qty, cell: (r) => int(r.qty) },
    { key: 'itemsTotal', label: 'Kalem tutarı', num: true, sort: (r) => r.itemsTotal, cell: (r) => money(r.itemsTotal) },
    { key: 'paid', label: 'Ödenen toplam', num: true, sort: (r) => (r.paid == null ? null : num(r.paid)), cell: (r) => (r.paid == null ? '' : money(r.paid)) },
    { key: 'g', label: 'Durum', sort: (r) => r.g.delivered.q, cell: (r) => el('div', {}, ['delivered', 'onway', 'preparing', 'closed'].filter((k) => r.g[k].q > 0)
        .map((k) => el('span', { class: 'badge g-' + k, text: `${r.g[k].q} ${GROUPS[k].label.toLocaleLowerCase('tr')}` }))) },
    { key: 'act', label: '', cell: (r) => el('div', { class: 'acts' },
        r.source === 'manual' && r.g.onway.q + r.g.preparing.q > 0 ? el('button', { class: 'btn sm', text: 'Teslim aldım', onclick: () => markDelivered(r) }) : null,
        r.source === 'manual' ? el('button', { class: 'btn sm', text: 'Düzenle', title: 'Tarih / Fatura no / Not düzenle', onclick: () => openEditManualOrderModal(r) }) : null,
        r.source === 'trendyol' ? el('button', { class: 'btn sm', text: 'Yoksay', title: 'Sil + bir daha hiç kaydetme', onclick: () => ignoreOrder(r) }) : null,
        el('button', { class: 'btn sm danger', text: 'Sil', onclick: () => deleteOrder(r) })) },
  ];

  const stockCols = [
    { key: 'brand', label: 'Marka', sort: (r) => r.brand, cell: T((r) => r.brand) },
    { key: 'product_name', label: 'Ürün', sort: (r) => r.product_name, cell: (r) => el('div', { class: 'prod' }, thumb(r.image_url), link(r.product_url, r.product_name)) },
    { key: 'current_stock', label: 'Mevcut stok', num: true, sort: (r) => num(r.current_stock), cell: (r) => el('span', { class: r.low_stock ? 'low' : '', text: int(r.current_stock) + (r.low_stock ? ' ⚠' : '') }) },
    { key: 'on_the_way_qty', label: 'Yolda', num: true, sort: (r) => num(r.on_the_way_qty), cell: (r) => int(r.on_the_way_qty) },
    { key: 'pending_qty', label: 'Hazırlanıyor', num: true, sort: (r) => num(r.pending_qty), cell: (r) => (num(r.pending_qty)
        ? el('span', { class: 'badge g-preparing', title: 'Sipariş durumu Trendyol\'dan henüz netleşmemiş (Bekleyen Siparişleri Güncelle ile tekrar tarandığında teslim/yolda\'ya geçer)', text: int(r.pending_qty) })
        : '0') },
    { key: 'delivered_qty', label: 'Teslim alınan', num: true, sort: (r) => num(r.delivered_qty), cell: (r) => int(r.delivered_qty) },
    { key: 'manual_qty', label: 'Manuel', num: true, sort: (r) => num(r.manual_qty), cell: (r) => int(r.manual_qty) },
    { key: 'seller_sold_qty', label: 'Mağaza satışı', num: true, sort: (r) => num(r.seller_sold_qty), cell: (r) => (num(r.seller_sold_qty) ? el('span', { title: 'Trendyol mağazandan satılıp otomatik düşülen adet', text: '−' + int(r.seller_sold_qty) }) : '0') },
    { key: 'total_spent', label: 'Toplam harcama', num: true, sort: (r) => num(r.total_spent), cell: (r) => money(r.total_spent) },
    { key: 'avg_unit_price', label: 'Ort. fiyat', num: true, sort: (r) => (r.avg_unit_price == null ? null : num(r.avg_unit_price)), cell: (r) => (r.avg_unit_price == null ? '' : money(r.avg_unit_price)) },
    { key: 'last_unit_price', label: 'Son fiyat', num: true, sort: (r) => (r.last_unit_price == null ? null : num(r.last_unit_price)), cell: (r) => (r.last_unit_price == null ? '' : money(r.last_unit_price)) },
    { key: 'recent_avg_price', label: 'Son 5 Alım Ort.', num: true, sort: (r) => (r.recent_avg_price == null ? null : num(r.recent_avg_price)), cell: (r) => (r.recent_avg_price == null ? '' : el('span', { title: r.recent_n ? `son ${int(r.recent_n)} alımın ortalaması` : '', text: money(r.recent_avg_price) })) },
    { key: 'order_count', label: 'Sipariş', num: true, sort: (r) => num(r.order_count), cell: (r) => int(r.order_count) },
    { key: 'last_order_date', label: 'Son sipariş', sort: (r) => r.last_order_date, cell: (r) => fdate(r.last_order_date) },
    { key: 'price_sim', label: 'Ne Kazanırım?', cell: (r) => el('button', { class: 'icon-btn', title: 'Bu ürünü bir fiyattan satarsan ne kadar kazanırsın, hesapla', onclick: () => openPriceSimModal({
        product_name: r.product_name, barcode: r.product_id,
        cost_price: r.recent_avg_price != null ? r.recent_avg_price : (r.last_unit_price != null ? r.last_unit_price : r.avg_unit_price),
        sale_price: null, revenue: null, commission_total: null,
      }) }, '🧮') },
    { key: 'act', label: '', cell: (r) => el('button', { class: 'btn sm', text: 'Stok hareketi', onclick: () => openStockModal(r) }) },
  ];

  const expenseCols = [
    { key: 'expense_date', label: 'Tarih', sort: (r) => r.expense_date, cell: (r) => fdate(r.expense_date) },
    { key: 'title', label: 'Başlık', sort: (r) => r.title, cell: T((r) => r.title) },
    { key: 'category', label: 'Kategori', sort: (r) => r.category, cell: (r) => (r.category ? el('span', { class: 'badge g-unknown', text: r.category }) : '') },
    { key: 'vendor', label: 'Ödenen Kurum', sort: (r) => r.vendor, cell: T((r) => r.vendor) },
    { key: 'payment_method', label: 'Ödeme Yöntemi', sort: (r) => r.payment_method, cell: T((r) => r.payment_method) },
    { key: 'paid_by', label: 'Ödeyen', sort: (r) => r.paid_by, cell: T((r) => r.paid_by) },
    { key: 'amount', label: 'Tutar', num: true, sort: (r) => num(r.amount), cell: (r) => moneyC(r.amount, r.currency) },
    { key: 'receipt_url', label: 'Fiş', cell: (r) => (/^https:\/\//.test(r.receipt_url || '') ? link(r.receipt_url, 'Görüntüle') : '') },
    { key: 'notes', label: 'Not', sort: (r) => r.notes, cell: (r) => el('span', { title: r.notes || '', text: r.notes && r.notes.length > 28 ? r.notes.slice(0, 27) + '…' : (r.notes || '') }) },
    { key: 'act', label: '', cell: (r) => el('div', { class: 'acts' },
        el('button', { class: 'btn sm', text: 'Düzenle', onclick: () => openExpenseModal(r) }),
        el('button', { class: 'btn sm danger', text: 'Sil', onclick: () => deleteExpense(r) })) },
  ];

  // ---------- fatura kontrol listesi (her satır = bir PAKET/satıcı, elle işaretlenir) ----------
  function filteredInvoices() {
    return invoices.filter((v) => v.has_invoice_button && (!IF.onlyUnchecked || !v.invoice_checked));
  }
  async function toggleInvoiceChecked(v, checked) {
    try {
      await call({ type: 'API', method: 'POST', path: '/rest/v1/rpc/ty_set_invoice_checked', body: { p_shipment_id: v.shipment_id, p_checked: checked } });
      v.invoice_checked = checked;
      v.invoice_checked_at = checked ? new Date().toISOString() : null;
      renderActive(filteredRows());
    } catch (e) { banner('Kaydedilemedi: ' + e.message); }
  }
  async function editInvoiceNote(v) {
    const note = prompt('Not (ör. indirdiğin dosya adı ya da fatura linki):', v.invoice_note || '');
    if (note == null) return;
    try {
      await call({ type: 'API', method: 'POST', path: '/rest/v1/rpc/ty_set_invoice_checked', body: { p_shipment_id: v.shipment_id, p_checked: v.invoice_checked, p_note: note } });
      v.invoice_note = note;
      renderActive(filteredRows());
    } catch (e) { banner('Kaydedilemedi: ' + e.message); }
  }
  const invoiceCols = [
    { key: 'order_date', label: 'Tarih', sort: (r) => r.order_date, cell: (r) => fdate(r.order_date) },
    { key: 'order_no', label: 'Sipariş No', sort: (r) => r.order_no, cell: (r) => link(r.order_url, r.order_no) },
    { key: 'seller_name', label: 'Satıcı', sort: (r) => r.seller_name, cell: T((r) => r.seller_name) },
    { key: 'shipment_status', label: 'Paket durumu', sort: (r) => STATUS_TR[r.shipment_status] || '', cell: (r) => badge(r.shipment_status) },
    { key: 'invoice_note', label: 'Not', sort: (r) => r.invoice_note, cell: (r) => el('span', { class: 'editable', title: 'Not eklemek/değiştirmek için tıkla', text: r.invoice_note || '—', onclick: () => editInvoiceNote(r) }) },
    { key: 'invoice_checked', label: 'Kontrol ettim', cell: (r) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = !!r.invoice_checked;
        cb.addEventListener('change', () => toggleInvoiceChecked(r, cb.checked));
        return el('label', { class: 'chk-inline' }, cb, r.invoice_checked_at ? fdate(r.invoice_checked_at.slice(0, 10)) : '');
      } },
  ];

  // ---------- mağaza & karlılık (satıcı hesabı, salt-okunur senkron) ----------
  const normTxt = (s) => lc(s || '').replace(/[^a-z0-9ığüşöçİĞÜŞÖÇ ]/gi, '').trim();
  // İsim/marka benzerliğine göre alıcı geçmişinden en olası eşleşmeyi önerir (kelime örtüşmesi).
  // Otomatik UYGULANMAZ — sadece öneri olarak gösterilir, sen onaylarsın.
  // ÖNEMLİ: marka eşleşmesi ZORUNLU tutuluyor. Kozmetik ürün adları çoğunlukla ortak pazarlama
  // kelimeleri içeriyor ("nemlendirici", "gözenek sıklaştırıcı", "canlandırıcı" vb.) — marka
  // kontrolü olmadan bu kelimeler farklı markaların ürünlerini yanlışlıkla eşleştirebiliyordu
  // (gerçek örnek: KOREACO "Aha & Bha ... Gözenek Sıklaştırıcı Nemlendirici" ile VULLY
  // "... Nemlendirici Gözenek Sıklaştırıcı Yüz Temizleme Jeli" yanlış eşleşmişti).
  function suggestBuyerMatch(r) {
    const targetWords = new Set(normTxt(r.product_name).split(/\s+/).filter((w) => w.length > 2));
    if (!targetWords.size) return null;
    const targetBrand = normTxt(r.brand || '');
    let best = null, bestScore = 0, bestOverlap = 0;
    stock.forEach((p) => {
      const pBrand = normTxt(p.brand || '');
      // Her iki tarafta da marka bilgisi varsa birebir uyuşmalı; biri boşsa isim benzerliğine güveniyoruz.
      if (targetBrand && pBrand && targetBrand !== pBrand) return;
      const words = new Set(normTxt([p.brand, p.product_name].join(' ')).split(/\s+/).filter((w) => w.length > 2));
      if (!words.size) return;
      let overlap = 0; targetWords.forEach((w) => { if (words.has(w)) overlap += 1; });
      const score = overlap / Math.max(targetWords.size, words.size);
      if (score > bestScore) { bestScore = score; best = p; bestOverlap = overlap; }
    });
    // Hem oran (%55+) hem de en az 3 ortak kelime şartı — kısa/az kelimeli genel eşleşmeleri eler.
    return (bestScore >= 0.55 && bestOverlap >= 3) ? best : null;
  }
  async function editProductCost(r) {
    const v = prompt(`"${r.product_name || r.barcode}" için birim maliyet (₺) — elle girersen alıcı geçmişinden gelen otomatik değerin önüne geçer:`, r.manual_cost_price != null ? String(r.manual_cost_price) : '');
    if (v == null) return;
    const cost = parseFloat(String(v).replace(',', '.'));
    if (!Number.isFinite(cost) || cost < 0) return banner('Geçerli bir maliyet gir.');
    try {
      await call({ type: 'API', method: 'POST', path: '/rest/v1/rpc/ty_set_product_cost', body: { p_barcode: r.barcode, p_cost: cost } });
      await load();
    } catch (e) { banner('Kaydedilemedi: ' + e.message); }
  }
  async function linkSellerCost(r, buyerProductId) {
    try {
      await call({ type: 'API', method: 'POST', path: '/rest/v1/rpc/ty_link_seller_cost', body: { p_barcode: r.barcode, p_buyer_product_id: buyerProductId } });
      await load();
    } catch (e) { banner('Bağlanamadı: ' + e.message); }
  }
  async function unlinkSellerCost(r) {
    if (!confirm(`"${r.product_name || r.barcode}" için alıcı geçmişi bağlantısı kaldırılsın mı?\n(Yanlış ürüne bağlıysa stoktan yanlış düşüm ve yanlış maliyet hesabı durur.)`)) return;
    await linkSellerCost(r, null);
  }
  async function editPackQty(r) {
    const v = prompt(`"${r.product_name || r.barcode}" — bu satıcı ürünü, bağlı olduğu alıcı ürününden kaç adet içeriyor?\n(Tekli satıyorsan 1, 2'li set satıyorsan 2 yaz vs. — stok düşümü ve maliyet buna göre çarpılır.)`, r.pack_qty != null ? String(r.pack_qty) : '1');
    if (v == null) return;
    const n = parseInt(v, 10);
    if (!Number.isInteger(n) || n < 1) return banner('Geçerli bir paket adedi gir (1 veya üzeri).');
    try {
      await call({ type: 'API', method: 'POST', path: '/rest/v1/rpc/ty_set_seller_pack_qty', body: { p_barcode: r.barcode, p_pack_qty: n } });
      await load();
    } catch (e) { banner('Kaydedilemedi: ' + e.message); }
  }
  async function relinkSellerCost(r) {
    const q = prompt(`"${r.product_name}" için alıcı geçmişinde ara (ürün adı ya da marka yaz):`, '');
    if (q == null) return;
    const qq = normTxt(q);
    if (!qq) return;
    const matches = stock.filter((p) => normTxt([p.brand, p.product_name].join(' ')).includes(qq)).slice(0, 15);
    if (!matches.length) return banner('Alıcı geçmişinde eşleşme bulunamadı.');
    let chosen = matches[0];
    if (matches.length > 1) {
      const list = matches.map((p, i) => `${i + 1}) ${p.brand || ''} ${p.product_name} — ortalama alış fiyatı ${money(p.avg_unit_price)}`).join('\n');
      const idx = prompt(`Birden fazla eşleşme bulundu, numarasını yaz:\n${list}`, '1');
      const n = parseInt(idx, 10);
      if (!Number.isInteger(n) || n < 1 || n > matches.length) return;
      chosen = matches[n - 1];
    }
    await linkSellerCost(r, chosen.product_id);
  }
  // ---------- fiyat simülasyonu: "bu fiyattan satarsam ne kadar kazanırım?" ----------
  // Ürünün kendi geçmiş gerçek satışlarından çıkardığımız ORTALAMA komisyon oranını kullanıyoruz
  // (commission_total / revenue) — geçmişi yoksa genel %15,40 varsayımına düşülüyor (SQL'deki v7/v8
  // mantığıyla aynı fikir). Platform hizmet bedeli (13,19₺) ve stopaj (%1) da diğer hesaplarla
  // birebir aynı sabitler; kargo tahmini de dashboard'un başka yerlerinde kullandığı aynı kademeli
  // tarife (0-199,99->47, 200-349,99->85, 350+->98). Hepsi TAHMİNİ — gerçek oran/kargo bedeli
  // Trendyol'dan geldiğinde değişebilir, bu yüzden popup'ta açıkça "tahmini" ibaresi var.
  function estCommissionRatePct(r) {
    if (r.revenue && r.commission_total != null && num(r.revenue) > 0) {
      return (num(r.commission_total) / num(r.revenue)) * 100;
    }
    return 15.40;
  }
  function cargoTierFor(price) {
    if (price == null || !Number.isFinite(price)) return 0;
    if (price < 200) return 47;
    if (price < 350) return 85;
    return 98;
  }
  function openPriceSimModal(r) {
    const modal = $('#modal');
    const autoCost = r.cost_price != null ? num(r.cost_price) : null;

    // Her alan "otomatik" (fiyata/geçmişe göre hesaplanan) veya "manuel" (kullanıcının elle
    // değiştirdiği, artık fiyat değişse de SABİT kalan) olabilir — dirty=true olan alanlara
    // fiyat değiştiğinde dokunulmuyor, sadece "Otomatiğe Dön" bunları sıfırlıyor.
    const dirty = { rate: false, cargo: false, platform: false, stopajRate: false, cost: false };

    const priceInput = el('input', { type: 'number', step: '0.01', min: '0' });
    priceInput.value = r.sale_price != null ? String(r.sale_price) : '';
    const rateInput = el('input', { type: 'number', step: '0.01', min: '0' });
    const cargoInput = el('input', { type: 'number', step: '0.01', min: '0' });
    const platformInput = el('input', { type: 'number', step: '0.01', min: '0' });
    const stopajRateInput = el('input', { type: 'number', step: '0.01', min: '0' });
    const costInput = el('input', { type: 'number', step: '0.01', min: '0' });
    const out = el('div', { class: 'simOut' });

    // Fiyata bağlı alanları (kargo kademesi) SADECE elle değiştirilmediyse otomatik güncelle.
    const applyAutoDefaults = (p) => {
      if (!dirty.rate) rateInput.value = estCommissionRatePct(r).toFixed(2);
      if (!dirty.cargo) cargoInput.value = String(cargoTierFor(p));
      if (!dirty.platform) platformInput.value = '13.19';
      if (!dirty.stopajRate) stopajRateInput.value = '1';
      if (!dirty.cost) costInput.value = autoCost != null ? String(autoCost) : '0';
    };
    applyAutoDefaults(num(priceInput.value));

    const row = (lbl, val, cls) => el('div', { class: 'simRow' + (cls ? ' ' + cls : '') }, el('span', { text: lbl }), el('span', { text: val }));
    const recalc = () => {
      const p = Number(String(priceInput.value).replace(',', '.'));
      if (!Number.isFinite(p) || p <= 0) {
        out.replaceChildren(el('div', { class: 'muted', text: 'Bir satış fiyatı gir.' }));
        return;
      }
      applyAutoDefaults(p);
      const rate = Number(String(rateInput.value).replace(',', '.')) || 0;
      const cargo = Number(String(cargoInput.value).replace(',', '.')) || 0;
      const platform = Number(String(platformInput.value).replace(',', '.')) || 0;
      const stopajRate = Number(String(stopajRateInput.value).replace(',', '.')) || 0;
      const costVal = Number(String(costInput.value).replace(',', '.')) || 0;
      const commission = p * rate / 100;
      const stopaj = (p / 1.20) * (stopajRate / 100);
      const net = p - commission - platform - stopaj - cargo - costVal;
      const marginOfSale = (net / p) * 100;
      const roiOfCost = costVal > 0 ? (net / costVal) * 100 : null;
      out.replaceChildren(
        row('Tahmini Net Kâr', money(net), net < 0 ? 'low' : 'good'),
        row('Kâr marjı (satış fiyatına göre)', marginOfSale.toFixed(1).replace('.', ',') + '%', marginOfSale < 0 ? 'low' : 'good'),
        row('Kazanç oranı (maliyete göre, ROI)', roiOfCost == null ? '—' : roiOfCost.toFixed(1).replace('.', ',') + '%', roiOfCost != null && roiOfCost < 0 ? 'low' : 'good'),
        costVal === 0 && autoCost == null ? el('div', { class: 'muted', text: '* Bu ürünün maliyeti sistemde kayıtlı değil, 0 sayıldı — gerçek kârın bu rakamdan DAHA DÜŞÜK olacağını unutma. Aşağıdan elle girebilirsin.' }) : '');
    };
    const F2 = (label, node) => el('div', { class: 'row' }, el('label', { text: label }), node);
    const markDirty = (key, input) => input.addEventListener('input', () => { dirty[key] = true; recalc(); });
    priceInput.addEventListener('input', recalc);
    markDirty('rate', rateInput); markDirty('cargo', cargoInput); markDirty('platform', platformInput);
    markDirty('stopajRate', stopajRateInput); markDirty('cost', costInput);

    const resetAuto = () => { Object.keys(dirty).forEach((k) => { dirty[k] = false; }); applyAutoDefaults(num(priceInput.value)); recalc(); };

    modal.replaceChildren(el('div', { class: 'mbox' },
      el('h2', { text: 'Fiyat Simülasyonu' }),
      el('div', { class: 'muted', text: r.product_name || r.barcode }),
      F2('Bu fiyattan satarsam...', priceInput),
      out,
      el('div', { class: 'simEditTitle' }, 'Değerler otomatik dolduruldu — istersen elle değiştir:'),
      el('div', { class: 'two' },
        F2('Komisyon oranı (%)', rateInput),
        F2('Kargo (₺)', cargoInput)),
      el('div', { class: 'two' },
        F2('Platform hizmet bedeli (₺)', platformInput),
        F2('Stopaj oranı (%)', stopajRateInput)),
      F2('Ürün maliyeti (₺)', costInput),
      el('div', { class: 'btns' },
        el('button', { class: 'btn sm', text: 'Otomatiğe Dön', onclick: resetAuto }),
        el('button', { class: 'btn', text: 'Kapat', onclick: closeModal }))));
    modal.classList.remove('hide');
    recalc();
  }
  // v12: Umit'in isteğiyle — "Mağaza & Karlılık" sekmesinin kendi ayrı filtre kutusu (Marka/Ara/
  // Sadece maliyeti eksik olanlar) kaldırıldı, üstteki genel filtreyle birleştirildi: Marka artık
  // üstteki çoklu-seçim Marka listesinden (F.brands), arama üstteki genel arama kutusundan (F.q) —
  // ürün adı/barkod/marka üzerinden — geliyor. "Sadece maliyeti eksik olanlar" (SF.onlyMissing) tek
  // başına üstteki filtre panelinde bir kutucuk olarak kaldı (başka bir sekmede karşılığı yok).
  function filteredSeller() {
    const q = normTxt(F.q.trim());
    return sellerProfit.filter((r) => {
      if (F.brands.size && !F.brands.has(r.brand || 'Markasız')) return false;
      if (SF.onlyMissing && !r.cost_missing) return false;
      if (q) {
        const hay = normTxt([r.product_name, r.barcode, r.brand].join(' '));
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  const sellerCols = [
    { key: 'product_name', label: 'Ürün', sort: (r) => r.product_name, cell: (r) => el('div', { class: 'prod' }, thumb(r.image_url), link(r.buyer_product_id ? r.buyer_product_url : null, r.product_name),
        r.approved === false ? el('span', { class: 'badge g-preparing', title: 'Bu ürün Trendyol tarafından henüz onaylanmadı — onaylanınca stok/fiyat bilgisi güncellenir', text: 'Onay Bekliyor' }) : '') },
    { key: 'brand', label: 'Marka', sort: (r) => r.brand, cell: T((r) => r.brand || 'Markasız') },
    { key: 'current_stock', label: 'Stok', num: true, sort: (r) => num(r.current_stock), cell: (r) => int(r.current_stock) },
    { key: 'sale_price', label: 'Satış fiyatı', num: true, sort: (r) => num(r.sale_price), cell: (r) => (r.sale_price == null ? '' : money(r.sale_price)) },
    { key: 'price_sim', label: 'Ne Kazanırım?', cell: (r) => el('button', { class: 'icon-btn', title: 'Bu ürünü farklı bir fiyattan satarsan ne kadar kazanırsın, hesapla', onclick: () => openPriceSimModal(r) }, '🧮') },
    { key: 'cost_price', label: 'Maliyet', sort: (r) => (r.cost_price == null ? null : num(r.cost_price)), cell: (r) => {
        if (r.buyer_product_id) {
          return el('div', { class: 'acts-left' }, el('span', { text: money(r.cost_price) }), el('span', { class: 'muted', text: '(otomatik)' }),
            num(r.pack_qty) > 1 ? el('span', { class: 'badge g-preparing', title: 'Bu satıcı ürünü, bağlı alıcı üründen ' + int(r.pack_qty) + ' adet içeriyor (set)', text: int(r.pack_qty) + '\'li paket' }) : '',
            el('button', { class: 'btn sm', text: 'Paket adedi', title: 'Set/çoklu paket satıyorsan (ör. 2li), stok düşümü ve maliyetin doğru hesaplanması için buradan adet gir', onclick: () => editPackQty(r) }),
            el('button', { class: 'btn sm', text: 'Değiştir', onclick: () => relinkSellerCost(r) }),
            el('button', { class: 'btn sm', text: 'Elle gir', onclick: () => editProductCost(r) }),
            el('button', { class: 'btn sm danger', text: 'Bağlantıyı kaldır', title: 'Yanlış eşleşmişse: bağlantıyı kaldırır, stok düşümü ve maliyet otomatik hesabı durur', onclick: () => unlinkSellerCost(r) }));
        }
        if (r.manual_cost_price != null) {
          return el('span', { class: 'editable', title: 'Değiştirmek için tıkla', text: money(r.manual_cost_price) + ' (manuel)', onclick: () => editProductCost(r) });
        }
        const sug = suggestBuyerMatch(r);
        if (sug) {
          return el('div', { class: 'acts-left' }, el('span', { class: 'muted', text: `Öneri: ${sug.product_name} — ortalama ${money(sug.avg_unit_price)}` }),
            el('button', { class: 'btn sm', text: 'Onayla', onclick: () => linkSellerCost(r, sug.product_id) }),
            el('button', { class: 'btn sm', text: 'Elle gir', onclick: () => editProductCost(r) }));
        }
        return el('div', { class: 'acts-left' }, el('span', { class: 'muted', text: 'Eşleşme yok' }),
          el('button', { class: 'btn sm', text: 'Ara/Bağla', onclick: () => relinkSellerCost(r) }),
          el('button', { class: 'btn sm', text: 'Elle gir', onclick: () => editProductCost(r) }));
      } },
    { key: 'qty_sold', label: 'Satılan adet', num: true, sort: (r) => num(r.qty_sold), cell: (r) => int(r.qty_sold) },
    { key: 'revenue', label: 'Toplam Satış', num: true, sort: (r) => num(r.revenue), cell: (r) => money(r.revenue) },
    { key: 'cost_total', label: 'Toplam Maliyet', num: true, sort: (r) => num(r.cost_total),
      cell: (r) => el('span', { class: r.cost_missing ? 'muted' : '', title: r.cost_missing ? 'Maliyet bulunamadı, bu rakam eksik' : '', text: money(r.cost_total) + (r.cost_missing ? ' *' : '') }) },
    { key: 'expense_total', label: 'Toplam Masraflar', num: true, sort: (r) => num(r.expense_total), cell: (r) => money(r.expense_total),
      title: 'Komisyon + kargo + platform hizmet bedeli + stopaj + ceza + iade + diğer — kargo/platform/stopaj gibi sipariş (paket) bazında oluşan masraflar, bu ürünün o siparişteki ciro payına göre orantılı paylaştırılır' },
    { key: 'net_profit', label: 'Toplam Net Kâr', num: true, sort: (r) => num(r.net_profit),
      cell: (r) => el('span', { class: r.cost_missing ? 'muted' : (num(r.net_profit) < 0 ? 'low' : ''), title: r.cost_missing ? 'Maliyet bulunamadı, bu rakam eksik' : '', text: money(r.net_profit) + (r.cost_missing ? ' *' : '') }) },
  ];

  // ---------- mağaza siparişleri (satır satır detay) ----------
  function sellerStatusGroup(status) {
    const s = lc(status || '');
    if (/delivered/.test(s)) return 'delivered';
    if (/cancel|return|unsupplied|undeliver/.test(s)) return 'closed';
    if (/shipped|picking|invoiced|collection/.test(s)) return 'onway';
    if (/created|awaiting/.test(s)) return 'preparing';
    return 'unknown';
  }
  function sellerStatusBadge(status) {
    const cls = { delivered: 'g-delivered', closed: 'g-closed', onway: 'g-onway', preparing: 'g-preparing', unknown: 'g-unknown' }[sellerStatusGroup(status)];
    return el('span', { class: 'badge ' + cls, text: status || 'Bilinmiyor' });
  }
  const dash = (v) => el('span', { class: 'muted', text: '—' });
  // v11: Umit'in isteğiyle — sayfada iki ayrı arama kutusu olması kafa karıştırıyordu (üstteki
  // genel arama "plus 48" gibi bir sipariş/ürün adını bulmuyordu, sadece alttaki kendi arama
  // kutusu buluyordu). Artık "Siparişler" sekmesi de üstteki TEK genel tarih (F.from/F.to) ve
  // arama (F.q) filtresini kullanıyor — ayrı bir OF.from/OF.to/OF.q yok. OF sadece bu sekmeye
  // özel, üstte karşılığı olmayan Durum ve İptalleri Gizle'yi tutuyor.
  function filteredSellerOrders() {
    const q = normTxt(F.q.trim());
    return sellerOrders.filter((r) => {
      const d = r.order_date ? String(r.order_date).slice(0, 10) : '';
      if (F.from && (!d || d < F.from)) return false;
      if (F.to && (!d || d > F.to)) return false;
      if (q) {
        const hay = normTxt([r.order_number, r.products].join(' '));
        if (!hay.includes(q)) return false;
      }
      if (OF.status && sellerStatusGroup(r.status) !== OF.status) return false;
      if (OF.hideCancelled && isCancelledOrder(r)) return false;
      return true;
    });
  }
  // Üstteki genel "Tarih Aralığı" filtresine (F.from/F.to) göre sipariş listesini daraltır —
  // Mağaza & Karlılık sekmesindeki Tahmini/Kesin Net Kâr kartları ve grafikleri de artık bu
  // filtreye göre değişiyor (önceden hep TÜM ZAMANLARI gösteriyorlardı, bu yüzden "Bugün/Bu Hafta"
  // seçince rakamlar değişmiyormuş gibi görünüyordu).
  function sellerOrdersInDateRange() {
    return sellerOrders.filter((r) => {
      const d = r.order_date ? String(r.order_date).slice(0, 10) : '';
      if (F.from && (!d || d < F.from)) return false;
      if (F.to && (!d || d > F.to)) return false;
      return true;
    });
  }
  // Bir siparişin komisyon DIŞINDAKİ masrafları (kargo/iade kargo/ceza/iptal/iade/diğer) hiç
  // hesaplanmış mı? — hiçbiri gelmemişse "henüz hesaplanmadı" sayılır (alt istatistik için).
  const hasExtraCosts = (r) => [r.cargo_fee, r.return_cargo_fee, r.penalty_fee, r.cancel_amount, r.return_amount, r.other_amount].some((v) => v != null);
  const isCancelledOrder = (r) => /iptal|cancel/i.test(r.status || '') || num(r.cancel_amount) < 0;
  // v20 DÜZELTME (30.09.2026): ÖNCEDEN "undelivered" (kargo teslim edemedi, henüz iade süreci
  // TAMAMLANMADI) durumu "iade" ile aynı regex'e ("iade|return|undeliver") yakalanıp erkenden
  // İADE/kapalı sayılıyordu — hem "İadeler" kartında hem stok/kârlılık hesaplarında Trendyol'un
  // kendi rakamlarıyla (Net Satış Adedi) TUTARSIZLIK yaratıyordu (bkz. SQL tarafındaki aynı
  // düzeltme, 34_fix_undelivered_stok_erken_sayilmasin.sql). Artık SADECE gerçekten geri dönmüş
  // ("Returned" / "UnDeliveredAndReturned" — ikisi de "return" içeriyor) siparişler "iade" sayılıyor.
  // Salt "UnDelivered" (süreç bitmedi) artık AYRI bir durum: satışa/aktife dahil kalıyor ama
  // "teslim edilemedi" olarak ayrıca bilgi amaçlı gösteriliyor (bkz. isUnDeliveredPendingOrder).
  const isConfirmedReturnedOrder = (r) => /iade|return/i.test(r.status || '') || num(r.return_amount) < 0;
  const isUnDeliveredPendingOrder = (r) => /undelivered/i.test(r.status || '') && !isConfirmedReturnedOrder(r);
  // Trendyol raporuyla uyum: sadece iptal + KESİNLEŞMİŞ iade paketleri satıştan düşülür.
  const isClosedSellerOrder = (r) => isCancelledOrder(r) || isConfirmedReturnedOrder(r);
  // Sipariş bazında net tutar: gross_amount + (komisyon/kargo/ceza/iptal/iade/diğer — hepsi
  // Trendyol'dan zaten NEGATİF (kesinti) olarak geliyor, null olanlar 0 sayılır).
  const orderNet = (r) => num(r.gross_amount) + num(r.commission_amount) + num(r.cargo_fee) + num(r.return_cargo_fee) + num(r.penalty_fee) + num(r.cancel_amount) + num(r.return_amount) + num(r.other_amount);
  const sellerOrderCols = [
    { key: 'order_date', label: 'Tarih', sort: (r) => r.order_date, cell: (r) => fdatetime(r.order_date) },
    { key: 'order_number', label: 'Sipariş No', sort: (r) => r.order_number, cell: (r) => link(r.cargo_tracking_link, r.order_number) },
    { key: 'status', label: 'Durum', sort: (r) => r.status, cell: (r) => sellerStatusBadge(r.status) },
    { key: 'products', label: 'Ürünler', sort: (r) => r.products, cell: (r) => el('span', { title: r.products || '', text: r.products && r.products.length > 50 ? r.products.slice(0, 49) + '…' : (r.products || '') }) },
    { key: 'qty', label: 'Adet', num: true, sort: (r) => num(r.qty), cell: (r) => int(r.qty) },
    { key: 'gross_amount', label: 'Sipariş Tutarı', num: true, sort: (r) => num(r.gross_amount), cell: (r) => money(r.gross_amount) },
    { key: 'total_discount', label: 'İndirim', num: true, sort: (r) => (r.total_discount == null ? null : num(r.total_discount)), cell: (r) => (r.total_discount == null ? dash() : money(r.total_discount)) },
    // Komisyon: bazı ürün kategorilerinde Trendyol satır oranını sipariş anında değil, ancak
    // hakediş aşamasında belirliyor (log'larla teyit edildi — kategoriye göre değişiyor). Bu
    // durumda SQL önce O ÜRÜNÜN kendi geçmiş gerçek oranlarının ortalamasını, yoksa genel %15,40'ı
    // VARSAYILAN kullanır (commission_confirmed=false) ve burada "~" ile tahmini olduğu belirtilir;
    // gerçek oran senkronize olunca otomatik kesinleşir.
    { key: 'commission_amount', label: 'Komisyon', num: true, sort: (r) => (r.commission_amount == null ? null : num(r.commission_amount)),
      cell: (r) => (r.commission_amount == null ? dash()
        : el('span', { class: r.commission_confirmed === false ? 'muted' : '',
            title: r.commission_confirmed === false ? 'Bu ürünün komisyon oranı henüz gelmedi — ürünün kendi geçmiş ortalama oranıyla (yoksa genel %15,40 ile) tahmini gösteriliyor' : '',
            text: (r.commission_confirmed === false ? '~' : '') + money(r.commission_amount) + (r.commission_confirmed === false ? ' *' : '') })) },
    // Kargo faturası henüz Trendyol'dan gelmediyse (cargo_fee null), "—" yerine sipariş tutarına göre
    // kademeli TAHMİNİ kargo bedelini (~47/85/98 ₺) gösteriyoruz — gerçek fatura gelince otomatik değişir.
    { key: 'cargo_fee', label: 'Kargo', num: true,
      sort: (r) => (r.cargo_fee != null ? num(r.cargo_fee) : (r.cargo_estimated != null ? -num(r.cargo_estimated) : null)),
      cell: (r) => (r.cargo_fee != null ? money(r.cargo_fee)
        : (r.cargo_estimated != null ? el('span', { class: 'muted', title: 'Kargo faturası henüz gelmedi — tutar aralığına göre tahmini gösteriliyor', text: '~' + money(-r.cargo_estimated) }) : dash())) },
    { key: 'return_cargo_fee', label: 'İade Kargo', num: true, sort: (r) => (r.return_cargo_fee == null ? null : num(r.return_cargo_fee)), cell: (r) => (r.return_cargo_fee == null ? dash() : money(r.return_cargo_fee)) },
    { key: 'penalty_fee', label: 'Ceza', num: true, sort: (r) => (r.penalty_fee == null ? null : num(r.penalty_fee)), cell: (r) => (r.penalty_fee == null ? dash() : money(r.penalty_fee)) },
    { key: 'return_amount', label: 'İade', num: true, sort: (r) => (r.return_amount == null ? null : num(r.return_amount)), cell: (r) => (r.return_amount == null ? dash() : money(r.return_amount)) },
    { key: 'other_amount', label: 'Diğer', num: true, sort: (r) => (r.other_amount == null ? null : num(r.other_amount)), cell: (r) => (r.other_amount == null ? dash() : money(r.other_amount)) },
    // Platform hizmet bedeli (sabit 13,19₺) ve %1 stopaj — SQL'de POZİTİF tutuluyor, burada
    // kesinti olarak (negatif) gösteriliyor, tıpkı kargo/ceza sütunları gibi.
    { key: 'platform_fee', label: 'Platform Ücreti', num: true, sort: (r) => (r.platform_fee == null ? null : -num(r.platform_fee)), cell: (r) => (r.platform_fee == null ? dash() : money(-r.platform_fee)) },
    { key: 'stopaj_amount', label: 'Stopaj (%1)', num: true, sort: (r) => (r.stopaj_amount == null ? null : -num(r.stopaj_amount)), cell: (r) => (r.stopaj_amount == null ? dash() : money(-r.stopaj_amount)) },
    { key: 'estimated_cost', label: 'Ürün Maliyeti', num: true, sort: (r) => num(r.estimated_cost), cell: (r) => (r.cost_missing ? el('span', { class: 'muted', text: money(r.estimated_cost) + ' *' }) : money(r.estimated_cost)) },
    // Net Kâr: maliyet+komisyon+kargo+platform ücreti+stopaj (+varsa ceza/iade) dahil GERÇEK kâr —
    // kargo faturası gerçek gelene kadar "~" işaretiyle tahmini (net_profit_estimated), geldikten
    // sonra kesin (net_profit_confirmed) gösterilir. Kart toplamlarıyla (Tahmini/Kesin Net Kâr) birebir aynı yöntem.
    { key: 'net', label: 'Net Kâr', num: true,
      sort: (r) => (r.fully_confirmed && r.net_profit_confirmed != null ? num(r.net_profit_confirmed) : num(r.net_profit_estimated)),
      // Umit'in isteğiyle: para tutarının yanında, fazla yer kaplamadan, maliyet üzerinden
      // net kâr yüzdesi de gösteriliyor (net / ürün maliyeti * 100). Maliyet bilinmiyorsa
      // (cost_missing) veya 0 ise yüzde hiç gösterilmiyor.
      cell: (r) => {
        const confirmed = r.fully_confirmed && r.net_profit_confirmed != null;
        const n = confirmed ? num(r.net_profit_confirmed) : num(r.net_profit_estimated);
        const cost = num(r.estimated_cost);
        const pct = (!r.cost_missing && cost > 0) ? (n / cost * 100) : null;
        return el('span', { class: n < 0 ? 'low' : '',
          title: confirmed ? '' : 'Kargo faturası henüz kesinleşmedi — maliyet+komisyon+kargo (tahmini)+platform+stopaj dahil tahmini kâr gösteriliyor' },
          (confirmed ? '' : '~') + money(n) + (confirmed ? '' : ' *'),
          pct == null ? '' : el('span', { class: 'muted', style: 'font-size:11px;margin-left:4px', text: '(%' + pct.toFixed(0) + ')' }));
      } },
  ];

  function populateSellerBrandOptions() {
    const sel = $('#sellerBrand'); if (!sel) return;
    const cur = sel.value;
    const brands = uniq(sellerProfit.map((r) => r.brand || 'Markasız')).sort((a, b) => a.localeCompare(b, 'tr'));
    sel.replaceChildren(el('option', { value: '', text: 'Marka — hepsi' }), ...brands.map((b) => el('option', { value: b, text: b })));
    if (brands.includes(cur)) sel.value = cur;
  }
  // Umit'in sorusuyla eklendi: "Kesinleşen Kâr" kartına tıklayınca hangi siparişlerden oluştuğunu
  // görebilsin diye — Siparişler sekmesine geçip Durum filtresini "Teslim Edildi"ye ayarlıyor
  // (Kesinleşen Kâr zaten TAM OLARAK teslim edilmiş siparişlerin toplamı, bkz. deliveredProfit()).
  function goToDeliveredOrders() {
    activeTab = 'storeOrders';
    OF.status = 'delivered';
    if ($('#ocStatus')) $('#ocStatus').value = 'delivered';
    renderAll();
  }
  // Kart tıklamalarında sipariş listesi göstermek için kompakt sütun seti — zaten var olan
  // sellerOrderCols'un (Siparişler tablosu) alt kümesi, modal'a sığması için.
  const sellerOrderModalCols = sellerOrderCols.filter((c) => ['order_date', 'order_number', 'status', 'products', 'qty', 'gross_amount', 'net'].includes(c.key));
  function openSellerOrderListModal(title, items) {
    const modal = $('#modal');
    const host = el('div', {});
    modal.replaceChildren(el('div', { class: 'mbox wide' },
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px' },
        el('h2', { text: title, style: 'margin:0' }),
        el('button', { class: 'btn sm', text: 'Kapat', onclick: closeModal })),
      host));
    modal.classList.remove('hide');
    makeTable(host, sellerOrderModalCols, () => items, { sortKey: 'order_date', sortDir: -1, empty: 'Kayıt yok',
      summary: (d) => `${int(d.length)} sipariş · ${int(sumBy(d, (r) => r.qty))} adet · ${money(sumBy(d, (r) => r.gross_amount))}` }).render();
  }
  function renderSellerCards(rs) {
    if (!$('#sellerCards')) return; // eski önbelleğe alınmış HTML'de bu bölüm yoksa sessizce atla
    const card = (cls, lbl, big, sub, onClick) => el('div', { class: 'card ' + cls + (onClick ? ' clickable' : ''), title: onClick ? 'Hangi siparişler olduğunu görmek için tıkla' : '', onclick: onClick },
      el('div', { class: 'lbl', text: lbl }), el('div', { class: 'big', text: big }), el('div', { class: 'sub', text: sub || '' }));
    const missing = rs.filter((r) => r.cost_missing);
    // DÜZELTME: Ciro/Komisyon toplamı da artık sipariş bazlı (sellerOrders) veriden hesaplanıyor —
    // bu sayede üstteki TARİH ARALIĞI filtresine (Bugün/Bu Hafta/…) göre gerçekten değişiyor.
    // (Önceden ürün bazlı API'den geliyordu, o veri sipariş tarihi taşımadığı için tarihe göre
    // daralmıyordu.) Bu yüzden bu kartlar artık "tüm mağaza" — marka/ürün filtresinden bağımsız,
    // tıpkı Tahmini/Kesin Net Kâr kartları gibi. Sadece "Maliyeti eksik ürün" kartı marka filtresine
    // uyuyor (o, ürün listesiyle ilgili bir bilgi).
    const dateRs = sellerOrdersInDateRange();
    const agg = profitAgg(dateRs);
    const dp = deliveredProfit(dateRs);
    // İptaller/İadeler: Toplam Satış (İptaller Hariç) zaten bunları hesaba katmıyor — burada ayrıca
    // ne kadar tutarında iptal/KESİNLEŞMİŞ iade olduğunu ayrı kartlarda gösteriyoruz (bilgi amaçlı).
    // v20: "İadeler" artık SADECE gerçekten geri dönmüş siparişleri sayıyor (isConfirmedReturnedOrder)
    // — "UnDelivered" (henüz süreç bitmedi) bununla KARIŞTIRILMIYOR, ayrı "teslim edilemedi" bilgisi
    // olarak gösteriliyor ve aktif/satış sayılmaya devam ediyor.
    const cancelledRs = dateRs.filter(isCancelledOrder);
    const returnedRs = dateRs.filter((r) => isConfirmedReturnedOrder(r) && !isCancelledOrder(r));
    const undeliveredRs = dateRs.filter(isUnDeliveredPendingOrder);
    const activeRs = dateRs.filter((r) => !isClosedSellerOrder(r));
    const activeQty = sumBy(activeRs, (r) => r.qty);
    const rangeNote = (F.from || F.to) ? ' (seçili tarih aralığı)' : ' (tüm zamanlar)';
    const undeliveredNote = undeliveredRs.length ? ` · ${int(undeliveredRs.length)} teslim edilemedi (satışa dahil, henüz kesin iade değil)` : '';
    $('#sellerCards').replaceChildren(
      card('total', 'Toplam Satış', money(agg.revenue), `tüm mağaza · ${int(agg.n)} sipariş · ${int(activeQty)} adet` + rangeNote,
        () => openSellerOrderListModal('Toplam Satış', activeRs)),
      // Umit'in isteğiyle: büyük rakam artık iptalleri SAYMIYOR (iptaller hariç aktif sipariş
      // sayısı) — iptal/iade sayıları ayrı bir bilgi olarak alt satırda gösteriliyor.
      card('onway', 'Sipariş Adeti', int(agg.n), `${int(activeQty)} adet` + ((cancelledRs.length || returnedRs.length) ? ` · ${int(cancelledRs.length)} iptal · ${int(returnedRs.length)} iade (dahil değil)` : ' · iptal/iade yok') + undeliveredNote + rangeNote,
        () => openSellerOrderListModal('Sipariş Adeti', activeRs)),
      card('onway', 'Toplam Komisyon', money(-agg.commission), 'sipariş anında kesinleşen oran' + rangeNote,
        () => openSellerOrderListModal('Toplam Komisyon', activeRs)),
      card('preparing', 'Toplam Kesintiler', money(-agg.allDeductions), 'kargo+ceza+diğer+platform+stopaj' + rangeNote,
        () => openSellerOrderListModal('Toplam Kesintiler', activeRs)),
      card('onway', 'Toplam Ürün Maliyeti', money(agg.cost), missing.length ? `* ${int(missing.length)} üründe maliyet eksik` : 'FİFO (alım sırasına göre); veri yoksa son alımların ortalaması',
        () => openSellerOrderListModal('Toplam Ürün Maliyeti', activeRs)),
      card(agg.netEstimated < 0 ? 'closed' : 'delivered', 'Tahmini Net Kâr', money(agg.netEstimated), 'satış − (komisyon+kesintiler+ürün maliyeti)' + rangeNote,
        () => openSellerOrderListModal('Tahmini Net Kâr', activeRs)),
      card(cancelledRs.length ? 'closed' : 'preparing', 'İptaller', money(sumBy(cancelledRs, (r) => r.gross_amount)), `${int(cancelledRs.length)} sipariş` + rangeNote,
        cancelledRs.length ? () => openSellerOrderListModal('İptaller', cancelledRs) : null),
      card(returnedRs.length ? 'closed' : 'preparing', 'İadeler (Kesinleşmiş)', money(sumBy(returnedRs, (r) => (num(r.return_amount) ? Math.abs(num(r.return_amount)) : num(r.gross_amount)))), `${int(returnedRs.length)} sipariş — ürün fiziksel olarak geri döndü` + rangeNote,
        returnedRs.length ? () => openSellerOrderListModal('İadeler (Kesinleşmiş)', returnedRs) : null),
      card(dp.n ? (dp.sum < 0 ? 'closed' : 'delivered') : 'preparing', 'Kesinleşen Kâr',
        dp.n ? money(dp.sum) : '—', (dp.n ? `${int(dp.n)} teslim edilen sipariş` : 'henüz teslim edilen sipariş yok') + rangeNote,
        dp.n ? goToDeliveredOrders : null));
  }
  function renderSellerCharts(rs) {
    if (typeof Chart === 'undefined') return;
    const base = { responsive: true, maintainAspectRatio: false };
    const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

    // Tutar nereye gidiyor (tahmini, tüm mağaza) — pasta/dilim grafiği. Üstteki tarih aralığı
    // filtresine göre daraltılıyor (kartlarla aynı kaynak).
    const dateSO = sellerOrdersInDateRange();
    const pieAgg = profitAgg(dateSO);
    drawChart('cProfitPie', { type: 'doughnut',
      data: { labels: ['Ürün Maliyeti', 'Komisyon', 'Kargo', 'Platform Ücreti', 'Stopaj', 'Net Kâr (tahmini)'],
        datasets: [{ data: [pieAgg.cost, Math.abs(pieAgg.commission), Math.abs(pieAgg.cargo), Math.abs(pieAgg.platform), Math.abs(pieAgg.stopaj), Math.max(pieAgg.netEstimated, 0)],
          backgroundColor: ['#f27a1a', '#2563eb', '#0ea5e9', '#7c3aed', '#d97706', '#16a34a'] }] },
      options: { ...base, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${money(c.parsed)}` } } } } });

    // Aylık net kâr — tahmini / kesin (tarih aralığı filtresine göre daraltılmış)
    const activeSO = dateSO.filter((r) => !isCancelledOrder(r));
    const mm2 = groupBy(activeSO, (r) => (r.order_date ? String(r.order_date).slice(0, 7) : 'Tarihsiz'));
    const months2 = [...mm2.keys()].sort();
    drawChart('cProfitTrend', { type: 'bar',
      data: { labels: months2.map((k) => (/^\d{4}-\d{2}$/.test(k) ? k.slice(5) + '.' + k.slice(0, 4) : k)),
        datasets: [
          { label: 'Tahmini net kâr', data: months2.map((k) => sumBy(mm2.get(k), (r) => num(r.net_profit_estimated))), backgroundColor: '#7b6ce0', borderRadius: 6 },
          { label: 'Kesin net kâr', data: months2.map((k) => { const conf = mm2.get(k).filter((r) => r.fully_confirmed); return conf.length ? sumBy(conf, (r) => num(r.net_profit_confirmed)) : null; }), backgroundColor: '#16a34a', borderRadius: 6 },
        ] },
      options: { ...base, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${money(c.parsed.y)}` } } } } });

    const bm = [...groupBy(rs, (r) => r.brand || 'Markasız').entries()]
      .map(([k, v]) => [k, sumBy(v.filter((r) => !r.cost_missing), (r) => r.net_profit)])
      .sort((a, b) => b[1] - a[1]).slice(0, 10);
    drawChart('cSellerBrand', { type: 'bar',
      data: { labels: bm.map((x) => trunc(x[0], 26)), datasets: [{ data: bm.map((x) => x[1]), backgroundColor: bm.map((x) => (x[1] < 0 ? '#dc2626' : '#16a34a')), borderRadius: 6 }] },
      options: { ...base, indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + money(c.parsed.x) } } } } });

    const pm = [...rs].sort((a, b) => num(b.qty_sold) - num(a.qty_sold)).slice(0, 10);
    drawChart('cSellerTop', { type: 'bar',
      data: { labels: pm.map((r) => trunc(r.product_name || r.barcode, 34)), datasets: [{ data: pm.map((r) => num(r.qty_sold)), backgroundColor: '#2563eb', borderRadius: 6 }] },
      options: { ...base, indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${int(c.parsed.x)} adet` } } } } });
  }

  // ---------- Hakediş Raporu — Trendyol'un ham hakediş (ty_seller_settlements) ve diğer kesinti
  // (ty_seller_other_financials: kargo/ceza/platform) kayıtlarından, üstteki tarih aralığı filtresine
  // göre daraltılmış dönemsel özet, sipariş no ile arama, aylık trend ve "hakedişi henüz gelmemiş
  // siparişler" listesi. "Ürünler & Kârlılık" alt sekmesindeki tahmini/kesin kâr hesabından bağımsız —
  // burada SADECE Trendyol'dan gerçekten gelmiş hakediş satırları gösteriliyor.
  // v18 (30 Eylül): Trendyol finans kayıtlarında tür adları TÜRKÇE geliyor ("Satış", "İade",
  // "Ödeme", "Komisyon Faturası"...). "Ödeme" = hesaba yatan para (kesinti DEĞİL), "Komisyon
  // Faturası" = hakedişten ZATEN düşülmüş komisyonun faturası (tekrar düşülmemeli).
  const isSaleType = (t) => /^(sale|satış|satis)$/i.test(String(t || '').trim());
  const isReturnType = (t) => /^(return|iade)$/i.test(String(t || '').trim());
  const isPayoutOF = (r) => /ödeme|odeme|payment/i.test(String(r.transaction_type || ''));
  const isCommInvoiceOF = (r) => /komisyon fatura|commissioninvoice|commission invoice/i.test(String(r.transaction_type || ''));
  const isRealDeductionOF = (r) => !isPayoutOF(r) && !isCommInvoiceOF(r);
  // Kayıt henüz bir ödeme emrine bağlanmamışsa (paymentOrderId boş) para hâlâ Trendyol'da bekliyor.
  const isUnpaidFin = (r) => { const v = r.raw && r.raw.paymentOrderId; return v == null || v === '' || v === 0 || v === '0'; };
  // Takip başlangıcı = mağaza siparişlerinin en eski tarihi (TY_SYNC_START). Finans kayıtları bakiye
  // doğru çıksın diye daha geriden çekiliyor; "başlangıçtan beri" kartları bu tarihe göre süzülür.
  function scopeStart() {
    let m = '';
    sellerOrders.forEach((r) => { const d = r.order_date ? String(r.order_date).slice(0, 10) : ''; if (d && (!m || d < m)) m = d; });
    return m;
  }
  function scopeOrderNos() { return new Set(sellerOrders.map((r) => r.order_number).filter(Boolean)); }
  function scopedSettlements() { const nos = scopeOrderNos(); return sellerSettlements.filter((r) => nos.has(r.order_number)); }
  function scopedOtherFin() { const st = scopeStart(); return sellerOtherFin.filter((r) => { const d = r.transaction_date ? String(r.transaction_date).slice(0, 10) : ''; return !st || (d && d >= st); }); }
  function scopedPayouts() { const st = scopeStart(); return sellerPayouts.filter((r) => { const d = r.payout_date ? String(r.payout_date).slice(0, 10) : ''; return !st || (d && d >= st); }); }
  // Trendyol'da bekleyen bakiye: ödenmemiş hakediş + ödenmemiş gerçek kesintiler (tüm çekilen kayıtlar).
  function trendyolBalance() {
    return sumBy(sellerSettlements.filter(isUnpaidFin), (r) => r.seller_revenue)
      + sumBy(sellerOtherFin.filter((r) => isUnpaidFin(r) && isRealDeductionOF(r)), (r) => r.amount);
  }
  function settlementsInDateRange() {
    return scopedSettlements().filter((r) => {
      const d = r.transaction_date ? String(r.transaction_date).slice(0, 10) : '';
      return (!F.from || (d && d >= F.from)) && (!F.to || (d && d <= F.to));
    });
  }
  function otherFinInDateRange() {
    return scopedOtherFin().filter(isRealDeductionOF).filter((r) => {
      const d = r.transaction_date ? String(r.transaction_date).slice(0, 10) : '';
      return (!F.from || (d && d >= F.from)) && (!F.to || (d && d <= F.to));
    });
  }
  // Gerçek ödemeler (ty_seller_payouts) — Trendyol'un banka hesabına GERÇEKTEN aktardığı tutar.
  // "Hakediş" (settlements) ile KARIŞTIRILMAMALI: o Trendyol'un iç muhasebe kaydı, bu ise gerçekten
  // hesabına yatmış para. payout_date'e göre süzülür (üstteki tarih aralığı filtresiyle aynı mantık).
  function payoutsInDateRange() {
    return scopedPayouts().filter((r) => {
      const d = r.payout_date ? String(r.payout_date).slice(0, 10) : '';
      return (!F.from || (d && d >= F.from)) && (!F.to || (d && d <= F.to));
    });
  }
  function totalPayoutsAllTime() {
    return sumBy(sellerPayouts, (r) => r.amount);
  }
  function settleTypeLabel(t) {
    const m = { Sale: 'Satış', Return: 'İade', Discount: 'İndirim', DiscountCancel: 'İndirim İptali', Coupon: 'Kupon' };
    return m[t] || t || 'Bilinmiyor';
  }
  // ---------- "Şimdiye kadar ne kadar aldım / bugün kapatırsam ne kadar alırım" ----------
  // Trendyol'dan hakedişi ZATEN GELMİŞ siparişlerin sipariş no'ları (tüm zamanlar, tarih filtresinden
  // bağımsız) — bir siparişin hakedişi gelip gelmediğine bakmak için tek doğru kaynak budur.
  function settledOrderNumberSet() {
    return new Set(sellerSettlements.map((r) => r.order_number).filter(Boolean));
  }
  // Şimdiye kadar Trendyol'dan gerçekten alınmış toplam net para (tüm zamanlar).
  function totalReceivedAllTime() {
    return sumBy(scopedSettlements(), (r) => r.seller_revenue);
  }
  // Henüz hakedişi gelmemiş, iptal olmayan TÜM siparişler (durumu ne olursa olsun — hazırlanıyor,
  // yolda, teslim edildi ama hakediş gelmemiş) — "hepsi teslim olursa" varsayımıyla bekleyen siparişler.
  function futurePendingOrders() {
    const settled = settledOrderNumberSet();
    return sellerOrders.filter((r) => !isClosedSellerOrder(r) && !settled.has(r.order_number));
  }
  // Bir siparişten Trendyol'un SANA ÖDEYECEĞİ tahmini tutar (net_profit_estimated ürün maliyetini
  // de düşer — o senin kendi cebinden çıkan bir masraf, Trendyol'un kesintisi değil; burada geri
  // ekliyoruz çünkü soru "Trendyol'dan ne kadar para gelir", "ne kadar kâr kalır" değil).
  function estimatedPayout(r) {
    return num(r.net_profit_estimated) + num(r.estimated_cost);
  }
  function totalFutureEstimated() {
    return sumBy(futurePendingOrders(), estimatedPayout);
  }
  // "Bugün kapatsam ne kadar alırım" TEK BİR tutarlı yöntemle hesaplanmalı — hem hakedişi zaten
  // gelmiş siparişler hem de henüz gelmemişler için AYNI formül (estimatedPayout, kargo/ceza/platform/
  // stopaj tahminini de düşen). Böylece bu rakam, Ürünler & Kârlılık sekmesindeki "Toplam Satış −
  // Komisyon − Kesintiler" ile birebir tutarlı olur.
  // v19 DÜZELTME: ÖNCEDEN trendyolBalance() (gerçek settlement + gerçek otherfinancials) kullanılıyordu
  // — ama hakedişi gelmiş bazı siparişlerde kargo/ceza faturası henüz Trendyol'dan senkronize
  // OLMADIĞI için o siparişlerde kesinti "0" sayılıyor, bu da toplamı olması gerekenden YÜKSEK
  // gösteriyordu (30.09.2026'da tespit edildi — Ürünler & Kârlılık'ın tahmini ~68.000 TL'sine karşı
  // burası hatalı biçimde ~85.000 TL gösteriyordu). Artık hakedişi gelmiş/gelmemiş ayrımı yapmadan
  // TÜM aktif siparişlere aynı tahmini formül uygulanıyor — gerçek kargo/komisyon verisi geldiyse
  // estimatedPayout zaten onu kullanıyor (bkz. v_ty_seller_orders_detail), gelmediyse tahmini
  // formüle düşüyor. "Trendyol'da Bekleyen Bakiye" kartı BUNDAN AYRI — o kasıtlı olarak Trendyol'un
  // kendi ham/gerçek verisini gösteriyor (Trendyol panelindeki 'Toplam Güncel Bakiye' ile
  // karşılaştırmak için), ona dokunulmadı.
  function totalProjectedPayout() {
    return sumBy(sellerOrders.filter((r) => !isClosedSellerOrder(r)), estimatedPayout);
  }
  function renderSettleTotals() {
    if (!$('#settleTotalCards')) return;
    const received = totalReceivedAllTime();
    const pending = futurePendingOrders();
    const projected = totalProjectedPayout();
    const balance = trendyolBalance();
    const st = scopeStart();
    const since = st ? ` · ${fdate(st)} tarihinden beri` : '';
    const card = (cls, lbl, big, sub, mode) => el('div', { class: 'card ' + cls + (mode ? ' clickable' : ''), title: mode ? 'Detayları görmek için tıkla' : '', onclick: mode ? () => { SRF.mode = mode; SRF.q = ''; if ($('#settleOrderSearch')) $('#settleOrderSearch').value = ''; renderSettleDetail(); } : null },
      el('div', { class: 'lbl', text: lbl }), el('div', { class: 'big', text: big }), el('div', { class: 'sub', text: sub || '' }));
    const paidAllTime = sumBy(scopedPayouts(), (r) => r.amount);
    $('#settleTotalCards').replaceChildren(
      card('total', 'Kazanılan Toplam Hakediş', money(received),
        `${int(scopedSettlements().length)} hakediş işlemi${since} · Trendyol'un muhasebe kaydı (ödenmiş + bekleyen)`, 'receivedAll'),
      card('preparing', 'Hesabına Yatan (Ödeme)', money(paidAllTime),
        `${int(scopedPayouts().length)} ödeme${since} · banka hesabına aktarılan GERÇEK tutar`, 'payoutsAll'),
      card('onway', "Trendyol'da Bekleyen Bakiye", money(balance),
        "hakedişi yazılmış ama henüz hesabına ödenmemiş (Trendyol'daki 'Toplam Güncel Bakiye' ile karşılaştır)"),
      card('delivered', 'Mağazayı Bugün Kapatsam Alacağım Toplam (Tahmini)', money(projected),
        `${int(sellerOrders.filter((r) => !isClosedSellerOrder(r)).length)} aktif siparişin tahmini net ödemesi (komisyon+kargo+ceza+platform+stopaj düşülmüş — Ürünler & Kârlılık ile aynı yöntem)`, 'future'));
  }
  // Kartlara tıklayınca altta hangi kayıtların açılacağını belirler: 'all' | 'commission' | 'other' | 'return' | 'search' | 'receivedAll' | 'future'
  function renderSettleCards() {
    if (!$('#settleCards')) return;
    const set = settlementsInDateRange();
    const ofs = otherFinInDateRange();
    const card = (cls, lbl, big, sub, mode) => el('div', { class: 'card ' + cls + (mode ? ' clickable' : ''), title: mode ? 'Detayları görmek için tıkla' : '', onclick: mode ? () => { SRF.mode = mode; SRF.q = ''; if ($('#settleOrderSearch')) $('#settleOrderSearch').value = ''; renderSettleDetail(); } : null },
      el('div', { class: 'lbl', text: lbl }), el('div', { class: 'big', text: big }), el('div', { class: 'sub', text: sub || '' }));
    const netHakedis = sumBy(set, (r) => r.seller_revenue);
    const komisyon = sumBy(set, (r) => r.commission_amount);
    const diger = sumBy(ofs, (r) => r.amount);
    const sales = set.filter((r) => isSaleType(r.transaction_type));
    const returns = set.filter((r) => isReturnType(r.transaction_type));
    const rangeNote = (F.from || F.to) ? ' (seçili tarih aralığı)' : ' (tüm zamanlar)';
    const pos = payoutsInDateRange();
    const paidInRange = sumBy(pos, (r) => r.amount);
    $('#settleCards').replaceChildren(
      card('total', 'Toplam Hakediş (Net)', money(netHakedis), `${int(set.length)} işlem` + rangeNote, 'all'),
      card('onway', 'Toplam Komisyon Kesintisi', money(komisyon ? -Math.abs(komisyon) : 0), `${int(sales.length)} satış işlemi` + rangeNote, 'commission'),
      card('preparing', 'Kargo/Ceza/Platform (Diğer)', money(diger), `${int(ofs.length)} kayıt` + rangeNote, 'other'),
      card(returns.length ? 'closed' : 'delivered', 'İade İşlemi', int(returns.length), 'hakediş kayıtları içinde' + rangeNote, 'return'),
      card('delivered', 'Hesabına Yatan (Gerçek Ödeme)', money(paidInRange), `${int(pos.length)} ödeme` + rangeNote, 'payoutsRange'));
  }
  function renderSettleTrend() {
    if (typeof Chart === 'undefined') return;
    const base = { responsive: true, maintainAspectRatio: false };
    const set = settlementsInDateRange();
    const mm = groupBy(set, (r) => (r.transaction_date ? String(r.transaction_date).slice(0, 7) : 'Tarihsiz'));
    const months = [...mm.keys()].sort();
    drawChart('cSettleTrend', { type: 'bar',
      data: { labels: months.map((k) => (/^\d{4}-\d{2}$/.test(k) ? k.slice(5) + '.' + k.slice(0, 4) : k)),
        datasets: [
          { label: 'Net hakediş', data: months.map((k) => sumBy(mm.get(k), (r) => r.seller_revenue)), backgroundColor: '#16a34a', borderRadius: 6 },
          { label: 'Komisyon kesintisi', data: months.map((k) => -Math.abs(sumBy(mm.get(k), (r) => r.commission_amount))), backgroundColor: '#dc2626', borderRadius: 6 },
        ] },
      options: { ...base, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${money(c.parsed.y)}` } } } } });
  }
  // Kart tıklaması VEYA sipariş no arama kutusu — hangisi son tetiklendiyse (SRF.mode) o kayıtları
  // #settleOrderResult altına, tablo olarak açar. 'search': SRF.q'ya göre sipariş no arar (tüm
  // zamanlar, tarih filtresinden bağımsız — geçmiş bir siparişi de bulabilsin diye). Kart tıklamaları
  // ('all'/'commission'/'other'/'return') üstteki tarih aralığı filtresine göre daralır.
  const closeSettleDetailBtn = () => el('button', { class: 'btn sm', text: 'Kapat ✕', onclick: () => { SRF.mode = null; if ($('#settleOrderSearch')) $('#settleOrderSearch').value = ''; renderSettleDetail(); } });
  // "Bugün kapatırsam ne kadar alırım" kartının detayı: hakedişi henüz gelmemiş, iptal olmayan tüm
  // siparişler ve her biri için tahmini ödeme — sipariş/hakediş kayıtlarından değil sellerOrders'tan.
  function renderFuturePayoutDetail(host) {
    const pending = futurePendingOrders().sort((a, b) => (b.order_date || '').localeCompare(a.order_date || ''));
    if (!pending.length) {
      host.replaceChildren(el('p', { class: 'muted', text: 'Hakedişi beklenen sipariş yok — teslim edilmiş her şeyin hakedişi gelmiş görünüyor.' }));
      return;
    }
    const statusLbl = { delivered: 'Teslim edildi (hakediş bekleniyor)', onway: 'Yolda', preparing: 'Hazırlanıyor', unknown: 'Bilinmiyor' };
    const rowsEl = pending.slice(0, 300).map((r) => el('tr', {},
      el('td', { text: fdate((r.order_date || '').slice(0, 10)) }),
      el('td', { text: r.order_number || '' }),
      el('td', { text: statusLbl[sellerStatusGroup(r.status)] || r.status || '' }),
      el('td', { text: r.products || '' }),
      el('td', { text: money(estimatedPayout(r)) })));
    host.replaceChildren(
      el('div', { class: 'tinfo' },
        el('div', { text: `Hakedişi beklenen ${int(pending.length)} sipariş — tahmini toplam ${money(sumBy(pending, estimatedPayout))}` }),
        closeSettleDetailBtn()),
      el('p', { class: 'muted', style: 'margin:0 0 8px', text: 'Bu, "Bugün kapatsam alacağım" toplamının HENÜZ HAKEDİŞİ GELMEMİŞ kısmı — hakedişi zaten gelmiş siparişler bu listede yok ama üstteki toplama dahil. Tutar tahminidir: gerçek komisyon oranı/kargo bedeli hakediş geldikçe kesinleşir, aradaki fark değişebilir.' }),
      el('div', { class: 'twrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Tarih' }), el('th', { text: 'Sipariş No' }), el('th', { text: 'Durum' }), el('th', { text: 'Ürün' }), el('th', { text: 'Tahmini Ödeme' }))),
        el('tbody', {}, ...rowsEl))));
  }
  // "Hesabına Gerçekten Yatan" kartlarının detayı: ty_seller_payouts'tan gerçek ödeme emirleri
  // (hakediş kaydından değil — bu GERÇEKTEN banka hesabına geçmiş tutarlar).
  function renderPayoutsDetail(host, list, title) {
    if (!list.length) {
      host.replaceChildren(el('p', { class: 'muted', text: 'Bu aralıkta hesabına yatan bir ödeme kaydı yok — Trendyol henüz ödeme emri oluşturmamış olabilir.' }));
      return;
    }
    const sorted = [...list].sort((a, b) => (b.payout_date || '').localeCompare(a.payout_date || ''));
    const rowsEl = sorted.map((r) => el('tr', {},
      el('td', { text: fdate((r.payout_date || '').slice(0, 10)) }),
      el('td', { text: r.payment_order_id || '' }),
      el('td', { text: r.status || '' }),
      el('td', { text: r.region_name || '' }),
      el('td', { text: money(r.amount) })));
    host.replaceChildren(
      el('div', { class: 'tinfo' },
        el('div', { text: `${title} — ${int(sorted.length)} ödeme, toplam ${money(sumBy(sorted, (r) => r.amount))}` }),
        closeSettleDetailBtn()),
      el('div', { class: 'twrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Ödeme Tarihi' }), el('th', { text: 'Ödeme No' }), el('th', { text: 'Durum' }), el('th', { text: 'Bölge' }), el('th', { text: 'Tutar' }))),
        el('tbody', {}, ...rowsEl))));
  }
  function renderSettleDetail() {
    const host = $('#settleOrderResult'); if (!host) return;
    const mode = SRF.mode;
    if (!mode) { host.replaceChildren(); return; }
    if (mode === 'future') { renderFuturePayoutDetail(host); return; }
    if (mode === 'payoutsAll') { renderPayoutsDetail(host, scopedPayouts(), 'Hesabına yatan ödemeler (takip başlangıcından beri)'); return; }
    if (mode === 'payoutsRange') { renderPayoutsDetail(host, payoutsInDateRange(), 'Hesabına yatan ödemeler (seçili tarih aralığı)'); return; }
    let settles = [], others = [], title = '';
    if (mode === 'search') {
      const q = (SRF.q || '').trim();
      if (!q) { host.replaceChildren(); return; }
      settles = sellerSettlements.filter((r) => String(r.order_number || '').includes(q));
      others = sellerOtherFin.filter((r) => String(r.order_number || '').includes(q));
      title = `#${q} sipariş no araması`;
    } else if (mode === 'receivedAll') {
      settles = scopedSettlements(); others = []; title = 'Kazanılan tüm hakediş işlemleri (takip başlangıcından beri)';
    } else {
      const set = settlementsInDateRange(), ofs = otherFinInDateRange();
      if (mode === 'all') { settles = set; others = ofs; title = 'Tüm hakediş kayıtları'; }
      else if (mode === 'commission') { settles = set.filter((r) => isSaleType(r.transaction_type)); title = 'Komisyon kesintisi olan satış işlemleri'; }
      else if (mode === 'other') { others = ofs; title = 'Kargo / ceza / platform kesintileri'; }
      else if (mode === 'return') { settles = set.filter((r) => isReturnType(r.transaction_type)); title = 'İade işlemleri'; }
    }
    if (!settles.length && !others.length) {
      host.replaceChildren(el('p', { class: 'muted', text: mode === 'search' ? `#${SRF.q} için hakediş kaydı bulunamadı — henüz gelmemiş olabilir.` : 'Bu kategoride kayıt yok.' }));
      return;
    }
    const rowsEl = [];
    settles.forEach((r) => rowsEl.push(el('tr', {},
      el('td', { text: fdate((r.transaction_date || '').slice(0, 10)) }),
      el('td', { text: r.order_number || '' }),
      el('td', { text: settleTypeLabel(r.transaction_type) }),
      el('td', { text: r.barcode || '' }),
      el('td', { text: money(-Math.abs(num(r.commission_amount))) }),
      el('td', { text: money(r.seller_revenue) }),
      el('td', { text: r.description || '' }))));
    others.forEach((r) => rowsEl.push(el('tr', {},
      el('td', { text: fdate((r.transaction_date || '').slice(0, 10)) }),
      el('td', { text: r.order_number || '' }),
      el('td', { text: (r.transaction_sub_type || r.transaction_type || 'Diğer') }),
      el('td', { text: r.barcode || '' }),
      el('td', { text: '—' }),
      el('td', { text: money(r.amount) }),
      el('td', { text: r.description || '' }))));
    host.replaceChildren(
      el('div', { class: 'tinfo' },
        el('div', { text: `${title} — ${int(rowsEl.length)} kayıt` }),
        closeSettleDetailBtn()),
      el('div', { class: 'twrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Tarih' }), el('th', { text: 'Sipariş No' }), el('th', { text: 'Tür' }), el('th', { text: 'Barkod' }), el('th', { text: 'Komisyon' }), el('th', { text: 'Tutar' }), el('th', { text: 'Açıklama' }))),
        el('tbody', {}, ...rowsEl))));
  }
  function renderSettlePending() {
    const host = $('#settlePending'); if (!host) return;
    const settledOrderNos = new Set(sellerSettlements.map((r) => r.order_number).filter(Boolean));
    const delivered = sellerOrders.filter((r) => sellerStatusGroup(r.status) === 'delivered' && !isCancelledOrder(r));
    const pending = delivered.filter((r) => !settledOrderNos.has(r.order_number)).sort((a, b) => (b.order_date || '').localeCompare(a.order_date || ''));
    if (!pending.length) { host.replaceChildren(el('p', { class: 'muted', text: 'Teslim edilen tüm siparişlerin hakedişi gelmiş görünüyor. 👍' })); return; }
    const rowsEl = pending.slice(0, 200).map((r) => el('tr', {},
      el('td', { text: fdate((r.order_date || '').slice(0, 10)) }),
      el('td', { text: r.order_number || '' }),
      el('td', { text: r.products || '' }),
      el('td', { text: money(r.gross_amount) })));
    host.replaceChildren(
      el('p', { class: 'muted', text: `${int(pending.length)} sipariş · toplam ${money(sumBy(pending, (r) => r.gross_amount))}` }),
      el('div', { class: 'twrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Tarih' }), el('th', { text: 'Sipariş No' }), el('th', { text: 'Ürün' }), el('th', { text: 'Tutar' }))),
        el('tbody', {}, ...rowsEl))));
  }
  function renderSettlementReport() {
    if ($('#settleSub')) $('#settleSub').textContent = syncStatusText();
    renderSettleTotals();
    renderSettleCards();
    renderSettleTrend();
    renderSettleDetail();
    renderSettlePending();
  }

  // ---------- Tahmini / Kesin kârlılık — v_ty_seller_orders_detail satırlarından ----------
  // İptal edilen siparişler hariç tutulur (onlar zaten ayrı "İptaller" kartında gösteriliyor).
  // Tahmini: her zaman hesaplanabilir (gerçek veri geldiyse gerçeği, gelmediyse formül/tahmini kullanır).
  // Kesin: SADECE komisyonu VE kargosu gerçek veriyle kesinleşmiş siparişleri toplar.
  function profitAgg(list) {
    const active = (list || []).filter((r) => !isClosedSellerOrder(r));
    const revenue = sumBy(active, (r) => num(r.gross_amount));
    const cost = sumBy(active, (r) => r.estimated_cost);
    const commission = sumBy(active, (r) => (r.commission_amount != null ? num(r.commission_amount) : -num(r.commission_estimated)));
    const cargo = sumBy(active, (r) => (r.cargo_fee != null ? num(r.cargo_fee) : -num(r.cargo_estimated)));
    const returnCargo = sumBy(active, (r) => num(r.return_cargo_fee));
    const penalty = sumBy(active, (r) => num(r.penalty_fee));
    const returnAmt = sumBy(active, (r) => num(r.return_amount));
    const otherAmt = sumBy(active, (r) => num(r.other_amount));
    // v10: "İndirim" (total_discount) burada TOPLAMA dahil edilmiyor. Trendyol'un gross_amount'u
    // (totalPrice tercih edilerek dolduruluyor) ZATEN indirim düşülmüş net tutar olduğu için,
    // indirimi burada ayrıca bir "kesinti" olarak toplarsak iki kere sayılmış olur (revenue zaten
    // indirimli). "İndirim" sütunu bilgi amaçlı ayrı tabloda gösterilmeye devam ediyor, sadece bu
    // toplama dahil edilmiyor — SQL'deki net_profit_estimated ile birebir tutarlı kalması için.
    const discount = -sumBy(active, (r) => num(r.total_discount));
    const platform = active.length * -13.19;
    const stopaj = -sumBy(active, (r) => num(r.stopaj_amount));
    // Toplam Kesintiler: kargo+iade kargo+ceza+iade+diğer+platform+stopaj — hepsi burada
    // NEGATİF (kesinti) işaretiyle, aynen net_profit_estimated'in SQL'de çıkardığı kalemler.
    // Kart göstermek için mutlak değeri kullanılıyor.
    const allDeductions = cargo + returnCargo + penalty + returnAmt + otherAmt + platform + stopaj;
    const netEstimated = sumBy(active, (r) => num(r.net_profit_estimated));
    const confirmedRows = active.filter((r) => r.fully_confirmed);
    const netConfirmed = confirmedRows.length ? sumBy(confirmedRows, (r) => num(r.net_profit_confirmed)) : null;
    return { n: active.length, revenue, cost, commission, cargo, returnCargo, penalty, returnAmt, otherAmt, discount,
      platform, stopaj, allDeductions, netEstimated, netConfirmed,
      confirmedCount: confirmedRows.length, pendingCount: active.length - confirmedRows.length };
  }
  // Kesinleşen Kâr: kargo faturasının gerçek gelmesini bekleyen eski tanım yerine, artık
  // "Teslim Edildi" durumundaki siparişlerin kârını toplar (kesinleşmiş kabul edilir — kargo
  // faturası ayrıca gelirse net_profit_confirmed zaten onu kullanır, gelmediyse tahmini formül
  // kullanılır, ama sipariş TESLİM olduğu için artık "kesin" sayılabilir).
  function deliveredProfit(list) {
    const delivered = (list || []).filter((r) => sellerStatusGroup(r.status) === 'delivered');
    const sum = sumBy(delivered, (r) => (r.fully_confirmed && r.net_profit_confirmed != null ? num(r.net_profit_confirmed) : num(r.net_profit_estimated)));
    return { n: delivered.length, sum };
  }

  // ---------- "Siparişler" sekmesi: mağazaya gelen siparişler, API'den otomatik ----------
  function renderStoreOrdersCards(rs) {
    const host = $('#storeOrdersCards'); if (!host) return;
    const card = (cls, lbl, big, sub, onClick) => el('div', { class: 'card ' + cls + (onClick ? ' clickable' : ''), title: onClick ? 'Hangi siparişler olduğunu görmek için tıkla' : '', onclick: onClick },
      el('div', { class: 'lbl', text: lbl }), el('div', { class: 'big', text: big }), el('div', { class: 'sub', text: sub || '' }));
    if (!sellerOrders.length) {
      host.replaceChildren(card('preparing', 'Henüz sipariş yok', '—', 'Satıcı senkronu ilk çalıştığında burada görünecek'));
      return;
    }
    if (!rs.length) {
      host.replaceChildren(card('preparing', 'Bu tarih aralığında kayıt yok', '—', `toplam ${int(sellerOrders.length)} sipariş var, tarih filtresini kontrol et`));
      return;
    }
    const active = rs.filter((r) => !isClosedSellerOrder(r));
    const activeGross = sumBy(active, (r) => r.gross_amount);
    const cancelOnly = rs.filter(isCancelledOrder).length;
    const undeliveredCount = rs.filter(isUnDeliveredPendingOrder).length;
    const costMissingCount = rs.filter((r) => r.cost_missing).length;
    const agg = profitAgg(rs);
    const dp = deliveredProfit(rs);
    // v20: cancelledCount artık SADECE iptal + KESİNLEŞMİŞ iade (isClosedSellerOrder'daki düzeltmeyle
    // uyumlu) — "UnDelivered" (henüz süreç bitmedi) artık aktife dahil, ayrı bilgi olarak gösteriliyor.
    const cancelledCount = rs.length - active.length;
    const activeQty = sumBy(active, (r) => r.qty);
    host.replaceChildren(
      card('total', 'Toplam Satış', money(activeGross), `${int(active.length)} sipariş · ${int(activeQty)} adet`),
      // Umit'in isteğiyle: büyük rakam artık iptalleri SAYMIYOR (iptaller hariç aktif sipariş
      // sayısı) — iptal/iade sayısı ayrı bir bilgi olarak alt satırda gösteriliyor.
      card('onway', 'Sipariş Adeti', int(active.length), `${int(activeQty)} adet` + (cancelledCount ? ` · ${int(cancelOnly)} iptal · ${int(cancelledCount - cancelOnly)} kesinleşmiş iade (dahil değil)` : ' · iptal/iade yok') + (undeliveredCount ? ` · ${int(undeliveredCount)} teslim edilemedi (satışa dahil)` : '')),
      card('onway', 'Toplam Komisyon', money(-agg.commission), 'sipariş anında kesinleşen oran'),
      card('preparing', 'Toplam Kesintiler', money(-agg.allDeductions), 'kargo+ceza+diğer+platform+stopaj'),
      card('onway', 'Toplam Ürün Maliyeti', money(agg.cost), costMissingCount ? `* ${int(costMissingCount)} siparişte ürün maliyeti eksik` : 'FİFO (alım sırasına göre); veri yoksa son alımların ortalaması'),
      card(agg.netEstimated < 0 ? 'closed' : 'delivered', 'Tahmini Net Kâr', money(agg.netEstimated), 'satış − (komisyon+kesintiler+ürün maliyeti)'),
      card(dp.n ? (dp.sum < 0 ? 'closed' : 'delivered') : 'preparing', 'Kesinleşen Kâr',
        dp.n ? money(dp.sum) : '—', dp.n ? `${int(dp.n)} teslim edilen sipariş` : 'henüz teslim edilen sipariş yok',
        dp.n ? goToDeliveredOrders : null));
  }
  function renderStoreOrdersStats(rs) {
    const host = $('#storeOrdersStats'); if (!host) return;
    if (!rs.length) { host.textContent = ''; return; }
    // İptal edilen siparişler ayrı sayılır (onlar için "masraf hesaplanmadı" demek yanıltıcı olur —
    // zaten iptal olduğu bilgisi net). Kalanlar arasında kargo/ceza/iade bilgisi gelmiş mi bakılır.
    const cancelled = rs.filter(isCancelledOrder);
    const rest = rs.filter((r) => !isCancelledOrder(r));
    const calculated = rest.filter(hasExtraCosts).length;
    const notCalculated = rest.length - calculated;
    host.textContent = `Komisyon dışındaki masrafları (kargo/ceza/iade) hesaplanmış sipariş: ${calculated} · henüz hesaplanmamış: ${notCalculated} · iptal: ${cancelled.length}`;
  }
  async function handleOrderCostsFile(file) {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const sheetName = wb.SheetNames.includes('Siparisler') ? 'Siparisler' : wb.SheetNames[0];
      const json = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
      if (!json.length) return banner('Excel dosyasında satır bulunamadı.');
      const n2 = (v) => (v == null || v === '' ? null : Number(v));
      const dt = (v) => {
        if (v == null || v === '') return null;
        if (v instanceof Date) return v.toISOString();
        const s = String(v).trim();
        const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
        if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)).toISOString();
        const d = new Date(s);
        return isNaN(d) ? null : d.toISOString();
      };
      const mapped = json.map((row) => ({
        order_number: String(row['Sipariş No'] ?? '').trim(),
        order_date: dt(row['Sipariş Tarihi']),
        order_status: row['Sipariş Statüsü'] || null,
        gross_amount: n2(row['Sipariş Tutarı']),
        commission_amount: n2(row['Komisyon/Yurt Dışı Stok Destek Bedeli']),
        discount_amount: n2(row['İndirim']),
        cargo_fee: n2(row['Gönderi Kargo Bedeli']),
        return_cargo_fee: n2(row['İade Kargo Bedeli']),
        penalty_fee: n2(row['Ceza Bedeli']),
        cancel_amount: n2(row['İptal']),
        return_amount: n2(row['İade']),
        other_amount: n2(row['Diğer']),
        net_amount: n2(row['Net Tutar']),
      })).filter((r) => r.order_number);
      if (!mapped.length) return banner('Excel dosyasında geçerli "Sipariş No" bulunamadı. Doğru raporu mu yüklediniz?');
      const res = await call({ type: 'API', method: 'POST', path: '/rest/v1/rpc/ty_import_seller_order_costs', body: { p_rows: mapped } });
      const importedN = (res && res.imported) != null ? res.imported : mapped.length;
      toast(`${int(importedN)} sipariş kaydı içe aktarıldı ✓`);
      await load();
    } catch (e) {
      banner('Excel içe aktarılamadı: ' + (e.message || e));
    }
  }

  const tables = {};
  function initTables() {
    tables.items = makeTable($('#tItems'), itemCols, filteredRows, { sortKey: 'order_date', sortDir: -1, empty: 'Filtreye uyan kalem yok',
      summary: (d) => `${int(d.length)} kalem · ${int(sumBy(d, (r) => r.quantity))} adet · ${money(sumBy(d, (r) => r.line_total))}` });
    tables.orders = makeTable($('#tOrders'), orderCols, () => orderRows(filteredRows()), { sortKey: 'order_date', sortDir: -1, empty: 'Filtreye uyan sipariş yok',
      summary: (d) => `${int(d.length)} sipariş · kalem tutarı ${money(sumBy(d, (r) => r.itemsTotal))}` });
    tables.stock = makeTable($('#tStock'), stockCols, filteredStock, { sortKey: 'current_stock', sortDir: -1, empty: 'Stok kartı yok',
      summary: (d) => {
        const pend = sumBy(d, (r) => r.pending_qty);
        return `${int(d.length)} ürün · mevcut stok ${int(sumBy(d, (r) => r.current_stock))} adet`
          + (pend > 0 ? ` · hazırlanıyor (durumu netleşmemiş): ${int(pend)} adet` : '')
          + ` · toplam maliyet: ${money(stockTotalValue(d))}`;
      } });
    tables.expenses = makeTable($('#tExpenses'), expenseCols, filteredExpenses, { sortKey: 'expense_date', sortDir: -1, empty: 'Filtreye uyan gider yok',
      summary: (d) => `${int(d.length)} gider · toplam ${money(sumBy(d, (r) => r.amount))}` });
    tables.invoices = makeTable($('#tInvoices'), invoiceCols, filteredInvoices, { sortKey: 'order_date', sortDir: -1, empty: 'Kontrol edilecek paket yok 🎉',
      summary: (d) => `${int(d.length)} paket` });
    tables.seller = makeTable($('#tSeller'), sellerCols, filteredSeller, { sortKey: 'revenue', sortDir: -1,
      empty: 'Filtreye uyan ürün yok — kurulum rehberindeki senkron fonksiyonunu çalıştırdın mı?',
      summary: (d) => `${int(d.length)} ürün · ciro ${money(sumBy(d, (r) => r.revenue))} · net kâr ${money(sumBy(d, (r) => (r.cost_missing ? 0 : r.net_profit)))}${d.some((r) => r.cost_missing) ? ' (* maliyeti eksik ürünler hariç)' : ''}` });
    tables.sellerOrders = makeTable($('#tSellerOrders'), sellerOrderCols, filteredSellerOrders, { sortKey: 'order_date', sortDir: -1,
      empty: 'Filtreye uyan sipariş yok',
      // İptal edilen siparişte tüm masraf/kâr rakamları anlamsız (Trendyol'dan zaten hiç ödeme
      // gelmiyor) — satırı görsel olarak "etkisiz" göster (üstü çizili, soluk), yanlış rakamlar
      // gerçekmiş gibi görünmesin.
      rowClass: (r) => (isCancelledOrder(r) ? 'row-cancelled' : ''),
      summary: (d) => `${int(d.length)} sipariş · tutar ${money(sumBy(d, (r) => r.gross_amount))}` });
  }

  // ---------- düzenleme / silme ----------
  async function deleteOrder(r) {
    if (!confirm(`#${r.order_no} siparişi ve tüm kalemleri silinsin mi?\n(Trendyol'da bu siparişi tekrar açarsan eklenti yeniden ekler.)`)) return;
    try {
      await call({ type: 'API', method: 'DELETE', path: `/rest/v1/ty_orders?id=eq.${encodeURIComponent(r.order_id)}`, prefer: 'return=minimal' });
      await load();
    } catch (e) { banner('Silinemedi: ' + e.message); }
  }

  async function ignoreOrder(r) {
    if (!confirm(`#${r.order_no} kalıcı olarak yoksayılsın mı?\n\nBu sipariş silinir, artık başka hiçbir siparişte geçmeyen ürün/marka/satıcı kartları da temizlenir, ve bir daha ASLA otomatik kaydedilmez — Trendyol'da tekrar açsan ya da "Bekleyen siparişleri güncelle" onu tekrar bulsa bile eklenti görmezden gelir.`)) return;
    try {
      const res = await call({ type: 'API', method: 'POST', path: '/rest/v1/rpc/ty_ignore_order', body: { p_order_no: r.order_no } });
      const extra = [];
      if (res.products_removed) extra.push(`${res.products_removed} ürün`);
      if (res.sellers_removed) extra.push(`${res.sellers_removed} satıcı`);
      if (res.brands_removed) extra.push(`${res.brands_removed} marka`);
      toast('Yoksayma listesine eklendi ✓' + (extra.length ? ` (ayrıca temizlendi: ${extra.join(', ')})` : ''));
      await load();
    } catch (e) { banner('Yoksayılamadı: ' + e.message); }
  }

  async function editMinStock(p) {
    const v = prompt(`"${p.product_name}" için minimum stok adedi:`, String(p.min_stock || 0));
    if (v === null) return;
    const n = parseInt(v, 10);
    if (!Number.isInteger(n) || n < 0) return banner('Geçerli bir sayı gir.');
    try {
      await call({ type: 'API', method: 'PATCH', path: `/rest/v1/ty_products?id=eq.${encodeURIComponent(p.product_id)}`, body: { min_stock: n }, prefer: 'return=minimal' });
      await load();
    } catch (e) { banner('Kaydedilemedi: ' + e.message); }
  }

  async function deleteExpense(r) {
    if (!confirm(`"${r.title}" gideri silinsin mi?`)) return;
    try {
      await call({ type: 'API', method: 'DELETE', path: `/rest/v1/expenses?id=eq.${encodeURIComponent(r.id)}`, prefer: 'return=minimal' });
      toast('Silindi ✓');
      await load();
    } catch (e) { banner('Silinemedi: ' + e.message); }
  }

  const MOVES = [['sale', 'Satış'], ['adjustment', 'Sayım düzeltme (+ veya −)'], ['opening_stock', 'Açılış stoğu'], ['return_to_stock', 'Stoğa iade'], ['damaged', 'Fire / hasar'], ['gift', 'Hediye']];
  const MOVE_TR = Object.fromEntries(MOVES.map(([k, v]) => [k, v.replace(/ \(.*\)/, '')]));

  function closeModal() { $('#modal').classList.add('hide'); $('#modal').replaceChildren(); }

  async function openStockModal(p) {
    const modal = $('#modal');
    const type = el('select', {}, MOVES.map(([v, l]) => el('option', { value: v, text: l })));
    const qty = el('input', { type: 'number', step: '1', placeholder: 'Adet (ör. 2)' });
    const price = el('input', { type: 'number', step: '0.01', placeholder: 'Satış fiyatı (birim, ₺)' });
    const date = el('input', { type: 'date' }); date.value = iso(new Date());
    const note = el('input', { type: 'text', placeholder: 'Not (isteğe bağlı)' });
    const err = el('div', { class: 'err' });
    const hist = el('div', { class: 'muted', text: 'Geçmiş hareketler yükleniyor…' });
    const priceRow = el('div', { class: 'row' }, el('label', { text: 'Satış fiyatı (₺)' }), price);
    type.addEventListener('change', () => priceRow.classList.toggle('hide', type.value !== 'sale'));

    const save = async () => {
      const q = parseInt(qty.value, 10);
      if (!q) { err.textContent = 'Adet gir (0 olamaz).'; return; }
      const t = type.value;
      let sq = q;
      if (['sale', 'damaged', 'gift'].includes(t)) sq = -Math.abs(q);
      else if (['opening_stock', 'return_to_stock'].includes(t)) sq = Math.abs(q);
      try {
        await call({ type: 'API', method: 'POST', path: '/rest/v1/ty_stock_movements', prefer: 'return=minimal',
          body: { product_id: p.product_id, movement_type: t, quantity: sq, unit_price: t === 'sale' && price.value !== '' ? Number(price.value) : null,
            moved_at: new Date((date.value || iso(new Date())) + 'T12:00:00').toISOString(), note: note.value || null } });
        closeModal(); await load();
      } catch (e) { err.textContent = 'Kaydedilemedi: ' + e.message; }
    };

    modal.replaceChildren(el('div', { class: 'mbox' },
      el('h2', { text: 'Stok hareketi — ' + p.product_name }),
      el('div', { class: 'muted', text: `Şu an stok: ${int(p.current_stock)} adet. Satış/fire/hediye girerken pozitif sayı yaz, stoktan düşer.` }),
      el('div', { class: 'row' }, el('label', { text: 'Hareket türü' }), type),
      el('div', { class: 'row' }, el('label', { text: 'Adet' }), qty),
      priceRow,
      el('div', { class: 'row' }, el('label', { text: 'Tarih' }), date),
      el('div', { class: 'row' }, el('label', { text: 'Not' }), note),
      err,
      el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Kapat', onclick: closeModal }), el('button', { class: 'btn primary', text: 'Kaydet', onclick: save })),
      el('h3', { text: 'Ürün hareket geçmişi (giriş / çıkış)', style: 'margin-top:16px' }),
      el('div', { class: 'muted', style: 'margin-bottom:6px', text: 'Alımlar (Trendyol siparişleri), mağaza satışların ve manuel hareketlerin HEPSİ tek listede, tarihe göre.' }),
      hist));
    modal.classList.remove('hide');
    priceRow.classList.add('hide');

    // DÜZELTME (Ekim 2026 — Ümit): eskiden burada SADECE elle girilen hareketler (ty_stock_movements)
    // görünüyordu; Trendyol'dan yapılan alımlar ve kendi mağazandan yapılan satışlar hiç yoktu.
    // ty_product_movements() RPC'si üçünü birleştirip tek bir zaman çizelgesi döndürüyor.
    const SOURCE_BADGE = { 'Alım': 'g-delivered', 'Mağaza Satışı': 'g-onway', 'Manuel': 'g-preparing' };
    try {
      const list = await call({ type: 'API', method: 'POST', path: '/rest/v1/rpc/ty_product_movements', body: { p_product_id: p.product_id } });
      hist.replaceChildren();
      if (!list.length) hist.textContent = 'Henüz hiç hareket yok.';
      list.forEach((m) => hist.append(el('div', { class: 'mv' },
        el('span', { class: 'badge ' + (SOURCE_BADGE[m.source] || ''), text: m.source }),
        el('span', { text: ` ${fdate(m.move_date)} · ${m.direction === 'in' ? '+' : '−'}${int(m.quantity)} adet`
          + `${m.unit_price != null ? ' · ' + money(m.unit_price) : ''}${m.ref ? ' · ' + m.ref : ''}${m.status ? ' · ' + (STATUS_TR[m.status] || MOVE_TR[m.status] || m.status) : ''}` }),
        m.id ? el('button', { class: 'btn sm danger', text: 'Sil', onclick: async () => {
          if (!confirm('Bu manuel hareket silinsin mi?')) return;
          try { await call({ type: 'API', method: 'DELETE', path: `/rest/v1/ty_stock_movements?id=eq.${encodeURIComponent(m.id)}`, prefer: 'return=minimal' }); closeModal(); await load(); }
          catch (e) { err.textContent = 'Silinemedi: ' + e.message; }
        } }) : null)));
    } catch (e) { hist.textContent = 'Geçmiş alınamadı: ' + e.message; }
  }


  // ---------- komisyon & kârlılık hesaplama ----------
  // Not: tüm ₺ alanları KDV DAHİL girilir (Trendyol'un kendi hesaplama aracıyla aynı mantık).
  // Formül, kullanıcının Trendyol'un resmi hesaplama aracıyla ürettiği gerçek bir örnekle
  // (Alış 157₺, Kargo 99₺, Satış 399₺, KDV %20 -> Komisyon 71,82₺, Hizmet Bedeli 13,19₺,
  // Stopaj 3,33₺, Ödenecek KDV 9,67₺, Net Kâr 45₺) birebir doğrulanarak yazıldı.
  function openProfitCalcModal() {
    const modal = $('#modal');
    const prodLabel = (p) => (p.brand ? p.brand + ' — ' : '') + (p.product_name || '');
    const prodByLabel = new Map(stock.map((p) => [prodLabel(p), p]));
    const prodInput = el('input', { type: 'text', list: 'calcProdList', placeholder: 'Ürün ara (yazarak seç — opsiyonel)' });
    const prodList = el('datalist', { id: 'calcProdList' },
      [...prodByLabel.keys()].sort((a, b) => a.localeCompare(b, 'tr')).map((lbl) => el('option', { value: lbl })));
    const cost = el('input', { type: 'number', step: '0.01', min: '0', placeholder: 'Alış fiyatı (₺, KDV dahil)' });
    const comm = el('input', { type: 'number', step: '0.1', min: '0', placeholder: 'Komisyon oranı (%)' });
    const ship = el('input', { type: 'number', step: '0.01', min: '0', value: '0' });
    const shipBy = el('select', {}, el('option', { value: 'seller', text: 'Kargo satıcıya ait' }), el('option', { value: 'buyer', text: 'Kargo alıcıya ait' }));
    const svc = el('input', { type: 'number', step: '0.01', min: '0', value: '13.19' });
    const stopaj = el('input', { type: 'number', step: '0.1', min: '0', value: '1' });
    const kdvRate = el('select', {}, el('option', { value: '20', text: '%20' }), el('option', { value: '10', text: '%10' }), el('option', { value: '1', text: '%1' }), el('option', { value: 'diger', text: 'Diğer' }));
    const kdvCustom = el('input', { type: 'number', step: '0.1', min: '0', placeholder: 'KDV oranı (%)', class: 'hide' });
    const price = el('input', { type: 'number', step: '0.01', min: '0', placeholder: 'Satış fiyatı (₺, KDV dahil)' });
    const out = el('div', {});

    const row = (lbl, val, cls) => el('div', { class: 'calc-row' + (cls ? ' ' + cls : '') }, el('span', { text: lbl }), el('b', { text: val }));
    const pct = (n) => (isFinite(n) ? n.toFixed(1).replace('.', ',') + '%' : '—');

    function compute() {
      const kr = (kdvRate.value === 'diger' ? num(kdvCustom.value) : num(kdvRate.value)) / 100;
      const dahilToKdv = (v) => v * kr / (1 + kr); // KDV dahil tutarın içindeki KDV payı

      const satisDahil = num(price.value);
      const alisDahil = num(cost.value);
      const kargoDahil = shipBy.value === 'seller' ? num(ship.value) : 0;
      const komisyonDahil = satisDahil * num(comm.value) / 100;
      const hizmetDahil = num(svc.value);
      const stopajBedeli = (satisDahil / (1 + kr)) * num(stopaj.value) / 100; // KDV hariç satış fiyatı üzerinden

      const odenecekKdv = dahilToKdv(satisDahil) - dahilToKdv(alisDahil) - dahilToKdv(kargoDahil) - dahilToKdv(komisyonDahil) - dahilToKdv(hizmetDahil);

      const netKar = satisDahil - alisDahil - kargoDahil - komisyonDahil - hizmetDahil - stopajBedeli - odenecekKdv;
      const karOraniAlisaGore = alisDahil ? (netKar / alisDahil * 100) : NaN;
      const alisHaric = alisDahil / (1 + kr);
      const roi = alisHaric ? (netKar / alisHaric * 100) : NaN;
      const cls = satisDahil || alisDahil ? (netKar < 0 ? 'neg' : 'pos') : '';
      const masraflarDahilMaliyet = alisDahil + kargoDahil + komisyonDahil + hizmetDahil + stopajBedeli + odenecekKdv;

      out.replaceChildren(
        row('Alış fiyatı (KDV dahil)', money(alisDahil)),
        row('Kargo bedeli' + (shipBy.value === 'seller' ? ' (satıcıya ait)' : ' (alıcıya ait, maliyete dahil değil)'), money(kargoDahil)),
        row('Komisyon tutarı (KDV dahil)', money(komisyonDahil)),
        row('Platform hizmet bedeli', money(hizmetDahil)),
        row('Stopaj bedeli', money(stopajBedeli)),
        row('Ödenecek KDV', money(odenecekKdv)),
        el('div', { class: 'calc-divider' }),
        row('Masraflar dahil ürün maliyeti toplamı', money(masraflarDahilMaliyet)),
        el('div', { class: 'calc-divider' }),
        row('Net kâr', money(netKar), cls),
        row('Kâr oranı (alış fiyatına göre)', pct(karOraniAlisaGore), cls),
        row('Yatırım geri dönüş oranı (ROI, KDV hariç alışa göre)', pct(roi), cls));
    }
    prodInput.addEventListener('input', () => {
      const p = prodByLabel.get(prodInput.value);
      if (p && p.avg_unit_price != null) cost.value = num(p.avg_unit_price).toFixed(2);
      compute();
    });
    kdvRate.addEventListener('change', () => { kdvCustom.classList.toggle('hide', kdvRate.value !== 'diger'); compute(); });
    [cost, comm, ship, shipBy, svc, stopaj, kdvCustom, price].forEach((i) => i.addEventListener('input', compute));

    modal.replaceChildren(el('div', { class: 'mbox wide' },
      el('h2', { text: 'Komisyon & Kârlılık Hesapla' }),
      el('div', { class: 'muted', text: 'Trendyol\'un kategori bazlı komisyon tablosu yerine kendi komisyon oranını gir. Tüm ₺ alanları KDV dahildir. İstersen önce envanterinden bir ürün ara, ortalama alış maliyeti otomatik gelsin.', style: 'margin-bottom:10px' }),
      el('div', { class: 'two' },
        el('div', {},
          el('div', { class: 'row' }, el('label', { text: 'Ürün (opsiyonel)' }), prodInput, prodList),
          el('div', { class: 'row' }, el('label', { text: 'Alış fiyatı (₺, KDV dahil)' }), cost),
          el('div', { class: 'row' }, el('label', { text: 'Komisyon oranı (%)' }), comm),
          el('div', { class: 'two' },
            el('div', { class: 'row' }, el('label', { text: 'Kargo ücreti (₺, KDV dahil)' }), ship),
            el('div', { class: 'row' }, el('label', { text: 'Kargo kime ait' }), shipBy)),
          el('div', { class: 'two' },
            el('div', { class: 'row' }, el('label', { text: 'Platform hizmet bedeli (₺, KDV dahil)' }), svc),
            el('div', { class: 'row' }, el('label', { text: 'Stopaj oranı (%)' }), stopaj)),
          el('div', { class: 'two' },
            el('div', { class: 'row' }, el('label', { text: 'KDV oranı' }), kdvRate),
            el('div', { class: 'row' }, el('label', { text: ' ' }), kdvCustom)),
          el('div', { class: 'row' }, el('label', { text: 'Satış fiyatı (₺, KDV dahil)' }), price)),
        el('div', { class: 'calc-result' }, el('h3', { text: 'Hesaplama sonucu' }), out)),
      el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Kapat', onclick: closeModal }))));
    modal.classList.remove('hide');
    compute();
  }

  // ---------- şifre değiştir ----------
  function openPasswordModal() {
    const modal = $('#modal');
    const p1 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'En az 6 karakter' });
    const p2 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Yeni şifreyi tekrar yaz' });
    const err = el('div', { class: 'err' });
    const save = async () => {
      if (p1.value.length < 6) { err.textContent = 'Şifre en az 6 karakter olmalı.'; return; }
      if (p1.value !== p2.value) { err.textContent = 'İki şifre birbiriyle uyuşmuyor.'; return; }
      err.textContent = 'Güncelleniyor…';
      try {
        await call({ type: 'CHANGE_PASSWORD', password: p1.value });
        closeModal();
        toast('Şifre değiştirildi ✓ Yeni şifreni not al, bir dahaki girişte bunu kullanacaksın.');
      } catch (e) { err.textContent = 'Değiştirilemedi: ' + e.message; }
    };
    modal.replaceChildren(el('div', { class: 'mbox' },
      el('h2', { text: 'Şifre değiştir' }),
      el('div', { class: 'muted', text: 'Bu, Supabase hesabının (hem bu panel hem eklenti hem de admin panelin ortak giriş) şifresini değiştirir.' }),
      el('div', { class: 'row' }, el('label', { text: 'Yeni şifre' }), p1),
      el('div', { class: 'row' }, el('label', { text: 'Yeni şifre (tekrar)' }), p2),
      err,
      el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Vazgeç', onclick: closeModal }), el('button', { class: 'btn primary', text: 'Kaydet', onclick: save }))));
    modal.classList.remove('hide');
  }

  function toast(msg) {
    const t = el('div', { class: 'toast', text: msg });
    document.body.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  async function markDelivered(r) {
    if (!confirm(`#${r.order_no} teslim alındı olarak işaretlensin mi?`)) return;
    try {
      await call({ type: 'API', method: 'PATCH', path: `/rest/v1/ty_shipments?order_id=eq.${encodeURIComponent(r.order_id)}&status=not.in.(delivered,cancelled,returned)`,
        body: { status: 'delivered', delivered_at: iso(new Date()) }, prefer: 'return=minimal' });
      toast('Teslim alındı olarak işaretlendi ✓');
      await load();
    } catch (e) { banner('Güncellenemedi: ' + e.message); }
  }

  // ---------- manuel alım ----------
  // v14: hem "Manuel alım ekle" hem "Düzenle" modalındaki ürün satırlarını aynı mantıkla
  // kurmak için ortak yardımcı — Ürün linki (product_url) alanı da burada eklendi.
  function makeItemLine(pmap, smap, recalc, initial) {
    const l = { pid: (initial && initial.pid) || null, imageUrl: (initial && initial.imageUrl) || null };
    l.name = el('input', { type: 'text', list: 'dlProds', placeholder: 'Ürün adı (listeden seçersen mevcut stok kartına eklenir)' });
    l.brand = el('input', { type: 'text', placeholder: 'Marka' });
    l.qty = el('input', { type: 'number', min: '1', step: '1', value: '1' });
    l.price = el('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Birim ₺' });
    l.url = el('input', { type: 'text', placeholder: 'Trendyol ürün linki (isteğe bağlı)' });
    if (initial) {
      l.name.value = initial.name || '';
      l.brand.value = initial.brand || ''; l.brand.disabled = !!initial.pid;
      if (initial.qty != null) l.qty.value = initial.qty;
      if (initial.price != null) l.price.value = initial.price;
      l.url.value = initial.url || '';
    }
    l.name.addEventListener('input', () => {
      const p = pmap.get(l.name.value);
      if (p) { l.pid = p.product_id; l.imageUrl = null; l.brand.value = p.brand || ''; l.brand.disabled = true; l.name.value = p.product_name; if (p.last_unit_price != null && l.price.value === '') l.price.value = p.last_unit_price; }
      else {
        const sp = smap.get(l.name.value);
        // Mağaza kataloğundan seçildi: henüz bir alıcı stok kartı yok (pid null kalır, bu alım
        // yeni bir stok kartı oluşturacak) ama marka/isim mağazadakiyle BİREBİR aynı yazılıyor —
        // mağazadaki ürün fotoğrafını da (varsa) yeni stok kartına taşıyoruz.
        if (sp) { l.pid = null; l.imageUrl = sp.image_url || null; l.brand.value = sp.brand || ''; l.brand.disabled = false; l.name.value = sp.product_name; }
        else { l.pid = null; l.imageUrl = null; l.brand.disabled = false; }
      }
      recalc();
    });
    [l.qty, l.price].forEach((i) => i.addEventListener('input', recalc));
    return l;
  }

  function buildProdMaps() {
    const pmap = new Map(); stock.forEach((p) => pmap.set((p.brand ? p.brand + ' — ' : '') + p.product_name, p));
    // v13: Umit'in isteğiyle — sadece daha önce manuel alınmış ürünler (stock) değil, Trendyol
    // mağaza kataloğundaki (sellerProfit) ürünler de öneri listesine girsin. Böylece "Axe ... 50 ml"
    // gibi mağazada zaten satılan bir ürünü, tam AYNI isim/markayla seçip manuel alım girebiliyor —
    // isim birebir eşleştiği için Mağaza & Karlılık'taki otomatik eşleşme önerisi kesin çalışır.
    // Marka/isim zaten stock'ta varsa (pmap'te) o kayıt önceliklidir (üstüne yazılmaz).
    const smap = new Map();
    sellerProfit.forEach((p) => {
      const key = (p.brand ? p.brand + ' — ' : '') + p.product_name;
      if (p.product_name && !pmap.has(key) && !smap.has(key)) smap.set(key, p);
    });
    return { pmap, smap };
  }

  function itemsHeaderRow() {
    return el('div', { class: 'irow hdr' }, el('span', { text: 'Ürün' }), el('span', { text: 'Marka' }), el('span', { text: 'Adet' }), el('span', { text: 'Birim ₺' }), el('span', { text: 'Ürün linki' }), el('span'));
  }

  function openManualModal() {
    const modal = $('#modal');
    const accounts = uniq([...CFG_ACCOUNTS, ...rows.map((r) => r.buyer_account).filter(Boolean)]);
    const stores = uniq(rows.filter((r) => r.order_source === 'manual').map((r) => r.seller_name).filter(Boolean));
    const { pmap, smap } = buildProdMaps();
    const dl = (id, arr) => el('datalist', { id }, arr.map((v) => el('option', { value: v })));
    const F2 = (label, node) => el('div', { class: 'row' }, el('label', { text: label }), node);

    const store = el('input', { type: 'text', list: 'dlStores', placeholder: 'Örn. Hepsiburada, Amazon, market adı' });
    const date = el('input', { type: 'date' }); date.value = iso(new Date());
    const acct = el('input', { type: 'text', list: 'dlAccts' }); acct.value = accounts[0] || DEF_ACCT;
    const status = el('select', {}, [['delivered', 'Teslim edildi'], ['shipped', 'Yolda'], ['preparing', 'Hazırlanıyor']].map(([v, l]) => el('option', { value: v, text: l })));
    const ship = el('input', { type: 'number', step: '0.01', min: '0', placeholder: '0' });
    const url = el('input', { type: 'text', placeholder: 'https://… (isteğe bağlı sipariş linki)' });
    // v13: Umit'in isteğiyle — manuel alımlarını sonradan fatura numarasıyla bulabilmesi için.
    const invoiceNo = el('input', { type: 'text', placeholder: 'Fatura no (isteğe bağlı)' });
    const note = el('input', { type: 'text', placeholder: 'Not (isteğe bağlı)' });
    const total = el('div', { class: 'big', text: money(0) });
    const err = el('div', { class: 'err' });
    const host = el('div');
    const lines = [];

    const recalc = () => { total.textContent = 'Toplam: ' + money(lines.reduce((a, l) => a + num(l.qty.value) * num(l.price.value), 0) + num(ship.value)); };
    function addLine(initial) {
      const l = makeItemLine(pmap, smap, recalc, initial);
      l.row = el('div', { class: 'irow' }, l.name, l.brand, l.qty, l.price, l.url,
        el('button', { class: 'btn sm danger', text: '✕', title: 'Satırı sil', onclick: () => { if (lines.length > 1) { lines.splice(lines.indexOf(l), 1); l.row.remove(); recalc(); } } }));
      lines.push(l); host.append(l.row); recalc();
    }
    ship.addEventListener('input', recalc);
    addLine();

    const save = async () => {
      err.textContent = '';
      const items = lines.filter((l) => l.name.value.trim()).map((l) => ({ product_id: l.pid, brand: l.brand.value.trim(), name: l.name.value.trim(), image_url: l.imageUrl || null, product_url: l.url.value.trim() || null, quantity: parseInt(l.qty.value, 10), unit_price: l.price.value === '' ? null : Number(l.price.value) }));
      if (!items.length) { err.textContent = 'En az bir ürün gir.'; return; }
      if (items.some((i) => !(i.quantity > 0) || i.unit_price == null || i.unit_price < 0)) { err.textContent = 'Her ürün için adet ve birim fiyat gir.'; return; }
      if (url.value && !/^https:\/\//.test(url.value.trim())) { err.textContent = 'Sipariş linki https:// ile başlamalı.'; return; }
      if (items.some((i) => i.product_url && !/^https:\/\//.test(i.product_url))) { err.textContent = 'Ürün linki https:// ile başlamalı.'; return; }
      try {
        const payload = { store: store.value.trim(), order_date: date.value, buyer_account: acct.value.trim(), status: status.value,
          shipping_fee: ship.value === '' ? 0 : Number(ship.value), url: url.value.trim(), invoice_no: invoiceNo.value.trim(), notes: note.value.trim(), items };
        const r = await call({ type: 'API', method: 'POST', path: '/rest/v1/rpc/ty_add_manual_purchase', body: { payload } });
        closeModal(); toast(`Kaydedildi ✓ ${r && r.order_no ? r.order_no : ''}`); await load();
      } catch (e) { err.textContent = 'Kaydedilemedi: ' + e.message; }
    };

    modal.replaceChildren(el('div', { class: 'mbox wide' },
      el('h2', { text: 'Manuel alım ekle' }),
      el('div', { class: 'muted', text: 'Trendyol dışından aldığın ürünleri buradan gir. Ürün adı kutusuna yazarken hem daha önce aldığın ürünler hem de mağaza kataloğundaki ürünler önerilir — listeden seçersen isim/marka birebir aynı yazılır, Mağaza & Karlılık\'taki otomatik eşleşme önerisi kesinleşir.' }),
      dl('dlStores', stores), dl('dlAccts', accounts), dl('dlProds', [...pmap.keys(), ...smap.keys()]),
      el('div', { class: 'two' }, F2('Mağaza / satıcı', store), F2('Alım tarihi', date)),
      el('div', { class: 'two' }, F2('Kimin hesabı / kim aldı', acct), F2('Durum', status)),
      el('h3', { text: 'Ürünler', style: 'margin-top:10px' }),
      itemsHeaderRow(),
      host,
      el('button', { class: 'btn sm', text: '+ Ürün satırı ekle', onclick: () => addLine() }),
      el('div', { class: 'two' }, F2('Kargo ücreti (₺)', ship), F2('Sipariş linki', url)),
      F2('Fatura no', invoiceNo),
      F2('Not', note), total, err,
      el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Vazgeç', onclick: closeModal }), el('button', { class: 'btn primary', text: 'Kaydet', onclick: save }))));
    modal.classList.remove('hide');
  }

  // v14: Umit'in isteğiyle — daha önce eklenmiş bir manuel alımı (silip yeniden girmeden)
  // TAMAMEN düzenleme: tarih/fatura no/not'un yanı sıra artık ürün satırları da (adet, birim
  // fiyat, ürün adı/marka, ürün linki) düzeltilebiliyor; eksik giridiği bir ürünü satır ekleyerek
  // tamamlayabiliyor, yanlış bir satırı silebiliyor. Kaydedince ty_update_manual_purchase RPC'si
  // o alımın TÜM ürün satırlarını yenileriyle değiştirip toplamları yeniden hesaplıyor.
  function openEditManualOrderModal(r) {
    const modal = $('#modal');
    const { pmap, smap } = buildProdMaps();
    const dl = (id, arr) => el('datalist', { id }, arr.map((v) => el('option', { value: v })));
    const F2 = (label, node) => el('div', { class: 'row' }, el('label', { text: label }), node);
    const existingItems = rows.filter((x) => x.order_id === r.order_id);

    const date = el('input', { type: 'date' }); date.value = r.order_date ? String(r.order_date).slice(0, 10) : '';
    const invoiceNo = el('input', { type: 'text', placeholder: 'Fatura no (isteğe bağlı)' }); invoiceNo.value = r.invoiceNo || '';
    const note = el('input', { type: 'text', placeholder: 'Not (isteğe bağlı)' }); note.value = r.notes || '';
    const ship = el('input', { type: 'number', step: '0.01', min: '0', placeholder: '0' }); ship.value = r.paid != null && r.itemsTotal != null ? Math.max(0, num(r.paid) - num(r.itemsTotal)) : '';
    const total = el('div', { class: 'big', text: money(0) });
    const err = el('div', { class: 'err' });
    const host = el('div');
    const lines = [];

    const recalc = () => { total.textContent = 'Toplam: ' + money(lines.reduce((a, l) => a + num(l.qty.value) * num(l.price.value), 0) + num(ship.value)); };
    function addLine(initial) {
      const l = makeItemLine(pmap, smap, recalc, initial);
      l.row = el('div', { class: 'irow' }, l.name, l.brand, l.qty, l.price, l.url,
        el('button', { class: 'btn sm danger', text: '✕', title: 'Satırı sil', onclick: () => { if (lines.length > 1) { lines.splice(lines.indexOf(l), 1); l.row.remove(); recalc(); } } }));
      lines.push(l); host.append(l.row); recalc();
    }
    ship.addEventListener('input', recalc);

    if (existingItems.length) {
      existingItems.forEach((it) => addLine({ pid: it.product_id, imageUrl: it.image_url || null, name: it.product_name, brand: it.brand, qty: it.quantity, price: it.unit_price, url: it.product_url }));
    } else {
      addLine();
    }

    const save = async () => {
      err.textContent = '';
      const items = lines.filter((l) => l.name.value.trim()).map((l) => ({ product_id: l.pid, brand: l.brand.value.trim(), name: l.name.value.trim(), image_url: l.imageUrl || null, product_url: l.url.value.trim() || null, quantity: parseInt(l.qty.value, 10), unit_price: l.price.value === '' ? null : Number(l.price.value) }));
      if (!items.length) { err.textContent = 'En az bir ürün olmalı.'; return; }
      if (items.some((i) => !(i.quantity > 0) || i.unit_price == null || i.unit_price < 0)) { err.textContent = 'Her ürün için adet ve birim fiyat gir.'; return; }
      if (items.some((i) => i.product_url && !/^https:\/\//.test(i.product_url))) { err.textContent = 'Ürün linki https:// ile başlamalı.'; return; }
      try {
        await call({ type: 'API', method: 'POST', path: '/rest/v1/rpc/ty_update_manual_purchase', body: {
          p_order_id: r.order_id, p_order_date: date.value || null,
          p_invoice_no: invoiceNo.value.trim() === '' ? null : invoiceNo.value.trim(), p_clear_invoice_no: invoiceNo.value.trim() === '',
          p_notes: note.value.trim() === '' ? null : note.value.trim(), p_clear_notes: note.value.trim() === '',
          p_shipping_fee: ship.value === '' ? 0 : Number(ship.value), p_items: items,
        } });
        closeModal(); toast('Kaydedildi ✓'); await load();
      } catch (e) { err.textContent = 'Kaydedilemedi: ' + e.message; }
    };

    modal.replaceChildren(el('div', { class: 'mbox wide' },
      el('h2', { text: `#${r.order_no} düzenle` }),
      el('div', { class: 'muted', text: 'Ürün satırlarını (adet, fiyat, isim, link) düzeltebilir, eksik bir ürünü satır ekleyerek tamamlayabilir ya da yanlış bir satırı silebilirsin.' }),
      dl('dlProds', [...pmap.keys(), ...smap.keys()]),
      el('div', { class: 'two' }, F2('Alım tarihi', date), F2('Fatura no', invoiceNo)),
      el('h3', { text: 'Ürünler', style: 'margin-top:10px' }),
      itemsHeaderRow(),
      host,
      el('button', { class: 'btn sm', text: '+ Ürün satırı ekle', onclick: () => addLine() }),
      el('div', { class: 'two' }, F2('Kargo ücreti (₺)', ship), F2('Not', note)),
      total, err,
      el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Vazgeç', onclick: closeModal }), el('button', { class: 'btn primary', text: 'Kaydet', onclick: save }))));
    modal.classList.remove('hide');
  }

  // ---------- gider ekle / düzenle ----------
  function openExpenseModal(existing) {
    const modal = $('#modal');
    const cats = uniq(['Pazarlama', 'Şirket Kuruluşu', 'Ofis', 'Yazılım / Abonelik', 'Kargo', 'Vergi', 'Diğer', ...expenses.map((e) => e.category).filter(Boolean)]);
    const methods = uniq(['Kredi Kartı', 'Banka Havalesi', 'Nakit', ...expenses.map((e) => e.payment_method).filter(Boolean)]);
    const vendors = uniq(expenses.map((e) => e.vendor).filter(Boolean));
    const payers = uniq([...CFG_PAYERS, ...expenses.map((e) => e.paid_by).filter(Boolean)]);
    const dl = (id, arr) => el('datalist', { id }, arr.map((v) => el('option', { value: v })));
    const F2 = (label, node) => el('div', { class: 'row' }, el('label', { text: label }), node);

    const title = el('input', { type: 'text', placeholder: 'Örn. Ofis kirası, Domain yenileme…' }); title.value = existing ? existing.title || '' : '';
    const amount = el('input', { type: 'number', step: '0.01', min: '0' }); amount.value = existing ? existing.amount ?? '' : '';
    const currency = el('select', {}, ['TRY', 'USD', 'EUR'].map((c) => el('option', { value: c, text: c }))); currency.value = (existing && existing.currency) || 'TRY';
    const category = el('input', { type: 'text', list: 'dlCats' }); category.value = existing ? existing.category || '' : '';
    const method = el('input', { type: 'text', list: 'dlMethods' }); method.value = existing ? existing.payment_method || '' : '';
    const vendor = el('input', { type: 'text', list: 'dlVendors' }); vendor.value = existing ? existing.vendor || '' : '';
    const paidBy = el('input', { type: 'text', list: 'dlPayers' }); paidBy.value = existing ? existing.paid_by || '' : '';
    const date = el('input', { type: 'date' }); date.value = existing && existing.expense_date ? existing.expense_date : iso(new Date());
    const receipt = el('input', { type: 'text', placeholder: 'https://… (fiş/fatura linki, isteğe bağlı)' }); receipt.value = existing ? existing.receipt_url || '' : '';
    const notes = el('input', { type: 'text', placeholder: 'Not (isteğe bağlı)' }); notes.value = existing ? existing.notes || '' : '';
    const err = el('div', { class: 'err' });

    const save = async () => {
      err.textContent = '';
      const amt = amount.value === '' ? null : Number(amount.value);
      if (!title.value.trim()) { err.textContent = 'Başlık gir.'; return; }
      if (amt == null || amt < 0) { err.textContent = 'Geçerli bir tutar gir.'; return; }
      if (receipt.value && !/^https:\/\//.test(receipt.value.trim())) { err.textContent = 'Fiş linki https:// ile başlamalı.'; return; }
      const body = {
        title: title.value.trim(), amount: amt, currency: currency.value,
        category: category.value.trim() || null, payment_method: method.value.trim() || null,
        vendor: vendor.value.trim() || null, paid_by: paidBy.value.trim() || null,
        expense_date: date.value || null, receipt_url: receipt.value.trim() || null, notes: notes.value.trim() || null,
      };
      try {
        if (existing) {
          await call({ type: 'API', method: 'PATCH', path: `/rest/v1/expenses?id=eq.${encodeURIComponent(existing.id)}`, body, prefer: 'return=minimal' });
        } else {
          if (!me) me = await call({ type: 'WHOAMI' });
          body.user_id = me.id; body.created_by = me.id;
          await call({ type: 'API', method: 'POST', path: '/rest/v1/expenses', body, prefer: 'return=minimal' });
        }
        closeModal(); toast(existing ? 'Gider güncellendi ✓' : 'Gider eklendi ✓'); await load();
      } catch (e) { err.textContent = 'Kaydedilemedi: ' + e.message; }
    };

    modal.replaceChildren(el('div', { class: 'mbox wide' },
      el('h2', { text: existing ? 'Gideri düzenle' : 'Gider Ekle' }),
      dl('dlCats', cats), dl('dlMethods', methods), dl('dlVendors', vendors), dl('dlPayers', payers),
      el('div', { class: 'two' }, F2('Başlık', title), F2('Tarih', date)),
      el('div', { class: 'two' }, F2('Tutar', amount), F2('Para birimi', currency)),
      el('div', { class: 'two' }, F2('Kategori', category), F2('Ödeme Yöntemi', method)),
      el('div', { class: 'two' }, F2('Ödenen Kurum', vendor), F2('Ödeyen', paidBy)),
      F2('Fiş / fatura linki', receipt), F2('Not', notes), err,
      el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Vazgeç', onclick: closeModal }), el('button', { class: 'btn primary', text: 'Kaydet', onclick: save }))));
    modal.classList.remove('hide');
  }

  // ---------- gider kartları / grafikleri ----------
  function renderExpenseCards(es) {
    const total = sumBy(es, (e) => e.amount);
    const now = new Date(); const ym = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const thisMonth = sumBy(expenses.filter((e) => (e.expense_date || '').slice(0, 7) === ym), (e) => e.amount);
    const byVendor = [...groupBy(es, (e) => e.vendor || 'Belirtilmemiş').entries()].map(([k, v]) => [k, sumBy(v, (e) => e.amount)]).sort((a, b) => b[1] - a[1]);
    const byCat = [...groupBy(es, (e) => e.category || 'Kategorisiz').entries()].map(([k, v]) => [k, sumBy(v, (e) => e.amount)]).sort((a, b) => b[1] - a[1]);
    const card = (lbl, big, sub) => el('div', { class: 'card' }, el('div', { class: 'lbl', text: lbl }), el('div', { class: 'big', text: big }), el('div', { class: 'sub', text: sub || '' }));
    $('#expCards').replaceChildren(
      card('Toplam Gider (filtreli)', money(total), `${int(es.length)} kayıt`),
      card('Bu Ay Harcanan', money(thisMonth), 'tarih filtresinden bağımsız'),
      card('En Çok Ödeme Yapılan Kurum', byVendor[0] ? byVendor[0][0] : '—', byVendor[0] ? money(byVendor[0][1]) : ''),
      card('En Yüksek Kategori', byCat[0] ? byCat[0][0] : '—', byCat[0] ? money(byCat[0][1]) : ''));
  }

  function renderExpenseCharts(es) {
    if (typeof Chart === 'undefined') return;
    const base = { responsive: true, maintainAspectRatio: false };
    const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
    const mm = groupBy(es, (e) => (e.expense_date || '').slice(0, 7) || 'Tarihsiz');
    const months = [...mm.keys()].filter((k) => k !== 'Tarihsiz').sort();
    drawChart('cExpMonthly', { type: 'bar',
      data: { labels: months.map((k) => k.slice(5) + '.' + k.slice(0, 4)), datasets: [{ data: months.map((k) => sumBy(mm.get(k), (e) => e.amount)), backgroundColor: '#dc2626', borderRadius: 6 }] },
      options: { ...base, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + money(c.parsed.y) } } } } });

    const cm = [...groupBy(es, (e) => e.category || 'Kategorisiz').entries()].map(([k, v]) => [k, sumBy(v, (e) => e.amount)]).sort((a, b) => b[1] - a[1]).slice(0, 8);
    drawChart('cExpCategory', { type: 'doughnut',
      data: { labels: cm.map((x) => x[0]), datasets: [{ data: cm.map((x) => x[1]), backgroundColor: ['#dc2626', '#f27a1a', '#d97706', '#16a34a', '#2563eb', '#7c3aed', '#db2777', '#6b7280'] }] },
      options: { ...base, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${money(c.parsed)}` } } } } });

    const vm2 = [...groupBy(es, (e) => e.vendor || 'Belirtilmemiş').entries()].map(([k, v]) => [k, sumBy(v, (e) => e.amount)]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    drawChart('cExpVendor', { type: 'bar',
      data: { labels: vm2.map((x) => trunc(x[0], 26)), datasets: [{ data: vm2.map((x) => x[1]), backgroundColor: '#7c3aed', borderRadius: 6 }] },
      options: { ...base, indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + money(c.parsed.x) } } } } });
  }

  // ---------- Excel ----------
  function sheet(headers, data, types) {
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    if (ws['!ref']) {
      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let R = 1; R <= range.e.r; R++) {
        types.forEach((t, C) => {
          const c = ws[XLSX.utils.encode_cell({ r: R, c: C })];
          if (!c) return;
          if (t === 'm') c.z = '#,##0.00'; else if (t === 'd') c.z = 'dd.mm.yyyy'; else if (t === 'n') c.z = '#,##0';
        });
      }
    }
    ws['!cols'] = headers.map((h, C) => ({ wch: Math.min(50, Math.max(9, String(h).length + 2, ...data.map((r) => (types[C] === 'd' || types[C] === 'm' || types[C] === 'n' ? 12 : String(r[C] == null ? '' : r[C]).length + 2)))) }));
    return ws;
  }

  function exportExcel() {
    if (typeof XLSX === 'undefined') return banner('Excel bileşeni yüklenemedi.');
    const rs = filteredRows();
    const wb = XLSX.utils.book_new();
    const add = (name, h, d, t) => XLSX.utils.book_append_sheet(wb, sheet(h, d, t), name);

    add('Kalemler',
      ['Sipariş Tarihi', 'Sipariş No', 'Hesap', 'Kaynak', 'Satıcı', 'Marka', 'Ürün', 'Varyant', 'Adet', 'Birim Fiyat', 'Toplam', 'Durum', 'Takip No', 'Teslimat No', 'Kargo Firması', 'Teslim Tarihi', 'Tahmini Teslim', 'Sipariş Linki', 'Ürün Linki'],
      rs.map((r) => [serial(r.order_date), r.order_no, r.buyer_account || '', r.order_source === 'manual' ? 'Manuel' : 'Trendyol', r.seller_name || '', r.brand || '', r.product_name, r.variant || '', num(r.quantity), num(r.unit_price), num(r.line_total),
        STATUS_TR[r.item_status] || '', r.tracking_no || '', r.shipment_no || '', r.carrier || '', serial(r.delivered_at), serial(r.est_delivery_date), r.order_url || '', r.product_url || '']),
      ['d', 's', 's', 's', 's', 's', 's', 's', 'n', 'm', 'm', 's', 's', 's', 's', 'd', 'd', 's', 's']);

    add('Siparişler',
      ['Tarih', 'Sipariş No', 'Hesap', 'Kaynak', 'Fatura No', 'Teslimat No', 'Satıcılar', 'Adet', 'Kalem Tutarı', 'Ödenen Toplam', 'Teslim Edilen Adet', 'Yolda Adet', 'Hazırlanıyor Adet', 'İptal/İade Adet', 'Sipariş Linki'],
      orderRows(rs).map((o) => [serial(o.order_date), o.order_no, o.account || '', o.source === 'manual' ? 'Manuel' : 'Trendyol', o.invoiceNo || '', o.shipmentNos || '', o.sellers, o.qty, o.itemsTotal, o.paid == null ? null : num(o.paid), o.g.delivered.q, o.g.onway.q, o.g.preparing.q, o.g.closed.q, o.order_url || '']),
      ['d', 's', 's', 's', 's', 's', 's', 'n', 'm', 'm', 'n', 'n', 'n', 'n', 's']);

    add('Stok',
      ['Marka', 'Ürün', 'Mevcut Stok', 'Yolda', 'Hazırlanıyor', 'Teslim Alınan', 'Manuel Hareket', 'Mağaza Satışı', 'Min. Stok', 'Toplam Harcama', 'Ort. Birim Fiyat', 'Son Birim Fiyat', 'Sipariş Sayısı', 'İlk Sipariş', 'Son Sipariş', 'Not'],
      filteredStock().map((p) => [p.brand || '', p.product_name, num(p.current_stock), num(p.on_the_way_qty), num(p.pending_qty), num(p.delivered_qty), num(p.manual_qty), num(p.seller_sold_qty), num(p.min_stock), num(p.total_spent),
        p.avg_unit_price == null ? null : num(p.avg_unit_price), p.last_unit_price == null ? null : num(p.last_unit_price), num(p.order_count), serial(p.first_order_date), serial(p.last_order_date), p.notes || '']),
      ['s', 's', 'n', 'n', 'n', 'n', 'n', 'n', 'n', 'm', 'm', 'm', 'n', 'd', 'd', 's']);

    const act = rs.filter((r) => grp(r.item_status) !== 'closed');
    const mm = groupBy(act, (r) => r.order_month || 'Tarihsiz');
    add('Aylık Özet', ['Ay', 'Sipariş Sayısı', 'Ürün Adedi', 'Harcama'],
      [...mm.keys()].sort().map((k) => [k, new Set(mm.get(k).map((r) => r.order_no)).size, sumBy(mm.get(k), (r) => r.quantity), sumBy(mm.get(k), (r) => r.line_total)]), ['s', 'n', 'n', 'm']);
    add('Marka Özeti', ['Marka', 'Farklı Ürün', 'Adet', 'Harcama', 'Ort. Birim Fiyat'],
      [...groupBy(act, (r) => r.brand || 'Markasız').entries()].map(([k, v]) => { const q = sumBy(v, (r) => r.quantity), t = sumBy(v, (r) => r.line_total); return [k, new Set(v.map((r) => r.product_id)).size, q, t, q ? t / q : 0]; })
        .sort((a, b) => b[3] - a[3]), ['s', 'n', 'n', 'm', 'm']);
    const s = summarize(rs);
    add('Durum Özeti', ['Durum', 'Adet', 'Tutar'], Object.keys(GROUPS).map((k) => [GROUPS[k].label, s.g[k].q, s.g[k].t]), ['s', 'n', 'm']);

    const es = filteredExpenses();
    add('Giderler', ['Tarih', 'Başlık', 'Kategori', 'Ödenen Kurum', 'Ödeme Yöntemi', 'Ödeyen', 'Tutar', 'Para Birimi', 'Not', 'Fiş Linki'],
      es.map((e) => [serial(e.expense_date), e.title, e.category || '', e.vendor || '', e.payment_method || '', e.paid_by || '', num(e.amount), e.currency || 'TRY', e.notes || '', e.receipt_url || '']),
      ['d', 's', 's', 's', 's', 's', 'm', 's', 's', 's']);

    XLSX.writeFile(wb, `siparis-takip-${iso(new Date())}.xlsx`);
  }

  // ---------- çizim akışı ----------
  function syncStatusText() {
    return sellerLastSync
      ? `Son senkron: ${new Date(sellerLastSync.ran_at).toLocaleString('tr-TR')} · ${sellerLastSync.ok ? 'başarılı' : 'HATA: ' + (sellerLastSync.error || '')} (${int(sellerLastSync.products_synced)} ürün, ${int(sellerLastSync.orders_synced)} sipariş, ${int(sellerLastSync.settlements_synced)} hakediş kaydı)`
      : 'Henüz hiç senkron çalışmamış.';
  }
  // Trendyol, komisyon/kargo/ceza kesintilerini "hakediş" (settlement) kaydıyla, siparişten
  // GÜNLER SONRA yayınlıyor. Hiç hakediş kaydı gelmediyse kâr/net tutar rakamları komisyon
  // düşülmeden gösteriliyor demektir — bu yüzden GERÇEK kârdan yüksek çıkabilir. Bunu gizlemek
  // yerine açıkça uyaralım.
  function settlementsMissing() {
    return !!(sellerLastSync && !sellerLastSync.settlements_synced && (sellerOrders.length || sumBy(sellerProfit, (r) => r.qty_sold)));
  }
  const SETTLE_WARN_TEXT = '⚠️ Henüz hiç hakediş (settlement) kaydı gelmedi — bu yüzden komisyon/kargo/ceza kesintileri rakamlara henüz yansımamış olabilir. Aşağıdaki kâr/net tutar, olması gerekenden YÜKSEK görünüyor olabilir; hakediş verisi Trendyol\'dan geldikçe otomatik güncellenecek.';
  let syncing = false;
  async function triggerSellerSync(btn) {
    if (syncing) return;
    syncing = true;
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Senkronize ediliyor…';
    try {
      await call({ type: 'API', method: 'POST', path: '/rest/v1/rpc/ty_trigger_seller_sync', body: {} });
      // Edge Function arka planda birkaç saniye içinde çalışıp bitiriyor; biraz bekleyip verileri tazeleyelim.
      await new Promise((r) => setTimeout(r, 6000));
      await load();
      btn.textContent = 'Tetiklendi ✓';
    } catch (e) {
      btn.textContent = 'Hata: ' + e.message;
    } finally {
      syncing = false;
      setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 3000);
    }
  }
  function renderActive(rs) {
    ['overview', 'items', 'orders', 'storeOrders', 'stock', 'expenses', 'invoices', 'seller'].forEach((t) => { const s = $('#tab-' + t); if (s) s.classList.toggle('hide', t !== activeTab); });
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === activeTab));
    if (activeTab === 'overview') renderCharts(rs);
    else if (activeTab === 'expenses') { const es = filteredExpenses(); renderExpenseCards(es); renderExpenseCharts(es); tables.expenses.render(); }
    else if (activeTab === 'storeOrders') {
      if ($('#storeOrdersSub')) $('#storeOrdersSub').textContent = syncStatusText();
      if ($('#storeOrdersSettleWarn')) {
        $('#storeOrdersSettleWarn').textContent = SETTLE_WARN_TEXT;
        $('#storeOrdersSettleWarn').classList.toggle('hide', !settlementsMissing());
      }
      const sor = filteredSellerOrders();
      renderStoreOrdersCards(sor);
      renderStoreOrdersStats(sor);
      if (tables.sellerOrders) tables.sellerOrders.render();
    }
    else if (activeTab === 'seller') {
      if ($('#sellerSub')) $('#sellerSub').textContent = syncStatusText();
      if ($('#sellerSettleWarn')) {
        $('#sellerSettleWarn').textContent = SETTLE_WARN_TEXT;
        $('#sellerSettleWarn').classList.toggle('hide', !settlementsMissing());
      }
      if (sellerSubtab === 'settlement') {
        renderSettlementReport();
      } else {
        const sr = filteredSeller();
        renderSellerCards(sr);
        renderSellerCharts(sr);
        tables.seller.render();
      }
    }
    else tables[activeTab].render();
  }
  function renderAll() {
    const rs = filteredRows();
    renderCards(rs);
    if ($('#cards')) $('#cards').classList.toggle('hide', !['overview', 'orders'].includes(activeTab));
    if ($('#quickChips')) $('#quickChips').classList.toggle('hide', !['overview', 'orders', 'storeOrders', 'seller'].includes(activeTab));
    renderActive(rs);
    updateFiltersBadge();
  }

  function updateFiltersBadge() {
    const badge = $('#filtersActiveCount');
    if (!badge) return;
    let n = 0;
    if (F.from) n++;
    if (F.to) n++;
    n += F.brands.size + F.sellers.size + F.groups.size + F.accounts.size + F.sources.size;
    if (F.q && F.q.trim()) n++;
    if (F.services) n++;
    // v12: bu panele taşınan sekmeye-özel filtreler de sayıma dahil.
    if (OF.status) n++;
    if (OF.hideCancelled) n++;
    if (SF.onlyMissing) n++;
    if (n > 0) { badge.textContent = String(n); badge.classList.remove('hide'); }
    else { badge.classList.add('hide'); }
  }

  // ---------- başlangıç ----------
  function init() {
    multis.brand = multi($('#fBrand'), 'Marka', () => uniq([...rows.map((r) => r.brand || 'Markasız'), ...sellerProfit.map((r) => r.brand || 'Markasız'), ...F.brands]).map((v) => ({ value: v, label: v })), F.brands);
    multis.seller = multi($('#fSeller'), 'Satıcı', () => uniq([...rows.map((r) => r.seller_name || 'Bilinmiyor'), ...F.sellers]).map((v) => ({ value: v, label: v })), F.sellers);
    multis.account = multi($('#fAccount'), 'Hesap', () => uniq([...rows.map((r) => r.buyer_account || DEF_ACCT), ...F.accounts]).map((v) => ({ value: v, label: v })), F.accounts);
    multis.source = multi($('#fSource'), 'Kaynak', () => [{ value: 'trendyol', label: 'Trendyol' }, { value: 'manual', label: 'Manuel' }], F.sources);
    multis.group = multi($('#fGroup'), 'Durum', () => Object.keys(GROUPS).map((k) => ({ value: k, label: GROUPS[k].label })), F.groups);
    multis.expCategory = multi($('#fExpCategory'), 'Kategori', () => uniq(expenses.map((e) => e.category || 'Kategorisiz')).map((v) => ({ value: v, label: v })), EF.categories);
    multis.expMethod = multi($('#fExpMethod'), 'Ödeme Yöntemi', () => uniq(expenses.map((e) => e.payment_method || 'Belirtilmemiş')).map((v) => ({ value: v, label: v })), EF.methods);
    multis.expVendor = multi($('#fExpVendor'), 'Ödenen Kurum', () => uniq(expenses.map((e) => e.vendor || 'Belirtilmemiş')).map((v) => ({ value: v, label: v })), EF.vendors);
    initTables();

    $('#preset').addEventListener('change', (e) => { setPreset(e.target.value); renderAll(); });
    if ($('#quickChips')) $('#quickChips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; setPreset(b.dataset.preset); renderAll(); });
    $('#from').addEventListener('change', (e) => { F.from = e.target.value; $('#preset').value = 'custom'; document.querySelectorAll('#quickChips button').forEach((b) => b.classList.remove('on')); renderAll(); });
    $('#to').addEventListener('change', (e) => { F.to = e.target.value; $('#preset').value = 'custom'; document.querySelectorAll('#quickChips button').forEach((b) => b.classList.remove('on')); renderAll(); });
    let tm; $('#q').addEventListener('input', (e) => { clearTimeout(tm); tm = setTimeout(() => { F.q = e.target.value; renderAll(); }, 200); });
    $('#svc').addEventListener('change', (e) => { F.services = e.target.checked; renderAll(); });
    $('#clear').addEventListener('click', () => {
      F.brands.clear(); F.sellers.clear(); F.groups.clear(); F.accounts.clear(); F.sources.clear(); F.q = ''; F.services = false;
      $('#q').value = ''; $('#svc').checked = false; $('#preset').value = 'all'; setPreset('all');
      // v12: Siparişler'e özel Durum/İptalleri Gizle ve Mağaza'ya özel Sadece maliyeti eksik
      // olanlar artık bu panelde yaşıyor — hepsi birlikte temizlensin.
      OF.status = ''; OF.hideCancelled = false; SF.onlyMissing = false;
      if ($('#ocStatus')) $('#ocStatus').value = '';
      if ($('#ocHideCancelled')) $('#ocHideCancelled').checked = false;
      if ($('#sellerOnlyMissing')) $('#sellerOnlyMissing').checked = false;
      Object.values(multis).forEach((m) => m.draw());
      renderAll();
    });
    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      activeTab = b.dataset.tab; renderAll();
      $('#tabs').classList.remove('open');
      if ($('#tabsToggle')) $('#tabsToggle').setAttribute('aria-expanded', 'false');
    });
    { const tt = $('#tabsToggle'), tn = $('#tabs');
      if (tt && tn) {
        tt.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = tn.classList.toggle('open');
          tt.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        document.addEventListener('click', (e) => {
          if (tn.classList.contains('open') && !tn.contains(e.target) && e.target !== tt && !tt.contains(e.target)) {
            tn.classList.remove('open');
            tt.setAttribute('aria-expanded', 'false');
          }
        });
      }
    }
    { const ft = $('#filtersToggle'), fb = $('#filtersBody');
      if (ft && fb) {
        // Umit'in isteğiyle: telefon genişliğinde (≤700px) filtreler paneli varsayılan KAPALI
        // açılsın — masaüstünde eskisi gibi açık kalıyor, sadece dar ekranda kapalı başlıyor.
        if (window.innerWidth <= 700) {
          ft.setAttribute('aria-expanded', 'false');
          fb.classList.add('hide');
        }
        ft.addEventListener('click', () => {
          const open = ft.getAttribute('aria-expanded') !== 'false';
          ft.setAttribute('aria-expanded', open ? 'false' : 'true');
          fb.classList.toggle('hide', open);
        });
      }
    }
    updateFiltersBadge();
    // on(): eski (önbelleğe alınmış) bir HTML sürümünde bu eleman yoksa sessizce atlar —
    // tek bir eksik eleman yüzünden init() tamamen çökmesin ve tüm site "boş" görünmesin diye.
    const on = (sel, ev, fn) => { const e = $(sel); if (e) e.addEventListener(ev, fn); };
    on('#ovSubtabs', 'click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      ovTab = b.dataset.ov;
      document.querySelectorAll('#ovSubtabs button').forEach((x) => x.classList.toggle('on', x === b));
      const buyPane = $('#ov-buy'), sellPane = $('#ov-sell');
      if (buyPane) buyPane.classList.toggle('hide', ovTab !== 'buy');
      if (sellPane) sellPane.classList.toggle('hide', ovTab !== 'sell');
      renderAll();
    });
    on('#sellerSubtabs', 'click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      sellerSubtab = b.dataset.st;
      document.querySelectorAll('#sellerSubtabs button').forEach((x) => x.classList.toggle('on', x === b));
      const prodPane = $('#seller-products'), settlePane = $('#seller-settlement');
      if (prodPane) prodPane.classList.toggle('hide', sellerSubtab !== 'products');
      if (settlePane) settlePane.classList.toggle('hide', sellerSubtab !== 'settlement');
      renderAll();
    });
    let sstm; on('#settleOrderSearch', 'input', (e) => { clearTimeout(sstm); const v = e.target.value; sstm = setTimeout(() => { SRF.q = v; SRF.mode = v.trim() ? 'search' : null; renderSettleDetail(); }, 200); });
    on('#openProfitCalc', 'click', () => openProfitCalcModal());
    on('#invOnlyUnchecked', 'change', (e) => { IF.onlyUnchecked = e.target.checked; renderActive(filteredRows()); });
    // v12: Marka/Ara artık üstteki genel filtreden (F.brands/F.q) geliyor — bu sekmeye özel sadece
    // "Sadece maliyeti eksik olanlar" kaldı (bkz. filteredSeller). Temizleme de üstteki tek
    // "Temizle" butonunda (bkz. #clear).
    on('#sellerOnlyMissing', 'change', (e) => { SF.onlyMissing = e.target.checked; renderActive(filteredRows()); updateFiltersBadge(); });
    on('#orderCostsFile', 'change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) handleOrderCostsFile(f); });
    // v11/v12: Tarih ve arama üstteki genel filtreden (F.from/F.to/F.q) geliyor — bu sekmeye özel
    // sadece Durum ve İptalleri Gizle kaldı (bkz. filteredSellerOrders). Temizleme #clear'da.
    on('#ocStatus', 'change', (e) => { OF.status = e.target.value; renderActive(filteredRows()); updateFiltersBadge(); });
    on('#ocHideCancelled', 'change', (e) => { OF.hideCancelled = e.target.checked; renderActive(filteredRows()); updateFiltersBadge(); });
    on('#brandHome', 'click', () => { activeTab = 'overview'; renderAll(); });
    $('#refresh').addEventListener('click', load);
    // v11: tek, sabit (üst çubuktaki) senkron butonu — hangi sekmede olursan ol çalışır.
    on('#sellerSyncNow', 'click', (e) => triggerSellerSync(e.currentTarget));
    $('#export').addEventListener('click', exportExcel);
    $('#addManual').addEventListener('click', openManualModal);
    $('#addExpense').addEventListener('click', () => openExpenseModal(null));
    $('#changePw').addEventListener('click', openPasswordModal);
    let etm; $('#expQ').addEventListener('input', (e) => { clearTimeout(etm); etm = setTimeout(() => { EF.q = e.target.value; renderAll(); }, 200); });
    $('#expClear').addEventListener('click', () => {
      EF.categories.clear(); EF.methods.clear(); EF.vendors.clear(); EF.q = '';
      $('#expQ').value = '';
      ['expCategory', 'expMethod', 'expVendor'].forEach((k) => multis[k] && multis[k].draw());
      renderAll();
    });
    const lo = $('#logout');
    if (lo) { if (WEB) lo.addEventListener('click', () => window.WebApi.logout()); else lo.classList.add('hide'); }
    $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    document.addEventListener('click', (e) => document.querySelectorAll('.ms[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); }));
    (async () => { if (WEB) await window.WebApi.ready(); load(); })();
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { init };
  else init();
})();
