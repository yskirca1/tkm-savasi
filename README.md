# 🪨📄✂️ Taş Kağıt Makas Savaşı

Arkadaşlarla internetten oynanan, 2-3 kişilik gerçek zamanlı "Taş Kağıt Makas savaşı". Her turda herkes bir tür seçer, haritadaki birimler çarpıştıkça birbirini dönüştürür, haritada tek tür kalınca o türü seçen turu kazanır.

- **Monorepo:** `shared/` (ortak tipler, sabitler, socket mesajları) · `server/` (Node + Express + Socket.IO, yetkili simülasyon) · `client/` (Vite + TypeScript + Canvas)
- **Kimlik ve veri:** Supabase (Google OAuth, e-posta + şifre, Postgres + RLS)
- **Mimari ve sözleşmeler:** [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 1. Yerelde çalıştırma

Gerekenler: Node.js 20+ (22 önerilir).

```bash
npm install
npm run dev
```

- İstemci: http://localhost:5173 (Vite; `/api` ve `/socket.io` isteklerini 3001'e yönlendirir)
- Oyun sunucusu: http://localhost:3001

**Supabase ayarlamadan da çalışır ("dev modu").** `.env` yoksa sunucu kullanıcıları bellekte tutar ve `server/.dev-data/db.json` dosyasına yazar. Kullanıcı adı + şifreyle kayıt/giriş çalışır, Google düğmesi kapalı görünür. "Şifremi unuttum" mail göndermez, sıfırlama bağlantısını **sunucu konsoluna** yazar.

Aynı bilgisayarda çok oyunculu deneme: farklı tarayıcı profillerinde (ya da bir normal, bir gizli pencere) farklı kullanıcılarla giriş yapın. Aynı profildeki sekmeler aynı oturumu paylaşır.

Diğer komutlar:

```bash
npm test            # simülasyon + sunucu testleri (vitest)
npm run typecheck   # server + client tip kontrolü
npm run build       # client/dist üretir
npm start           # üretim modu: sunucu client/dist'i de sunar (önce build)
```

Telefonla aynı Wi-Fi'den denemek için: `npm run dev` çıktısındaki "Network" adresini (ör. `http://192.168.1.20:5173`) telefonda açın.

---

## 2. Supabase projesi kurma

1. https://supabase.com → **New project**. Bölge olarak oyunculara yakın olanı seçin (Türkiye için `eu-central-1` Frankfurt).
2. **SQL Editor → New query**: [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql) dosyasının tamamını yapıştırıp **Run**. Bu; `profiles`, `matches`, `match_results` tablolarını, `profile_stats` görünümünü ve Row Level Security kurallarını oluşturur.
3. **Project Settings → API** sayfasından şunları alın:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` anahtarı → `SUPABASE_ANON_KEY`
   - `service_role` anahtarı → `SUPABASE_SERVICE_ROLE_KEY` (**gizli**, yalnızca sunucuda)
4. **Authentication → URL Configuration**:
   - *Site URL*: uygulamanın adresi (yerelde `http://localhost:5173`, canlıda `https://<uygulama>.onrender.com`)
   - *Redirect URLs*: `http://localhost:5173/**` ve `https://<uygulama>.onrender.com/**`
5. **Authentication → Sign In / Providers → Email**: açık olmalı. Kayıt sunucu tarafında `email_confirm: true` ile yapıldığı için ayrıca e-posta onayı istenmez.

## 3. Google OAuth istemcisi

1. https://console.cloud.google.com → yeni proje → **APIs & Services → OAuth consent screen**: *External*, uygulama adı, destek e-postası. Test aşamasında arkadaşlarınızı **Test users** listesine ekleyin (ya da uygulamayı *In production* durumuna alın).
2. **Credentials → Create credentials → OAuth client ID → Web application**
   - *Authorized JavaScript origins*: `http://localhost:5173`, `https://<uygulama>.onrender.com`
   - *Authorized redirect URIs*: `https://<SUPABASE-PROJE-REF>.supabase.co/auth/v1/callback`
3. Çıkan **Client ID** ve **Client secret**'ı Supabase'de **Authentication → Sign In / Providers → Google** bölümüne girip etkinleştirin.

Google'ı henüz kurmadıysanız `.env` içinde `GOOGLE_ENABLED=false` yapın; düğme pasif görünür.

## 4. SMTP (şifre sıfırlama maili)

Supabase'in yerleşik mail servisi saatte birkaç mail ile sınırlıdır ve yalnızca test içindir. Canlıda özel SMTP kullanın, örnek **Resend**:

1. https://resend.com → hesap → **Domains**: kendi alan adınızı ekleyip DNS kayıtlarını (SPF/DKIM) doğrulayın. (Alan adı yoksa Resend yalnızca kendi e-postanıza test maili gönderir.)
2. **API Keys** → yeni anahtar.
3. Supabase → **Project Settings → Authentication → SMTP Settings → Enable custom SMTP**:
   - Host `smtp.resend.com`, Port `465`, Username `resend`, Password = Resend API anahtarı
   - Sender email: `noreply@alanadiniz.com`, Sender name: `TKM Savaşı`
4. İsteğe bağlı: **Authentication → Emails → Reset Password** şablonunu Türkçeleştirin. Bağlantı `{{ .ConfirmationURL }}` olarak kalmalı.

Sıfırlama bağlantısı kullanıcıyı `APP_URL/reset` sayfasına getirir, orada yeni şifre belirlenir.

## 5. Ortam değişkenleri

`.env.example` dosyasını kökte `.env` olarak kopyalayıp doldurun:

| Değişken | Açıklama |
|---|---|
| `PORT` | Sunucu portu (yerelde 3001; Render kendisi verir) |
| `APP_URL` | Uygulamanın herkese açık adresi; sıfırlama maili buraya döner |
| `SUPABASE_URL` | Supabase proje adresi |
| `SUPABASE_ANON_KEY` | Supabase anon anahtarı (istemciye `/api/config` ile gider, gizli değildir) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Gizli.** Yalnızca sunucu; istatistik yazma, kullanıcı adından e-posta bulma |
| `GOOGLE_ENABLED` | `false` ise Google düğmesi kapalı |
| `DEV_JWT_SECRET` | Yalnızca dev modu |
| `UNITS_PER_TYPE` | Tur başına her türden birim sayısı (4-20, varsayılan 12) |

Üç Supabase değişkeni de doluysa sunucu "supabase modunda", değilse "dev modunda" açılır (başlangıçta konsola yazar).

## 6. Deploy (Render)

Oyun sunucusu WebSocket kullanır, bu yüzden Vercel değil **Render** (ya da Railway). Tek bir servis hem oyunu hem istemciyi sunar.

1. Projeyi bir GitHub deposuna gönderin.
2. https://render.com → **New → Blueprint** → depoyu seçin. Kökteki [`render.yaml`](render.yaml) servisi tanımlar (build: `npm ci --include=dev && npm run build`, start: `npm start`, health: `/healthz`).
3. İstenen ortam değişkenlerini girin: `APP_URL` (ör. `https://tkm-savasi.onrender.com`), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
4. Deploy bitince adresi Supabase *Site URL / Redirect URLs* ve Google *Authorized JavaScript origins* listelerine ekleyin.

Notlar:
- Render ücretsiz planı 15 dk boşta kalınca uyur; ilk açılış ~30-60 sn sürebilir. Oynamadan önce linki bir kez açın. Kesintisiz istiyorsanız Starter plan.
- Odalar sunucu belleğindedir: deploy ya da yeniden başlatma devam eden maçları bitirir. Tek örnek (instance) çalıştırın; yatay ölçekleme bu sürümde desteklenmez.

**Railway alternatifi:** New Project → Deploy from GitHub → Variables'a aynı değişkenleri girin; Build `npm ci --include=dev && npm run build`, Start `npm start`. Railway `PORT`'u kendisi verir.

---

## Oyun kuralları (özet)

- 3 koltuk; 2-3 insan. 3 kişi olunca maç kendiliğinden başlar; 2 kişiyse kurucu "Bilgisayarla başlat"a basar.
- Tur sayısı 3/6/9/12 (varsayılan 9). Seçim sırası 3 turluk bloklarda döner: her blokta her koltuk bir kez ilk seçer. Seçim süresi 15 sn.
- Tur: rastgele ve tamamı birbirine bağlı harita, her türden eşit birim. Taş makası, makas kağıdı, kağıt taşı yener ve kendine çevirir. Tek tür kalınca tur biter.
- Hız: 30. sn 2x, 45. sn 3x, 60. sn 5x. 90. sn'den sonra hayatta kalanlar oybirliğiyle turu bitirebilir; en çok birimi olan tür kazanır, eşitlikte puan yok.
- Bağlantısı kopan oyuncu için oyun 30 sn bekler; dönmezse yerine bilgisayar geçer.

## Hata ayıklama

Her turun seed'i sunucu konsoluna yazılır: `[room ABCDE] round 4 seed 123456`. Aynı seed aynı haritayı ve aynı başlangıç dizilimini üretir (`server/src/sim`).
