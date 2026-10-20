# Pulim sayti

Pulim Telegram boti haqidagi tanishtiruv sayti. Bitta fayl: `index.html` (logotip ichiga joylangan, tashqi fayl kerak emas).

## Tarkibi

- `index.html` — sayt: imkoniyatlar, jonli demo, tariflar, taklif dasturi, savollar.
- `rasmlar/` — reklama rasmlari (tariflar, Mega skidka, taklif dasturi) Telegram va Instagram uchun.

## Ishga tushirish

**GitHub Pages:** repo → Settings → Pages → Source: `Deploy from a branch`, Branch: `main`, papka: `/ (root)`.
Sayt `https://<login>.github.io/<repo>/sayt/` manzilida ochiladi.

**Vercel / Netlify:** loyiha yaratib, Root Directory sifatida `sayt` papkasini tanlang. Build buyrug‘i kerak emas.

**Lokal ko‘rish:** `index.html` ni brauzerda oching.

## O‘zgartirish

- Narxlar: `index.html` ichida `class="price"` qatorlari.
- Aksiya banneri: `class="promo"` bloki (aksiya tugasa, shu blokni o‘chiring).
- Bot havolasi: `t.me/pulim_bott`, obuna uchun: `t.me/khrmnvccc`.
