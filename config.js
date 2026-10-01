/* config.js — BU KURULUMA ÖZEL AYARLAR (arkadaşın mağazası).
   Bu dosya güncellemelerde DEĞİŞTİRİLMEZ, üzerine yazılmaz. Ortak dosyalar (dashboard.js,
   index.html, webapi.js, dashboard.css) her kurulumda aynıdır; farklar sadece burada. */
window.TY_CONFIG = {
  // Supabase bağlantısı
  url: 'https://zlumvdwqpjisyunqrwah.supabase.co',
  anonKey: 'sb_publishable_tDcT8vjeN_tFGoz0rKL-FA_YkwBjKw0',

  // Görünen ad (sol üst başlık + tarayıcı sekmesi) — istersen mağaza adını yaz
  appName: 'Sipariş ve Ürün Takip',
  brand: '',

  // Alış hesapları: ilk sıradaki varsayılan hesap
  defaultAccount: 'Ana Hesap',
  accounts: ['Ana Hesap'],

  // Giderlerde "Ödeyen" önerileri
  payers: ['Ana Hesap', 'Şirket'],
};
