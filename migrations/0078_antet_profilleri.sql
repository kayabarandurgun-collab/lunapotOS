-- ANTET PROFİLLERİ: BELGEDE SEÇİLEN ŞİRKET KİMLİĞİ.
--
-- Bu göç YALNIZ EKLEYİCİDİR. Hiçbir mevcut satır değişmez, hiçbir tablo düşmez,
-- hiçbir tetik kaldırılmaz.
--
-- NEDEN. 0077 antet alanlarını workspace_settings'e ekledi ama orası çalışma
-- alanı başına TEK satır tutuyor ('ec' ve 'lp'). Kullanıcının iki ayrı tüzel
-- kişiliği var ve ikisi de aynı çalışma alanından belge kesiyor; bu yüzden antet
-- kimliği çalışma alanına değil, BELGEYE bağlanmalı. Bu tablo o profilleri tutar.
--
-- workspace_settings'teki antet sütunları (0077) OLDUĞU YERDE KALIR ve
-- /api/brand-profile ucu çalışmaya devam eder: eski taslaklar bozulmasın.
--
-- BU TABLO MUHASEBE KAYDI DEĞİLDİR. Yalnız kâğıda basılan kimlik bilgisidir:
-- hiçbir fatura, defter, stok ya da kasa hareketi buradan okunmaz ve bu dosyada
-- o tablolara yazan tek bir tetik yoktur. Vergi numarası burada SERBEST METİNDİR;
-- alış faturası eşleştirmesi workspace_settings.tax_id üzerinden yürür ve ona
-- dokunulmaz.
--
-- KÖK VERİTABANINDA durur (workspace_settings gibi): iki çalışma alanı da aynı
-- profil listesini görür, profil çalışma alanına göre çoğaltılmaz.

CREATE TABLE brand_profiles(
 id TEXT PRIMARY KEY,
 -- Listede ve belgedeki açılır kutuda görünen kısa ad: "Dekovill", "Lunapot Endüstriyel".
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
 legal_name TEXT NOT NULL DEFAULT '' CHECK(length(legal_name) <= 200),
 tax_id TEXT NOT NULL DEFAULT '' CHECK(length(tax_id) <= 20),
 tax_office TEXT NOT NULL DEFAULT '' CHECK(length(tax_office) <= 120),
 address TEXT NOT NULL DEFAULT '' CHECK(length(address) <= 400),
 phone TEXT NOT NULL DEFAULT '' CHECK(length(phone) <= 60),
 email TEXT NOT NULL DEFAULT '' CHECK(length(email) <= 160),
 website TEXT NOT NULL DEFAULT '' CHECK(length(website) <= 160),
 bank_name TEXT NOT NULL DEFAULT '' CHECK(length(bank_name) <= 120),
 bank_iban TEXT NOT NULL DEFAULT '' CHECK(length(bank_iban) <= 40),
 signature_title TEXT NOT NULL DEFAULT '' CHECK(length(signature_title) <= 120),
 -- Yeni belge açılınca önseçili gelen profil. Kısmi tekil indeks tek tane olmasını sağlar.
 is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
 -- Silinen profil kaybolmaz: eski belgeler hangi kimlikle basıldığını göstermeye devam eder.
 archived_at TEXT,
 sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX brand_profiles_label ON brand_profiles(label) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX brand_profiles_default ON brand_profiles(is_default) WHERE is_default=1;
CREATE INDEX brand_profiles_order ON brand_profiles(sort_order,label);

-- Arşivlenmiş profil varsayılan kalamaz: açılır kutuda görünmeyen bir kimlik
-- yeni belgeye sessizce basılmasın.
CREATE TRIGGER brand_profiles_archived_default BEFORE UPDATE OF archived_at ON brand_profiles
WHEN NEW.archived_at IS NOT NULL AND NEW.is_default=1
BEGIN SELECT RAISE(ABORT,'BRAND_PROFILE_DEFAULT_ARCHIVED'); END;

-- 0077'de girilmiş antet bilgisi varsa ilk profil ondan kurulur: kullanıcı aynı
-- bilgiyi ikinci kez yazmasın. Hiçbir değer UYDURULMAZ; yalnız dolu olan taşınır
-- ve hiçbir alanı dolu değilse satır hiç oluşmaz.
INSERT INTO brand_profiles(id,label,legal_name,tax_id,tax_office,address,phone,email,website,bank_name,bank_iban,signature_title,is_default,sort_order)
-- Etiket açılır kutuda görünür, o yüzden KISA olmalı: tam unvan yerine ilk
-- sözcük alınır ("Dekovill Mimarlık İnşaat..." -> "Dekovill"). Kullanıcı ekrandan
-- dilediği gibi değiştirir; tam unvan zaten legal_name'de durur.
SELECT 'profil-ec',
 CASE
  WHEN legal_name='' THEN 'Şirket 1'
  WHEN instr(legal_name,' ')>1 THEN substr(legal_name,1,instr(legal_name,' ')-1)
  ELSE substr(legal_name,1,80)
 END,
 legal_name,tax_id,tax_office,address,phone,email,website,bank_name,bank_iban,signature_title,1,0
FROM workspace_settings
WHERE workspace='ec'
 AND (legal_name!='' OR address!='' OR phone!='' OR email!='' OR website!='' OR tax_office!='' OR bank_name!='' OR bank_iban!='');
