-- SABİT (TEKRARLI) GENEL GİDER ve gider ADI.
-- Kira, elektrik, yakıt, muhasebeci gibi giderler her ay aynı tutarla tekrarlıyor. Kullanıcı bunları
-- her ay elle girmesin diye bir kez tanımlanır, ayın gideri buradan üretilir.
--
-- ÇİFT YAZMA OLAMAZ: üretilen gider referansı 'GIDER-PLAN-<plan>-<YYYY-MM>' biçimindedir ve
-- expenses.reference zaten TEKİLDİR. Üretim tekrar çalıştırılsa da aynı ay ikinci kez yazılmaz;
-- bu yüzden ayrı bir "üretildi" işareti tutulmaz (tutulsaydı kayıtla iki ayrı doğruluk kaynağı olurdu).
--
-- AYIN GÜNÜ 1-28: 29-31 olmayan aylarda kayması ya da atlanması gereken bir gün kalmasın.
--
-- label: gider kategorisi kaba (elektrik de yakıt da 'other'). Ekranda ayırt edilsin diye ad yazılır.
-- Eski kayıtlar boş adla kalır; boş ad kategori adıyla gösterilir.

ALTER TABLE ec_expenses ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE lp_expenses ADD COLUMN label TEXT NOT NULL DEFAULT '';

CREATE TABLE ec_expense_schedules(
 id TEXT PRIMARY KEY,
 label TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('shipping','commission','advertising','rent','packaging','loss','other')),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
 day_of_month INTEGER NOT NULL CHECK(typeof(day_of_month)='integer' AND day_of_month BETWEEN 1 AND 28),
 starts_on TEXT NOT NULL,
 ends_on TEXT,
 notes TEXT NOT NULL DEFAULT '',
 archived_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(ends_on IS NULL OR ends_on>=starts_on));
CREATE INDEX ec_expense_schedule_live ON ec_expense_schedules(archived_at,starts_on);

CREATE TABLE lp_expense_schedules(
 id TEXT PRIMARY KEY,
 label TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('shipping','commission','advertising','rent','packaging','loss','other')),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
 day_of_month INTEGER NOT NULL CHECK(typeof(day_of_month)='integer' AND day_of_month BETWEEN 1 AND 28),
 starts_on TEXT NOT NULL,
 ends_on TEXT,
 notes TEXT NOT NULL DEFAULT '',
 archived_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(ends_on IS NULL OR ends_on>=starts_on));
CREATE INDEX lp_expense_schedule_live ON lp_expense_schedules(archived_at,starts_on);
