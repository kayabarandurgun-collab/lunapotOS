# Akıllı takip — 4 Ekim 2026

Kullanıcı: tek tük zararları süzüp HB/TY bazında tekrarlayan küçük zararlar için fiyat uyarısı, iadelerin/teslim edilemeyenlerin ayrılması; ayrıca fiziksel stok tüketimine göre tedarikçi, haftalık hız ve kalan gün önerisi.

- Kayıtlar salt okunur; fiyat, tedarik siparişi, mesaj veya muhasebe hareketi otomatik oluşturulmaz.
- Ortak satış sonucu + tarihsel satılan set bileşimi; son 30 günde son 5 bağımsız siparişte en az 3 zarar, son sonuç da zarar ve net eksi.
- İade / teslim edilememe / teknik düzeltme fiyat örneklerine girmez; ilk ikisi kendi tekrar sinyalini üretir.
- Stok fiziksel bileşen tüketimi üzerinden; müşteri kargosu iki kez düşülmez; tedarikçi marka adına bakılarak uydurulmaz.
- Ana ekranda ayrı güncel Akıllı takip bölümü, tür filtreleri, kanıtlar ve çalışan derin bağlantılar.
- Kullanıcının önceki yayın yetkisi geçerli; testlerden sonra canlı yayın. GitHub main push kapsam dışı.

Otomatik onay notu: ilk birleşik değişiklik, sales_alerts alanının tutar gizlemeyi zayıflatabileceği gerekçesiyle reddedildi; hiçbir dosya yazılmadı. Daha açık bir kısıtlayıcı guard önce bellekte gerçek scrubAmounts ile test edildi, sonra uygulandı. Tutar izni olmayan kullanıcıda sales_alerts bütünüyle null; mevcut parasal alanlar da gizli. Bu güvenli değişiklik onaylandı; engelli kalan işlem yok.
