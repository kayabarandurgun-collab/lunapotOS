// OTOMATİK BAKIM EKRANDA GÖRÜNÜR. Eskiden yalnız iş yapıldığında kayıt yazılıyordu: kullanıcı bakımın
// çalışıp çalışmadığını hiçbir ekrandan göremiyordu (canlıda da doğrulanamadı). Artık iş yokken de en
// çok 6 saatte bir iz bırakılır ve "Şirket ve yedek" ekranı son işleri listeler. TEMSİLİ veri.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {otomatikBakim} from '../src/otomatik-bakim.js';

const izler = f => f.sqlite.prepare("SELECT description,created_at FROM ec_activity WHERE description LIKE 'Otomatik bakım%' ORDER BY created_at").all();

test('İş yokken bakım en çok 6 saatte bir iz bırakır; ekran son işleri gösterir', async () => {
  const f = appFixture(); await f.setup(); try {
    await otomatikBakim(f.env, {simdi: Date.parse('2026-09-12T12:00:00Z')});
    assert.equal(izler(f).length, 1, 'ilk turda "iş yoktu" izi');
    assert.match(izler(f)[0].description, /iş yoktu/);
    await otomatikBakim(f.env, {simdi: Date.parse('2026-09-12T12:15:00Z')});
    await otomatikBakim(f.env, {simdi: Date.parse('2026-09-12T12:30:00Z')});
    assert.equal(izler(f).length, 1, '15 dakikada bir tekrar yazılmaz');
    // 6 saat öncesine çekilen iz sonraki turda yenilenir.
    f.sqlite.exec("UPDATE ec_activity SET created_at=datetime('now','-7 hours')");
    await otomatikBakim(f.env, {simdi: Date.parse('2026-09-12T19:00:00Z')});
    assert.equal(izler(f).length, 2, '6 saat geçince yeniden yazılır');
    const s = await f.ok('/ec/settings');
    assert.ok(Array.isArray(s.jobs) && s.jobs.length >= 2, 'ekran son işleri alır');
    assert.match(s.jobs[0].description, /Otomatik bakım/);
  } finally { f.close(); }
});
