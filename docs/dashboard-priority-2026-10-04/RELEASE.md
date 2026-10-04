# Satış performansı önce — v178

4 Ekim 2026. Kullanıcı ana ekranın tepesinde satış performansını, Bugün neye dikkat etmelisin? bölümünü daha aşağıda görmek istedi.

Yeni sıra: sayfa başlığı → satış performansı/ciro/kalan/maliyet/grafikler → günlük işlem bağlantıları → Akıllı takip. Sıra DOM düzeyinde değiştiği için masaüstü, telefon ve klavye aynı akışı izler. Uyarı ve muhasebe hesapları değişmedi.

Değişen kaynaklar: public/operations-ui.js ve public/sw.js. SW önbelleği lunapot-shell-v178-performance-first.

Kontroller: mevcut grafik/uyarı tarayıcı grubu 11/11 başarılı; 1440/390/320px üzerinde gerçek yerel Chrome ile DOM ve görünür bölüm sırası, yatay taşma kontrol edildi. Masaüstü ve telefonun ilk ekran görüntüleri incelendi. Derleme ve boşluk kontrolü geçti. Bu küçük sıralama değişikliğinde tam test paketi tekrar çalıştırılmadı; önceki v177 tam test ve bilinen iki dış mağaza önizleme hatası kendi raporunda korunur.

Canlı sürüm 3239ccf6-17ba-4994-9525-e19a293756b1; dağıtım 8e99b796-f98f-441e-8fe5-98e8aba44960, trafik %100. Doğru D1 bağı ve bakım kapalı doğrulandı. İki değişen canlı dosyanın SHA256 değeri yerelle eşleşti. Geri dönüş sürümü:77068919-6bf3-4c81-8078-e64fb3acc50d. Migration yok. Canlıya giriş yapılmış tarayıcı incelemesi yeniden iddia edilmiyor; önceki CUA ortam hatası geçerli.

Tek dosya devir docs/CLAUDE-DEVIR-2026-10-04-AKILLI-UYARILAR.txt yeniden güncellendi; work/handoffs/Claude-Akilli-Uyarilar-Devir-2026-10-04.txt aynı kopyadır. Önceki motor incelemeleri docs/sales-alerts-2026-10-04 altında korunur. Yerel commit kimliği local-commit.json; GitHub push yok.
