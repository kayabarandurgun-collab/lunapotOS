import {offerTotals} from '../public/offer-math.js';
import {isApprovedLogoVariant} from '../public/brand-logo-variants.js';

// BELGE ATÖLYESİ'NİN DOKUZ KURUMSAL EVRAK TÜRÜ.
//
// Teklif ve proforma BU DOSYADA DEĞİL: onlar mevcut ec_offers/lp_offers kaydında
// kalır (src/offers-api.js). Burada ikinci bir teklif havuzu yoktur.
//
// BU BELGELER MUHASEBE KAYDI DEĞİLDİR. Hiçbiri gerçek sipariş, fatura, irsaliye,
// tahsilat ya da stok hareketi yaratmaz. Bu dosyada stok, defter, kasa ya da fatura
// tablolarına yazan TEK BİR sorgu yoktur. Dışarıya e-posta veya mesaj gönderilmez.
// source_kind/source_id yalnız bilgi amaçlı atıftır; finansal etkisi yoktur.

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const newId = () => crypto.randomUUID();
const today = () => new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});

export const BRAND_DOCUMENT_TYPES = {
  'siparis-onayi': {name: 'Sipariş onayı', code: 'SIP', money: true, table: true, party: 'Müşteri'},
  'satinalma-siparisi': {name: 'Satın alma siparişi', code: 'SAT', money: true, table: true, party: 'Tedarikçi'},
  'paket-listesi': {name: 'Paket listesi', code: 'PKT', money: false, table: true, party: 'Alıcı'},
  'teslim-tutanagi': {name: 'Teslim tutanağı', code: 'TES', money: false, table: true, party: 'Teslim alan'},
  'iade-formu': {name: 'İade talep formu', code: 'IAD', money: false, table: true, party: 'Talep sahibi'},
  'teknik-bilgi': {name: 'Ürün bilgi formu', code: 'URN', money: false, table: false, party: 'Hazırlayan / ilgili'},
  'antet': {name: 'Antetli yazı', code: 'YAZ', money: false, table: false, party: 'Muhatap'},
  'toplanti-notu': {name: 'Toplantı notu', code: 'TOP', money: false, table: false, party: 'Katılımcılar'},
  'dosya-kapagi': {name: 'Dosya kapağı', code: 'DOS', money: false, table: false, party: 'Hazırlanan kişi / kurum'}
};

// Bu türlerin hiçbiri gerçek bir muhasebe hareketi yaratmaz; ekranda da böyle yazar.
const NOTICE = 'Bu belge kurumsal bir evraktır; resmî fatura, irsaliye ya da stok hareketi değildir.';

const day = (value, label = 'Tarih') => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value) fail(label + ' geçersiz.');
  return value;
};
const text = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(label + ' alanını kontrol edin.');
  return value.trim();
};
const optional = (value, label, max = 4000) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) fail(label + ' alanını kontrol edin.');
  return value.trim();
};
const key = value => { if (!/^[\w-]{1,100}$/.test(value || '')) fail('Kayıt seçimi geçersiz.'); return value; };

// ---- Antet profilleri ----
//
// Kullanıcının birden çok tüzel kişiliği var ve ikisi de aynı çalışma alanından
// belge kesiyor. Bu yüzden antet kimliği çalışma alanına değil BELGEYE bağlanır:
// profil burada tutulur, belgeye basılan hâli presentation.company_snapshot
// içinde DONAR. Belgeye profil kimliği YAZILMAZ — sonradan profil değişse bile
// basılmış belge neyi gösterdiyse onu göstermeye devam etsin.
const PROFILE_FIELDS = {label: 80, legal_name: 200, tax_id: 20, tax_office: 120, address: 400,
  phone: 60, email: 160, website: 160, bank_name: 120, bank_iban: 40, signature_title: 120};
const PROFILE_SELECT = 'SELECT id,label,legal_name,tax_id,tax_office,address,phone,email,website,' +
  'bank_name,bank_iban,signature_title,is_default FROM brand_profiles WHERE archived_at IS NULL ' +
  'ORDER BY is_default DESC,sort_order,label';

function readProfileInput(input) {
  for (const field of Object.keys(input))
    if (!Object.hasOwn(PROFILE_FIELDS, field) && field !== 'id' && field !== 'is_default')
      fail('Antet profilinde tanınmayan alan var.');
  const values = {};
  for (const [field, max] of Object.entries(PROFILE_FIELDS)) values[field] = optional(input[field], 'Antet bilgisi', max);
  if (!values.label) fail('Profile kısa bir ad ver; belgede bu adla seçeceksin.');
  // Vergi numarası BURADA serbest değildir ama alış faturası eşleştirmesini de
  // etkilemez: o /settings'teki numara üzerinden yürür, buraya yazılan yalnız kâğıda basılır.
  if (values.tax_id && !/^\d{10,11}$/.test(values.tax_id)) fail('Vergi numarası 10 veya 11 rakam olmalı.');
  if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) fail('E-posta adresini kontrol edin.');
  if (values.bank_iban) {
    const iban = values.bank_iban.replace(/\s/g, '').toUpperCase();
    if (!/^TR\d{24}$/.test(iban)) fail('IBAN TR ile başlayan 26 karakter olmalı. Emin değilsen boş bırak.');
    values.bank_iban = iban;
  }
  return values;
}

const PARTY_FIELDS = {name: 200, address: 400, contact: 200, tax: 200, bank: 200};
function partySnapshot(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail(label + ' bilgisini kontrol edin.');
  for (const field of Object.keys(value))
    if (!Object.hasOwn(PARTY_FIELDS, field)) fail(label + ' içinde tanınmayan alan var.');
  const out = {};
  for (const [field, max] of Object.entries(PARTY_FIELDS)) out[field] = optional(value[field], label, max);
  return out;
}

const PRESENTATION_KEYS = ['schema_version', 'template_id', 'template_version', 'logo_variant_id',
  'company_snapshot', 'brand_version'];
const PRESENTATION_MAX = 3000;
function readPresentation(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('Belge sunumu geçersiz.');
  for (const field of Object.keys(value))
    if (!PRESENTATION_KEYS.includes(field)) fail('Belge sunumunda tanınmayan alan var.');
  if (value.schema_version !== 1) fail('Belge sunum sürümü desteklenmiyor.');
  if (value.template_id !== 'lunapot-business-v2') fail('Belge şablonu tanınmıyor.');
  if (!Number.isSafeInteger(value.template_version) || value.template_version < 1 || value.template_version > 99)
    fail('Belge şablon sürümü geçersiz.');
  if (!isApprovedLogoVariant(value.logo_variant_id)) fail('Logo seçimi onaylı listede bulunamadı.');
  if (value.brand_version !== 'v8') fail('Marka sürümü geçersiz.');
  const presentation = {
    schema_version: 1, template_id: value.template_id, template_version: value.template_version,
    logo_variant_id: value.logo_variant_id,
    company_snapshot: partySnapshot(value.company_snapshot, 'Firma bilgisi'),
    brand_version: 'v8'
  };
  if (JSON.stringify(presentation).length > PRESENTATION_MAX) fail('Belge sunumu çok büyük.');
  return presentation;
}

const CONTENT_KEYS = ['title', 'issue_date', 'valid_until', 'reference', 'recipient_snapshot', 'notes',
  'prepared', 'approved', 'example', 'lines', 'line_notes', 'currency'];

// Parasız tablolu türlerde satır YALNIZ miktar ve açıklama taşır: para alanı yoktur,
// böylece "fiyatsız evrak" sessizce tutar taşımaz.
function readLines(input, type) {
  const spec = BRAND_DOCUMENT_TYPES[type];
  const raw = input.lines;
  if (!spec.table) {
    if (raw !== undefined && raw !== null && (!Array.isArray(raw) || raw.length))
      fail('Bu belge türünde satır tablosu bulunmaz.');
    return {lines: [], totals: null};
  }
  if (!Array.isArray(raw)) fail('Belge satırlarını gönderin.');
  if (raw.length > 200) fail('Bir belgede en çok 200 satır bulunur.');
  if (spec.money) {
    if (!raw.length) fail('Belge satırlarını gönderin.');
    // Tutarlı türlerde kanonik hesap AYNI motordan geçer: ikinci bir matematik yok.
    const totals = (() => { try { return offerTotals(raw); } catch (error) { return fail(error.message); } })();
    return {lines: totals.rows, totals};
  }
  const lines = raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Satır ' + (index + 1) + ' geçersiz.');
    for (const field of Object.keys(item))
      if (!['description', 'unit', 'product_id', 'quantity_milli', 'note'].includes(field))
        fail('Satır ' + (index + 1) + ' içinde tanınmayan alan var.');
    const quantity = item.quantity_milli;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000000000)
      fail('Satır ' + (index + 1) + ' miktarını kontrol edin.');
    return {
      description: text(item.description, 'Satır ' + (index + 1) + ' açıklaması', 300),
      unit: optional(item.unit, 'Birim', 40),
      product_id: item.product_id === undefined || item.product_id === null ? null : key(item.product_id),
      quantity_milli: quantity,
      note: optional(item.note, 'Kontrol / açıklama', 300)
    };
  });
  return {lines, totals: null};
}

function readContent(input, type) {
  if (!input || typeof input !== 'object') fail('Belge içeriğini gönderin.');
  for (const field of Object.keys(input))
    if (!CONTENT_KEYS.includes(field)) fail('Belge içeriğinde tanınmayan alan var.');
  if (input.currency !== undefined && input.currency !== 'TRY')
    fail('Bu belge yalnız TRY ile hazırlanır. Farklı para birimi desteklenmiyor.');
  const issue = day(input.issue_date, 'Belge tarihi');
  let validUntil = null;
  if (input.valid_until !== undefined && input.valid_until !== null && input.valid_until !== '') {
    validUntil = day(input.valid_until, 'Geçerlilik tarihi');
    if (validUntil < issue) fail('Geçerlilik tarihi belge tarihinden önce olamaz.');
  }
  const {lines, totals} = readLines(input, type);
  const notes = [];
  if (input.line_notes !== undefined && input.line_notes !== null) {
    if (!Array.isArray(input.line_notes) || input.line_notes.length > lines.length)
      fail('Satır açıklaması belge satırlarıyla uyuşmuyor.');
    for (const item of input.line_notes) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Satır açıklaması geçersiz.');
      for (const field of Object.keys(item))
        if (!['index', 'note'].includes(field)) fail('Satır açıklamasında tanınmayan alan var.');
      if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= lines.length)
        fail('Satır açıklaması belge satırlarıyla uyuşmuyor.');
      notes.push({index: item.index, note: optional(item.note, 'Kontrol / açıklama', 300)});
    }
  }
  return {
    title: text(input.title, 'Belge başlığı', 200),
    issue_date: issue,
    valid_until: validUntil,
    currency: 'TRY',
    reference: optional(input.reference, 'Referans', 200),
    recipient_snapshot: partySnapshot(input.recipient_snapshot, 'Muhatap bilgisi'),
    notes: optional(input.notes, 'Notlar', 8000),
    prepared: optional(input.prepared, 'Hazırlayan', 120),
    approved: optional(input.approved, 'Onaylayan', 120),
    example: input.example === true,
    lines, line_notes: notes, totals, notice: NOTICE
  };
}

// Numara sunucuda üretilir: istemcinin yerel sayacı ESAS ALINMAZ.
async function nextDocumentNo(db, type, year) {
  const prefix = BRAND_DOCUMENT_TYPES[type].code + '-' + year + '-';
  const last = await db.prepare(
    'SELECT document_no FROM brand_documents WHERE type=? AND document_no LIKE ? ORDER BY document_no DESC LIMIT 1'
  ).bind(type, prefix + '%').first();
  const previous = last ? Number(last.document_no.slice(-4)) : 0;
  if (!Number.isSafeInteger(previous) || previous >= 9999) fail('Bu yıl için belge numarası tükendi.', 409);
  return prefix + String(previous + 1).padStart(4, '0');
}

const COLUMNS = 'id,type,document_no,revision,supersedes,party_id,status,source_kind,source_id,' +
  'total_cents,line_count,created_by_name,created_at,updated_at';

const present = row => {
  const {content_json, presentation_json, idempotency_key, created_by, ...rest} = row;
  return {
    ...rest,
    type_name: BRAND_DOCUMENT_TYPES[row.type]?.name || row.type,
    content: JSON.parse(content_json),
    presentation: presentation_json ? JSON.parse(presentation_json) : null
  };
};

async function partyCard(db, party) {
  const card = await db.prepare('SELECT id,name,tax_id,contact,phone,email,address,kind FROM suppliers WHERE id=?')
    .bind(party).first();
  if (!card) fail('Cari bu çalışma alanında bulunamadı.', 404);
  return card;
}

// Göç gelmediyse MODÜL KAPALI sayılır; panelin tamamı 500'e düşmez.
const missingTable = error => /no such table|no such column/i.test(String(error?.message || ''));
const closed = () => ({
  available: false,
  types: BRAND_DOCUMENT_TYPES,
  notice: 'Kurumsal evrak defteri henüz kurulmadı. Veri göçü uygulandığında bu bölüm açılır.'
});

async function insert(db, row) {
  try {
    await db.prepare(
      'INSERT INTO brand_documents(id,type,document_no,revision,supersedes,party_id,status,content_json,' +
      'presentation_json,source_kind,source_id,idempotency_key,total_cents,line_count,created_by,created_by_name) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(row.id, row.type, row.document_no, row.revision, row.supersedes, row.party_id, row.status,
      row.content_json, row.presentation_json, row.source_kind, row.source_id, row.idempotency_key,
      row.total_cents, row.line_count, row.created_by, row.created_by_name).run();
  } catch (error) {
    const message = String(error.message);
    if (/BRAND_DOC_REVISION/.test(message)) fail('Revizyon sırası geçersiz.', 409);
    if (/UNIQUE constraint failed: \w+_brand_documents\.idempotency_key/.test(message))
      fail('Bu belge zaten oluşturulmuş.', 409);
    if (/UNIQUE constraint failed: \w+_brand_documents\.supersedes/.test(message))
      fail('Bu belgenin zaten bir revizyonu var.', 409);
    if (/UNIQUE constraint/.test(message)) fail('Aynı anda başka bir belge oluşturuldu. Tekrar deneyin.', 409);
    throw error;
  }
}

async function loadRow(db, id) {
  const row = await db.prepare('SELECT * FROM brand_documents WHERE id=?').bind(key(id)).first();
  if (!row) fail('Belge bulunamadı.', 404);
  return row;
}

async function readSource(db, input) {
  if (input.source_ref === undefined || input.source_ref === null) return {kind: null, id: null};
  const ref = input.source_ref;
  if (typeof ref !== 'object' || Array.isArray(ref)) fail('Kaynak bağlantısı geçersiz.');
  for (const field of Object.keys(ref))
    if (!['kind', 'id'].includes(field)) fail('Kaynak bağlantısında tanınmayan alan var.');
  if (!['offer', 'order', 'product'].includes(ref.kind)) fail('Kaynak türü geçersiz.');
  const id = key(ref.id);
  // Kaynak BU çalışma alanında mı? İstemcinin verdiği kimlik doğrulanmadan yazılmaz.
  const table = {offer: 'offers', order: 'order_lines', product: 'stock_balances'}[ref.kind];
  if (ref.kind === 'offer') {
    const found = await db.prepare('SELECT id FROM offers WHERE id=?').bind(id).first();
    if (!found) fail('Kaynak belge bu çalışma alanında bulunamadı.', 404);
  }
  return {kind: ref.kind, id, table};
}

export async function brandDocumentsApi(request, env, path, readBody) {
  if (!path.startsWith('/api/brand-documents') && !path.startsWith('/api/brand-profile')) return null;
  if (!['ec', 'lp'].includes(env.WORKSPACE)) fail('Çalışma alanı geçersiz.', 403);
  const db = env.DB, method = request.method, url = new URL(request.url);
  const user = env.USER || {};

  // ---- Antet profili ----
  // Alt yollar BU BLOKTA karşılanır; aşağıdaki `sub` dilimlemesine düşerlerse
  // yol yanlış kesilir ve belge listesi dallarına girerler.
  if (path === '/api/brand-profile' || path.startsWith('/api/brand-profile/')) {
    const root = env.ROOT_DB || env.DB;
    const tail = path.slice('/api/brand-profile'.length);
    // Göç uygulanmadıysa özellik KAPALI görünür; ana defter etkilenmez.
    const profilesOrNull = async () => {
      try { return (await root.prepare(PROFILE_SELECT).all()).results; }
      catch (error) { if (missingTable(error)) return null; throw error; }
    };

    if (tail === '/profiles' && method === 'POST') {
      const input = await readBody(request);
      const values = readProfileInput(input);
      const id = input.id === undefined || input.id === null || input.id === '' ? newId() : key(input.id);
      let rows;
      try {
        const existing = (await root.prepare('SELECT id,is_default FROM brand_profiles WHERE id=?').bind(id).first()) || null;
        if (input.id && !existing) fail('Profil bulunamadı.', 404);
        const count = (await root.prepare('SELECT COUNT(*) AS n FROM brand_profiles WHERE archived_at IS NULL').first())?.n || 0;
        // İlk profil kendiliğinden varsayılan olur, yoksa hiçbir şey önseçili gelmez.
        // Alan GÖNDERİLMEZSE mevcut varsayılanlık korunur: telefonu düzeltmek
        // profili varsayılanlıktan düşürmemeli.
        const wantsDefault = Object.hasOwn(input, 'is_default')
          ? input.is_default === true || input.is_default === 1
          : existing ? !!existing.is_default : count === 0;
        if (wantsDefault) await root.prepare('UPDATE brand_profiles SET is_default=0 WHERE is_default=1 AND id!=?').bind(id).run();
        const bound = [values.label, values.legal_name, values.tax_id, values.tax_office, values.address,
          values.phone, values.email, values.website, values.bank_name, values.bank_iban, values.signature_title];
        if (existing) {
          await root.prepare(
            'UPDATE brand_profiles SET label=?,legal_name=?,tax_id=?,tax_office=?,address=?,phone=?,email=?,' +
            'website=?,bank_name=?,bank_iban=?,signature_title=?,is_default=?,updated_at=CURRENT_TIMESTAMP WHERE id=?'
          ).bind(...bound, wantsDefault ? 1 : 0, id).run();
        } else {
          await root.prepare(
            'INSERT INTO brand_profiles(id,label,legal_name,tax_id,tax_office,address,phone,email,website,' +
            'bank_name,bank_iban,signature_title,is_default,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
          ).bind(id, ...bound, wantsDefault ? 1 : 0, count).run();
        }
        rows = (await root.prepare(PROFILE_SELECT).all()).results;
      } catch (error) {
        if (missingTable(error)) fail('Antet profilleri henüz kurulmadı. Veri göçü uygulanmalı.', 409);
        if (/UNIQUE constraint failed: brand_profiles\.label/i.test(String(error?.message || '')))
          fail('Bu adda bir profil zaten var. Başka bir kısa ad seç.');
        throw error;
      }
      return {profiles: rows, profilesAvailable: true, saved: true, id};
    }

    if (tail === '/profiles/archive' && method === 'POST') {
      const input = await readBody(request);
      const id = key(input.id);
      let rows;
      try {
        const row = await root.prepare('SELECT id,is_default FROM brand_profiles WHERE id=? AND archived_at IS NULL').bind(id).first();
        if (!row) fail('Profil bulunamadı.', 404);
        // Varsayılan kaldırılamaz: açılır kutuda görünmeyen bir kimlik yeni belgeye
        // sessizce basılmasın. Önce başka profil varsayılan yapılır.
        if (row.is_default) fail('Önce başka bir profili varsayılan yap; varsayılan profil kaldırılamaz.', 409);
        await root.prepare("UPDATE brand_profiles SET archived_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
        rows = (await root.prepare(PROFILE_SELECT).all()).results;
      } catch (error) {
        if (missingTable(error)) fail('Antet profilleri henüz kurulmadı. Veri göçü uygulanmalı.', 409);
        throw error;
      }
      // Kaldırılan profil SİLİNMEZ, arşivlenir: eski belgeler hangi kimlikle
      // basıldığını göstermeye devam eder.
      return {profiles: rows, profilesAvailable: true, archived: id};
    }

    if (tail !== '') fail('İstek bulunamadı.', 404);

    if (method === 'GET') {
      // Profiller ayrı bir istek gerektirmesin: ekran tek çağrıyla kurulur.
      const profiles = await profilesOrNull();
      try {
        const row = await root.prepare(
          'SELECT legal_name,tax_id,address,phone,email,website,tax_office,bank_name,bank_iban,signature_title,updated_at ' +
          'FROM workspace_settings WHERE workspace=?'
        ).bind(env.WORKSPACE).first();
        return {workspace: env.WORKSPACE, profile: row || null, available: !!row,
          profiles: profiles || [], profilesAvailable: profiles !== null,
          ...(profiles === null ? {profilesNotice: 'Antet profilleri henüz kurulmadı. Veri göçü uygulandığında açılır.'} : {})};
      } catch (error) {
        if (missingTable(error)) return {workspace: env.WORKSPACE, profile: null, available: false,
          profiles: profiles || [], profilesAvailable: profiles !== null,
          notice: 'Antet alanları henüz kurulmadı. Veri göçü uygulandığında açılır.'};
        throw error;
      }
    }
    if (method === 'POST') {
      const input = await readBody(request);
      const FIELDS = {address: 400, phone: 60, email: 160, website: 160, tax_office: 120,
        bank_name: 120, bank_iban: 40, signature_title: 120};
      for (const field of Object.keys(input))
        if (!Object.hasOwn(FIELDS, field)) fail('Antet bilgisinde tanınmayan alan var.');
      const values = {};
      for (const [field, max] of Object.entries(FIELDS)) values[field] = optional(input[field], 'Antet bilgisi', max);
      if (values.bank_iban && !/^TR\d{24}$/.test(values.bank_iban.replace(/\s/g, '').toUpperCase()))
        fail('IBAN TR ile başlayan 26 karakter olmalı. Emin değilsen boş bırak.');
      if (values.bank_iban) values.bank_iban = values.bank_iban.replace(/\s/g, '').toUpperCase();
      if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) fail('E-posta adresini kontrol edin.');
      try {
        // Yalnız antet alanlarını yazar: mevcut unvan, VKN ve operasyon ayarları SIFIRLANMAZ.
        await root.prepare(
          'UPDATE workspace_settings SET address=?,phone=?,email=?,website=?,tax_office=?,bank_name=?,' +
          'bank_iban=?,signature_title=?,updated_at=CURRENT_TIMESTAMP WHERE workspace=?'
        ).bind(values.address, values.phone, values.email, values.website, values.tax_office,
          values.bank_name, values.bank_iban, values.signature_title, env.WORKSPACE).run();
      } catch (error) {
        if (missingTable(error)) fail('Antet alanları henüz kurulmadı. Veri göçü uygulanmalı.', 409);
        throw error;
      }
      const row = await root.prepare(
        'SELECT legal_name,tax_id,address,phone,email,website,tax_office,bank_name,bank_iban,signature_title,updated_at ' +
        'FROM workspace_settings WHERE workspace=?'
      ).bind(env.WORKSPACE).first();
      return {workspace: env.WORKSPACE, profile: row, available: true, saved: true};
    }
    fail('İstek bulunamadı.', 404);
  }

  const sub = path.slice('/api/brand-documents'.length);

  // ---- Cari ve ürün seçimi ----
  if (sub === '/lookups/parties' && method === 'GET') {
    const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
    // Yasal unvan ve vergi dairesi cari DOSYASINDA durur (0066), suppliers'ta değil.
    // O tablo scoped-db listesinde olmadığı için adı açıkça yazılır; WORKSPACE
    // bu noktada 'ec' ya da 'lp' olarak doğrulanmıştır.
    const temel = 'SELECT s.id,s.name,s.tax_id,s.address,s.contact,s.phone,s.email,s.kind';
    const kosul = " WHERE s.archived_at IS NULL AND (?1='' OR s.name LIKE ?2) ORDER BY s.name LIMIT 50";
    let rows;
    try {
      rows = (await db.prepare(
        temel + ',p.legal_name AS legal_name,p.tax_office AS tax_office FROM suppliers s' +
        ' LEFT JOIN ' + env.WORKSPACE + '_party_profiles p ON p.party_id=s.id' + kosul
      ).bind(query, '%' + query + '%').all()).results;
    } catch (error) {
      // Cari dosyası tablosu yoksa liste yine çalışır; yalnız unvan ve vergi dairesi gelmez.
      if (!missingTable(error)) throw error;
      rows = (await db.prepare(temel + ' FROM suppliers s' + kosul)
        .bind(query, '%' + query + '%').all()).results;
    }
    return {workspace: env.WORKSPACE, parties: rows};
  }
  if (sub === '/lookups/products' && method === 'GET') {
    const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
    try {
      // Yalnız ad, kod ve birim döner. FİYAT DÖNMEZ: ne maliyet ne satış fiyatı
      // belgeye sessizce taşınır; birim fiyatı kullanıcı açıkça yazar.
      // Sütun adı iki şemada da stock_unit'tir ('unit' DİYE BİR SÜTUN YOK).
      // Arşivlenmiş kart yeni belgede seçilemez.
      const rows = (await db.prepare(
        'SELECT id,name,sku,stock_unit FROM products WHERE archived_at IS NULL ' +
        'AND (?1=\'\' OR name LIKE ?2 OR sku LIKE ?2) ORDER BY name LIMIT 50'
      ).bind(query, '%' + query + '%').all()).results;
      return {workspace: env.WORKSPACE, products: rows.map(row =>
        ({id: row.id, name: row.name, sku: row.sku, unit: row.stock_unit}))};
    } catch (error) {
      if (missingTable(error)) return {workspace: env.WORKSPACE, products: [], available: false};
      throw error;
    }
  }

  // ---- Liste ----
  if (sub === '' && method === 'GET') {
    const type = url.searchParams.get('type') || '';
    if (type && !BRAND_DOCUMENT_TYPES[type]) fail('Belge türü geçersiz.');
    const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const cursor = (url.searchParams.get('cursor') || '').slice(0, 60);
    const terms = [], args = [];
    if (type) { terms.push('b.type=?'); args.push(type); }
    if (query) { terms.push('(b.document_no LIKE ? OR b.content_json LIKE ?)'); args.push('%' + query + '%', '%' + query + '%'); }
    if (cursor) { terms.push('b.created_at < ?'); args.push(cursor); }
    const where = terms.length ? ' WHERE ' + terms.join(' AND ') : '';
    try {
      const rows = (await db.prepare(
        `SELECT ${COLUMNS.split(',').map(c => 'b.' + c).join(',')},s.name party_name,b.content_json ` +
        `FROM brand_documents b LEFT JOIN suppliers s ON s.id=b.party_id${where} ` +
        'ORDER BY b.created_at DESC LIMIT 51'
      ).bind(...args).all()).results;
      const page = rows.slice(0, 50);
      return {
        workspace: env.WORKSPACE, available: true, types: BRAND_DOCUMENT_TYPES,
        items: page.map(row => {
          const content = JSON.parse(row.content_json);
          const {content_json, ...rest} = row;
          return {...rest, title: content.title, issue_date: content.issue_date, example: content.example === true};
        }),
        next_cursor: rows.length > 50 ? page[page.length - 1].created_at : null
      };
    } catch (error) {
      if (missingTable(error)) return closed();
      throw error;
    }
  }

  // ---- Oluştur ----
  if (sub === '' && method === 'POST') {
    const input = await readBody(request);
    const type = BRAND_DOCUMENT_TYPES[input.type] ? input.type : fail('Belge türü geçersiz.');
    const content = readContent(input.content, type);
    const presentation = readPresentation(input.presentation);
    const idempotency = input.idempotency_key === undefined || input.idempotency_key === null
      ? null : key(input.idempotency_key);
    let party = null;
    if (input.party_id !== undefined && input.party_id !== null && input.party_id !== '') {
      party = key(input.party_id);
      await partyCard(db, party);
    }
    try {
      const source = await readSource(db, input);
      if (idempotency) {
        const existing = await db.prepare('SELECT * FROM brand_documents WHERE idempotency_key=?').bind(idempotency).first();
        // Aynı istek tekrar gelirse yeni belge AÇILMAZ, mevcut belge döner.
        if (existing) return present(existing);
      }
      const row = {
        id: newId(), type,
        document_no: await nextDocumentNo(db, type, content.issue_date.slice(0, 4)),
        revision: 1, supersedes: null, party_id: party, status: 'draft',
        content_json: JSON.stringify(content),
        presentation_json: presentation ? JSON.stringify(presentation) : null,
        source_kind: source.kind, source_id: source.id, idempotency_key: idempotency,
        total_cents: content.totals ? content.totals.total_cents : null,
        line_count: content.lines.length,
        created_by: user.id || '', created_by_name: user.name || 'Yönetici'
      };
      await insert(db, row);
      return present(await loadRow(db, row.id));
    } catch (error) {
      if (missingTable(error)) fail('Kurumsal evrak defteri henüz kurulmadı. Veri göçü uygulanmalı.', 409);
      throw error;
    }
  }

  const single = sub.match(/^\/([\w-]{1,100})$/);
  if (single && method === 'GET') {
    try { return present(await loadRow(db, single[1])); }
    catch (error) { if (missingTable(error)) fail('Kurumsal evrak defteri henüz kurulmadı.', 409); throw error; }
  }

  // ---- Taslak güncelle; çakışmada 409 ----
  if (single && method === 'POST') {
    const input = await readBody(request);
    try {
      const row = await loadRow(db, single[1]);
      if (row.status !== 'draft') fail('Dondurulmuş belge değiştirilemez. Yeni revizyon alın.', 409);
      if (input.expected_revision !== undefined && input.expected_revision !== row.revision)
        fail('Bu belge başka bir yerde değişti. Sayfayı yenileyip tekrar deneyin.', 409);
      if (await db.prepare('SELECT id FROM brand_documents WHERE supersedes=?').bind(row.id).first())
        fail('Bu belgenin daha yeni bir revizyonu var.', 409);
      const content = readContent(input.content, row.type);
      const presentation = Object.hasOwn(input, 'presentation')
        ? readPresentation(input.presentation)
        : (row.presentation_json ? JSON.parse(row.presentation_json) : null);
      await db.prepare(
        'UPDATE brand_documents SET content_json=?,presentation_json=?,total_cents=?,line_count=?,' +
        'updated_at=CURRENT_TIMESTAMP WHERE id=?'
      ).bind(JSON.stringify(content), presentation ? JSON.stringify(presentation) : null,
        content.totals ? content.totals.total_cents : null, content.lines.length, row.id).run();
      return present(await loadRow(db, row.id));
    } catch (error) {
      if (/BRAND_DOC_FROZEN/.test(String(error.message))) fail('Bu belge artık değiştirilemez.', 409);
      if (missingTable(error)) fail('Kurumsal evrak defteri henüz kurulmadı.', 409);
      throw error;
    }
  }

  // ---- Yeni revizyon ----
  const revisions = sub.match(/^\/([\w-]{1,100})\/revisions$/);
  if (revisions && method === 'POST') {
    const input = await readBody(request);
    try {
      const row = await loadRow(db, revisions[1]);
      if (await db.prepare('SELECT id FROM brand_documents WHERE supersedes=?').bind(row.id).first())
        fail('Bu belgenin zaten bir revizyonu var.', 409);
      const content = readContent(input.content === undefined ? JSON.parse(row.content_json) : input.content, row.type);
      const presentation = Object.hasOwn(input, 'presentation')
        ? readPresentation(input.presentation)
        : (row.presentation_json ? JSON.parse(row.presentation_json) : null);
      const next = {
        id: newId(), type: row.type, document_no: row.document_no, revision: row.revision + 1,
        supersedes: row.id, party_id: row.party_id, status: 'draft',
        content_json: JSON.stringify(content),
        presentation_json: presentation ? JSON.stringify(presentation) : null,
        source_kind: row.source_kind, source_id: row.source_id, idempotency_key: null,
        total_cents: content.totals ? content.totals.total_cents : null,
        line_count: content.lines.length,
        created_by: user.id || '', created_by_name: user.name || 'Yönetici'
      };
      await insert(db, next);
      return present(await loadRow(db, next.id));
    } catch (error) {
      if (missingTable(error)) fail('Kurumsal evrak defteri henüz kurulmadı.', 409);
      throw error;
    }
  }

  // ---- Çoğalt: yeni kimlik ve numara; önceki belge değişmez ----
  const duplicate = sub.match(/^\/([\w-]{1,100})\/duplicate$/);
  if (duplicate && method === 'POST') {
    try {
      const row = await loadRow(db, duplicate[1]);
      const content = JSON.parse(row.content_json);
      const next = {
        id: newId(), type: row.type,
        document_no: await nextDocumentNo(db, row.type, content.issue_date.slice(0, 4)),
        revision: 1, supersedes: null, party_id: row.party_id, status: 'draft',
        content_json: row.content_json, presentation_json: row.presentation_json,
        source_kind: row.source_kind, source_id: row.source_id, idempotency_key: null,
        total_cents: row.total_cents, line_count: row.line_count,
        created_by: user.id || '', created_by_name: user.name || 'Yönetici'
      };
      await insert(db, next);
      return present(await loadRow(db, next.id));
    } catch (error) {
      if (missingTable(error)) fail('Kurumsal evrak defteri henüz kurulmadı.', 409);
      throw error;
    }
  }

  // ---- Dondur: AÇIK kullanıcı eylemi. Çıktı almak tek başına finalize DEĞİLDİR. ----
  const finalize = sub.match(/^\/([\w-]{1,100})\/finalize$/);
  if (finalize && method === 'POST') {
    try {
      const row = await loadRow(db, finalize[1]);
      if (row.status === 'archived') fail('Arşivlenmiş belge dondurulamaz.', 409);
      if (row.status === 'final') return present(row);
      await db.prepare('UPDATE brand_documents SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind('final', row.id).run();
      return present(await loadRow(db, row.id));
    } catch (error) {
      if (missingTable(error)) fail('Kurumsal evrak defteri henüz kurulmadı.', 409);
      throw error;
    }
  }

  // ---- Arşivle: geçmişi SİLMEZ ----
  const archive = sub.match(/^\/([\w-]{1,100})\/archive$/);
  if (archive && method === 'POST') {
    try {
      const row = await loadRow(db, archive[1]);
      await db.prepare('UPDATE brand_documents SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind('archived', row.id).run();
      return present(await loadRow(db, row.id));
    } catch (error) {
      if (missingTable(error)) fail('Kurumsal evrak defteri henüz kurulmadı.', 409);
      throw error;
    }
  }

  fail('İstek bulunamadı.', 404);
}
