# Contentrain — Pricing & Revenue Strategy

> 2026-03-26 — Strategic analysis based on implemented features + roadmap
> Decision document — supersedes pricing references in other specs

---

## 1. Ürün Ne Yapıyor (Gerçek, Bugün)

| Katman | Ne | Kime Değer | Maliyet Kaynağı |
|--------|-----|-----------|----------------|
| Content Engine | Git-native model/entry CRUD, branch workflow | Developer | Sıfır (Git API) |
| AI Agent | Conversation-first content ops (15 tool) | Developer + Non-dev | Claude API ($0.003-0.01/msg) |
| CDN Delivery | JSON + media HTTP endpoint | Mobile/desktop app | R2 storage + bandwidth |
| Media Pipeline | Upload → optimize → variant → blurhash | Developer + Designer | R2 storage + Sharp CPU |
| Review Workflow | Branch-based approve/reject | Team | Sıfır (Git branches) |
| SDK | @contentrain/query local + CDN mode | Developer | Sıfır (npm package) |
| MCP Tools | External AI agent entegrasyonu | Power user | Sıfır (open source) |

**Gerçek maliyet oluşturan 3 şey:**
1. Claude API çağrıları (AI agent messages)
2. R2 storage (media files + CDN content)
3. R2 bandwidth (CDN reads + media serves)

Geri kalan her şey — content engine, git ops, SDK, review workflow — **sıfır marjinal maliyet.**

---

## 2. Hedef Kitle Analizi

### Tier 1: Vibe Coder / Solo Developer (en büyük hacim)

```
Profil: Cursor/Windsurf ile app yapıyor, 1 kişi, side project veya freelance
Pain: Hardcoded strings, müşteri content değiştiremez, i18n yok
Willingness to pay: $0-15/mo (kendi parasını harcıyor)
Kullanım: 20-50 AI msg/mo, 1-2 proje, minimal CDN
Değer: Content yapılandırma + AI agent + müşteriye handoff
```

### Tier 2: Indie Hacker / Small Team (2-5 kişi)

```
Profil: SaaS/app yapıyor, marketer + developer
Pain: Her text değişikliği PR gerektiriyor, content ops yok
Willingness to pay: $15-50/mo (şirket kartı)
Kullanım: 100-300 AI msg/mo, 3-5 proje, orta CDN
Değer: Team workflow + review + CDN delivery
```

### Tier 3: Agency / Freelancer (müşteri projeleri)

```
Profil: 3-10 müşteri projesi yönetiyor
Pain: Her müşteri için content yönetim kurulumu
Willingness to pay: $30-100/mo (müşteriye fatura ediyor)
Kullanım: 5-15 proje, her biri düşük, ama çok workspace
Değer: ∞ workspace + hızlı setup + müşteri handoff
```

### Tier 4: Startup Product Team (5-20 kişi)

```
Profil: Web + mobile + docs yönetiyor
Pain: Content ops = developer'ın side job'ı
Willingness to pay: $50-200/mo (department budget)
Kullanım: Yoğun AI, CDN, media, API entegrasyonları
Değer: Conversation API + webhooks + advanced roles
```

---

## 3. Rekabet ve Fiyat Karşılaştırması

| Rakip | Free | Paid | Model | Contentrain avantajı |
|-------|------|------|-------|---------------------|
| **Sanity** | 3 user, 500K API | $99/mo (Growth) | User + API call | Git-native, AI-native, daha ucuz |
| **Contentful** | 5 user, 25K records | $300/mo (Team) | User + record | Çok daha ucuz, self-host option |
| **Strapi Cloud** | — | $29/mo | Instance | Git-native, conversation-first |
| **Payload Cloud** | — | $50/mo | Instance | AI agent, CDN built-in |
| **Keystatic** | Free (local) | — | No hosted | Contentrain = hosted + AI + CDN |
| **Typeform** | 10 response/mo | $25/mo | Response count | CMS + Form = tek platform |
| **Cloudinary** | 25 credit/mo | $89/mo | Credit/transform | CMS + Media = tek platform |

**Contentrain Pro $9/mo tüm bunlardan ucuz** — ama daha az olgun. Fiyat avantajı var, feature parity konusunda yetişmesi lazım.

---

## 4. Gelir Kanalları (Mümkün Olan Her Şey)

### A. SaaS Subscription (Recurring)

Base plan — feature unlock. Predictable ama düşük ARPU.

### B. Usage-Based (Metered)

AI credits, CDN bandwidth, media storage, form submissions, API calls.
Yüksek marj (AI: %40-60, CDN: %80+), ama unpredictable.

### C. AI Credit Packs (One-time / Recurring)

BYOA alternatifi. Müşteri kendi key'i yoksa credit satın alır.
**En yüksek marjlı ürün.** Claude Sonnet: ~$0.005/msg maliyet, $0.02/msg satış = %75 marj.

### D. Enterprise Self-Host License (Annual)

AGPL exemption — "kaynak kodunuzu açmak zorunda kalmadan self-host edin."
$299-999/mo (annual contract). Yüksek ACV, düşük hacim.

### E. Template / Starter Marketplace (Commission)

Community template'ler: $15-29 tek seferlik, %30 komisyon.
Çok erken — community lazım.

### F. Consulting / Implementation (Service)

$2,000-10,000 per project. Hızlı gelir ama ölçeklenmiyor.

---

## 5. En Doğru Model: Platform Fee + Usage

Klasik tier-based SaaS yerine **platform fee + usage** modeli:

### Neden Tier-Based SaaS Yanlış

```
Pro $9/mo müşterisi:
  - 50 AI msg kullanıyor (dahil)
  - 2GB CDN kullanıyor (dahil)
  - 500MB media kullanıyor (dahil)
  - Contentrain'e maliyeti: ~$0.50
  - Net gelir: $8.50

  SORUN: Bu müşteri hiçbir zaman daha fazla ödemeyecek.
  Team'e geçmesi için bot lazım — bu müşterinin botu yok.
  Sonsuza kadar $9/mo ödeyecek.
```

### Platform Fee + Usage Neden Doğru

```
Aynı müşteri:
  - Platform: $0 (free) veya $9 (pro features)
  - AI credits: 200 msg × $0.02 = $4
  - CDN: 5GB × $0.10 = $0.50
  - Media: 1GB × $0.25 = $0.25
  - Toplam: $4.75 - $13.75

  Büyüdükçe:
  - AI credits: 500 msg × $0.02 = $10
  - CDN: 20GB × $0.10 = $2
  - Media: 3GB × $0.25 = $0.75
  - Toplam: $12.75 - $22.75

  FAYDA: Müşteri büyüdükçe fatura büyüyor. Plan değiştirmesi gerekmez.
```

---

## 6. Önerilen Plan Yapısı

### Free — Hobby / Tryout

```
Fiyat: $0
Amaç: Dene, sev, kal, büyüdüğünde öde

İçerik:
  ∞ workspace, ∞ proje, ∞ model/entry/locale
  AI Agent: 100 msg/mo dahil (BYOA her zaman ∞)
  Forms: 1 form, 100 sub/mo
  CDN: ❌
  Media: ❌
  Review workflow: ❌
  API: ❌

Neden bu kadar cömert:
  - Content engine maliyeti sıfır (Git API)
  - 100 msg/mo maliyeti ~$0.50 (Sonnet)
  - Forms maliyeti sıfır (DB rows)
  - Cömert free = daha çok signup = daha çok conversion
```

### Pro — Going Live ($12/mo)

```
Fiyat: $12/mo (annual $9/mo)
Amaç: Proje canlıya çıkıyor, CDN + Media + Review lazım

Dahil:
  Her şey Free'deki +
  AI Agent: 500 msg/mo dahil
  CDN: 20 GB/mo dahil
  Media: 5 GB storage dahil
  Forms: 5 form, 1,000 sub/mo
  Review workflow: ✅
  Reviewer/Viewer roles: ✅

Overage (dahil miktarı aşınca):
  AI: $0.02/msg
  CDN: $0.10/GB
  Media: $0.25/GB/mo
  Forms: $0.01/sub
```

### Team — Collaboration ($39/mo + $9/seat)

```
Fiyat: $39/mo + $9/seat (3 seat dahil = $39+0, 4. kişiden itibaren +$9)
Amaç: Ekip büyüyor, API + automation lazım

Dahil:
  Her şey Pro'daki +
  AI Agent: 2,000 msg/mo dahil
  CDN: 100 GB/mo dahil
  Media: 20 GB storage dahil
  Forms: ∞ form, 5,000 sub/mo
  Conversation API: ✅ (5 key, 1,000 msg/mo dahil)
  Content REST API: ✅
  Webhook Outbound: ✅ (10 endpoint)
  Advanced roles (model-scoped): ✅
  Custom instructions: ✅
  Seats: 3 dahil, sonra $9/seat

Overage:
  AI: $0.015/msg (volume discount)
  CDN: $0.08/GB
  Media: $0.20/GB/mo
  API msgs: $0.05/msg
  Forms: $0.008/sub
```

### Enterprise — Self-Host & Scale (Custom, annual)

```
Fiyat: $299/mo'dan başlayan (annual contract)
Amaç: AGPL exemption + self-host + compliance

Dahil:
  Her şey Team'deki +
  Self-host license (AGPL exemption)
  SSO (SAML/OIDC)
  GitLab/Bitbucket support
  Multi-repo governance
  White-label branding
  Custom AI model routing
  SLA + dedicated support
  ∞ her şey (no limits)
```

### AI Credit Packs (Add-on, herhangi bir plan)

```
BYOA = ∞ sınırsız (her planda)
Studio-hosted credits (BYOA yoksa):
  Starter:  500 credits  = $5   ($0.010/msg)
  Growth:   2,000 credits = $15  ($0.0075/msg)
  Scale:    10,000 credits = $50  ($0.005/msg)

Planla dahil gelen credits ayrı — pack'ler ek satın alma.
Credits ay sonunda sıfırlanmaz (expiry: 12 ay).
```

---

## 7. Upgrade Tetikleyicileri

```
Free → Pro ($12/mo):
  "Projem canlıya çıkıyor"
  ├── CDN lazım (mobile app content serve)
  ├── Media lazım (görsel yükleme)
  ├── Review workflow lazım (ekipte biri var)
  ├── 100 AI msg yetmiyor (BYOA yoksa)
  └── 5+ form lazım

Pro → Team ($39/mo):
  "Ekip ve automation büyüyor"
  ├── Conversation API lazım (bot entegrasyonu)
  ├── REST API lazım (programatik CRUD)
  ├── Webhooks lazım (Vercel rebuild, Slack bildirim)
  ├── 10+ kişi (seat limiti)
  └── Model-scoped access lazım

Team → Enterprise ($299+/mo):
  "Compliance ve self-host lazım"
  ├── Kendi sunucusunda çalıştırmak istiyor
  ├── SSO zorunlu (kurumsal IT policy)
  ├── AGPL açık kaynak yükümlülüğü istenmiyor
  └── SLA ve dedicated support lazım
```

---

## 8. Gelir Projeksiyonu (Gerçekçi)

### Ay 6

```
Free users:       200
Pro users:         25 × $12        = $300/mo
Team users:         3 × $39+seats  = $160/mo
AI credit packs:   50 × $10 avg   = $500/mo
Enterprise:         0
Usage overage:                     = $100/mo

Total MRR: ~$1,060
Total ARR: ~$12,700

Maliyet:
  Claude API: ~$300/mo
  R2 infra:   ~$50/mo
  Supabase:   ~$25/mo
  Domain:     ~$20/mo
  Total:      ~$395/mo

Net: ~$665/mo
```

### Ay 12

```
Free users:       600
Pro users:         70 × $12         = $840/mo
Team users:         8 × $55 avg    = $440/mo
AI credit packs:  150 × $12 avg    = $1,800/mo
Enterprise:         1 × $299        = $299/mo
Usage overage:                      = $400/mo
Consulting:         1 × $3,000      = $3,000/mo (variable)

Total recurring MRR: ~$3,779
Total ARR: ~$45,350

AI credit contribution: 48% of MRR ← en büyük gelir kaynağı
```

### Ay 24

```
Free users:       2,000
Pro users:          200 × $12       = $2,400/mo
Team users:          25 × $60 avg  = $1,500/mo
AI credit packs:    500 × $15 avg  = $7,500/mo
Enterprise:           3 × $400 avg = $1,200/mo
Usage overage:                     = $1,500/mo

Total recurring MRR: ~$14,100
Total ARR: ~$169,200

AI credits: 53% of MRR ← dominant revenue stream
```

---

## 9. Kritik Karar: AI Credits Birincil Gelir Kaynağı

Tüm analizde bir pattern var: **AI credit satışı, subscription'dan daha fazla gelir üretiyor.**

Neden:
1. **Marj yüksek** (~%60-75, plan tier'ından çok daha yüksek)
2. **Doğal ölçekleniyor** (müşteri daha çok kullandıkça daha çok satın alıyor)
3. **BYOA cannibalize etmiyor** (kendi key'ini ayarlamak teknik bilgi gerektiriyor, çoğu müşteri credit tercih eder)
4. **Her plan seviyesinde geçerli** (Free bile 100 dahil, bitince satın al)
5. **Retention artırıyor** (credit balance = sunk cost, terk etmek zor)

**Strateji:** Plan tier'larını düşük tut (acquisition), AI credits'ten para kazan (monetization).

---

## 10. AGPL Enterprise License — İkinci Gelir Katmanı

12+ ay sonrası hedef. Ama **şimdiden pozisyonlanmalı:**

Website'da: "Self-host with Enterprise License — starting at $299/mo"
Bu mesaj:
1. Ürünün ciddi olduğunu gösterir
2. Kurumsal müşteriler için kapı açar
3. VC/investor'lara enterprise revenue potential gösterir

Gerçek satış 12+ ayda başlar ama **fiyat listesinde olması lazım.**

---

## 11. Neden Marketplace / Template Satışı Şimdi Değil

- Community yok → marketplace boş
- Template kalitesi kontrol edilemez
- Revenue share %30 × $19 = $5.70 per sale — anlamsız hacimde
- **Bunun yerine:** Starter template'leri FREE yap, acquisition funnel olarak kullan

---

## 12. Sonuç: Fiyatlandırma Felsefesi

```
"Platform ucuz, usage para kazandırır."

Plan = kapıyı aç (düşük barrier)
AI Credits = asıl gelir (yüksek marj, doğal ölçeklenir)
Enterprise = anchor price (ciddiyet + büyük ACV)
Consulting = immediate cash (ama ölçeklenmez)
```

Bu Vercel + Supabase + Cloudflare modelinin birleşimi:
- Vercel'den: generous free → usage-based scaling
- Supabase'den: AGPL + enterprise self-host license
- Cloudflare'den: düşük base price + bandwidth/storage metering
