# Ana ekran — 4 Ekim 2026

Kullanıcının isteği: gerçek bileşen yenilemesi; KDV dahil satılan mal maliyeti, komisyon, kargo, diğer kesintiler, tüm zamanlar toplamları, daha açıklayıcı grafikler ve çalışan mobil iş akışları.

- Sunucu: paylaşılan paket sonuçlarından kapsamı belirli, bilinmeyeni sıfır yapmayan mali özet ve günlük seri.
- Arayüz: dönem kartları, ciro/maliyet/kalan eğrileri, satışın gider dağılımı, kanal karşılaştırması, paket sonuçları, ilk satıştan bugüne kesinti defteri.
- Güncel depo/kargo ile tarihli satış sonucu ayrı. Banka ödemesi olduğu doğrulanmayan kesintiler ödenmiş nakit diye adlandırılmaz.
- Gerçek tarayıcı: masaüstü + mobil, tarih ve grafik kontrolleri, kritik iş bağlantıları; sentetik yerel Worker/SQLite.
- Tam test, yapı, değişiklik raporu; kullanıcının önceki yetkisiyle canlı yayın. GitHub main push kapsam dışı (önceki otomatik onay reddi).
