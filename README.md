# MKSI Harita (PWA)

Mobil kullanım için GitHub Pages üzerinde çalışan, offline destekli harita uygulaması.

## Özellikler

- Normal (OSM) ve hibrit (uydu + etiket) harita
- Konum, MGRS, doğruluk, rakım, eğim, hava durumu
- Mesafe / istikamet (6400’lük milyem), daire, kavis (sağ/sol yan hudut göreli)
- Alan ölçümü, kalem çizimi, isimli nokta kaydı
- Veriler tarayıcıda (IndexedDB); JSON dışa/içe aktarım (WhatsApp/Bip ile paylaşım)
- Service Worker ile uygulama + ziyaret edilen karoların önbelleği (bildirim yok)

## GitHub Pages

1. Bu klasörü bir GitHub reposuna yükleyin
2. **Settings → Pages → Deploy from branch → main / root**
3. Adres: `https://KULLANICI.github.io/REPO/`

Telefon: Chrome/Safari ile açın → “Ana ekrana ekle”.

## Yerel test

```bash
npx serve .
```

veya VS Code Live Server. HTTPS veya localhost gerekir (konum + PWA).
