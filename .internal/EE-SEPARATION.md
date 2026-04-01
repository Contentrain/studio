# Enterprise Edition (ee/) Separation Guide

> **Tarih:** 2026-04-01
> **Durum:** Tüm EE altyapısı aktif — CDN, Media, Webhooks, Conversation API, AI Keys

---

## Felsefe

**Tüm özellikler tüm planlarda açık. Fark sadece dahil kullanım miktarı.**

Eski model (feature gating) → Yeni model (limit-based differentiation):
- Starter ($9/mo) — düşük limitler, Haiku AI
- Pro ($29/mo + $9/seat) — yüksek limitler, Sonnet AI
- Enterprise (custom) — sınırsız, SSO, white-label

EE dizini artık "feature erişim kontrolü" değil, **implementasyon ayrımı** sağlıyor.
Core (AGPL) interface'leri tanımlar, EE (proprietary) implementasyonları sağlar.

---

## Özet

Proje mimari olarak **EE-complete**. Database schema, RLS policies, permissions sistemi ve provider pattern sayesinde EE ayrışımı **konfigürasyon + limit** düzeyinde.

---

## Dizin Yapısı

```
ee/
├── LICENSE                          ← Proprietary license text
├── README.md                        ← EE documentation
├── cdn/
│   ├── cloudflare-cdn.ts            ← Cloudflare R2 CDNProvider impl
│   ├── cdn-usage.ts                 ← Usage metering, bandwidth tracking
│   └── cdn-rate-limiter.ts          ← Per-key sliding window rate limiter
├── enterprise/
│   ├── index.ts                     ← Enterprise bridge factory
│   ├── access.ts                    ← Model-specific access normalization (Pro+)
│   ├── ai-keys.ts                   ← BYOA API key management
│   ├── conversation-api.ts          ← External AI content operations API
│   ├── conversation-keys.ts         ← Conversation API key CRUD
│   ├── webhook-dispatch.ts          ← Webhook event emission + retry engine
│   └── webhooks.ts                  ← Webhook endpoint CRUD + test + deliveries
└── media/
    ├── sharp-processor.ts           ← Sharp-based MediaProvider (full pipeline)
    ├── variant-generator.ts         ← Image variant generation (resize, format, quality)
    ├── blurhash-calculator.ts       ← Loading placeholder generation
    └── media-optimizer.ts           ← Original image optimization (EXIF strip, sRGB)
```

---

## Core/EE Sorumluluk Dağılımı

### Genel Pattern

| Katman | Konum | Sorumluluk |
|--------|-------|------------|
| Interface | Core (`server/providers/`) | Contract tanımları |
| API routes | Core (`server/api/`) | Thin shells — `hasFeature()` + `runEnterpriseRoute()` |
| Feature matrix | Core (`shared/utils/license.ts`) | Plan/limit tanımları |
| Enterprise bridge | Core (`server/utils/enterprise.ts`) | Dynamic import + delegation |
| Implementations | **EE** (`ee/`) | Ticari iş mantığı |
| Database schema | Core (`supabase/migrations/`) | Her zaman core'da |
| UI components | Core (`app/components/`) | Her zaman core'da |

### CDN

| Bileşen | Konum | Neden |
|---------|-------|-------|
| `CDNProvider` interface | Core | Contract |
| `cdn-builder.ts` | Core | GitProvider + content-paths kullanır |
| CDN API routes | Core | Thin shell, limit check server-side |
| API key yönetimi | Core | Key gen/hash/validate — generic |
| Cloudflare R2 impl | **EE** | Ticari storage implementasyonu |
| Usage metering | **EE** | Billing entegrasyonu |
| Rate limiter | **EE** | Per-key iş mantığı |

### Media

| Bileşen | Konum | Neden |
|---------|-------|-------|
| `MediaProvider` interface | Core | Contract |
| Variant preset definitions | Core | Config'ler generic |
| Media API routes | Core | Thin shell, limit check server-side |
| Agent tools (search/upload/get) | Core | Tool defs core'da |
| Asset Manager UI | Core | UI her zaman core'da |
| Sharp image processor | **EE** | Image processing iş mantığı |
| Variant generator | **EE** | Resize + format + quality |
| Blurhash calculator | **EE** | Loading placeholder |

### Webhooks

| Bileşen | Konum | Neden |
|---------|-------|-------|
| Webhook types + SSRF protection | Core (`server/utils/webhook-engine.ts`) | Güvenlik altyapısı |
| Webhook API routes | Core | Thin shells via `runEnterpriseRoute()` |
| Webhook CRUD + dispatch + retry | **EE** (`ee/enterprise/webhooks.ts` + `webhook-dispatch.ts`) | Ticari iş mantığı |

### Conversation API

| Bileşen | Konum | Neden |
|---------|-------|-------|
| API routes (/conversation/v1/) | Core | Thin shells |
| Key CRUD + message handling | **EE** (`ee/enterprise/conversation-*.ts`) | Ticari iş mantığı |

### AI Keys (BYOA)

| Bileşen | Konum | Neden |
|---------|-------|-------|
| API routes (/ai-keys/) | Core | Thin shells |
| Key CRUD + encryption | **EE** (`ee/enterprise/ai-keys.ts`) | Ticari iş mantığı |

---

## Feature Flag Mekanizması

```ts
// shared/utils/license.ts — single source of truth
export type StudioPlan = 'starter' | 'pro' | 'enterprise'

// Feature checks — most return true for ALL plans
hasFeature(plan, 'cdn.delivery')        // starter, pro, enterprise
hasFeature(plan, 'media.upload')        // starter, pro, enterprise
hasFeature(plan, 'api.webhooks_outbound') // starter, pro, enterprise

// Pro+ only features (limit-based differentiation isn't enough)
hasFeature(plan, 'cdn.preview_branch')  // pro, enterprise
hasFeature(plan, 'media.custom_variants') // pro, enterprise
hasFeature(plan, 'roles.specific_models') // pro, enterprise
hasFeature(plan, 'forms.spam_filter')   // pro, enterprise

// Enterprise-only
hasFeature(plan, 'sso.saml')           // enterprise
hasFeature(plan, 'sso.oidc')           // enterprise
hasFeature(plan, 'branding.white_label') // enterprise
hasFeature(plan, 'cdn.custom_domain')  // enterprise

// Limit checks — the real differentiator
getPlanLimit(plan, 'ai.messages_per_month')  // 50 / 500 / ∞
getPlanLimit(plan, 'cdn.bandwidth_gb')       // 2 / 20 / ∞
getPlanLimit(plan, 'media.storage_gb')       // 1 / 5 / 100
getPlanLimit(plan, 'team.members')           // 3 / 25 / ∞
```

---

## Plan Matrisi

| Özellik | Starter $9/mo | Pro $29/mo + $9/seat | Enterprise |
|---|---|---|---|
| **Tüm özellikler** | ✅ | ✅ | ✅ |
| Team | 3 kişi | 25 (+ $9/seat) | ∞ |
| AI (Studio key) | 50 msg/ay (Haiku) | 500 msg/ay (Sonnet) | ∞ (Custom) |
| BYOA | ✅ (sınırsız) | ✅ | ✅ |
| CDN | 2 GB, 3 key | 20 GB, 10 key | ∞ |
| CDN preview branch | — | ✅ | ✅ |
| CDN custom domain | — | — | ✅ |
| Media | 1 GB, 5 MB/file, 4 variant | 5 GB, 50 MB/file, 10 variant | 100 GB, 100 MB/file |
| Custom variants | — | ✅ | ✅ |
| Forms | 1 form, 100 sub/ay | 5 form, 1K sub/ay | ∞ |
| Spam filter | — | ✅ | ✅ |
| Workflow | Review ✅ | Review ✅ | ✅ |
| Roller | Owner, Editor, Reviewer, Viewer | + Model-specific access | ∞ |
| Conversation API | 1 key, 100 msg/ay | 5 key, 1K msg/ay | ∞ |
| Webhooks | 3 | 10 | ∞ |
| SSO | — | — | SAML + OIDC |
| White-label | — | — | ✅ |
| **Overage** | AI $0.03, CDN $0.10/GB, Media $0.25/GB, Forms $0.01, API $0.05 |||
| **Trial** | 14 gün | 14 gün | — |

---

## Graceful Degradation

| Senaryo | Davranış |
|---------|----------|
| EE dizini yok (self-hosted) | CDN/Media/Webhook/API routes → 403, core features çalışır |
| EE var, plan yetersiz (Pro+ feature) | hasFeature() → false, UI gated |
| Limit aşımı | getPlanLimit() → 403 + overage info |
| Rol normalizasyonu | specific_models: Pro+ yoksa false, roller her zaman korunur |

---

## Gelecek EE Implementasyonlar

| Bileşen | Konum | Plan | Durum |
|---------|-------|------|-------|
| SSO (SAML/OIDC) | `ee/sso/` | Enterprise | Planlandı |
| White-label | `ee/branding/` | Enterprise | Planlandı |
| Premium connectors (Canva, Figma, etc.) | `ee/connectors/` | Pro+ | Interface var, impl yok |
| CDN custom domain | `ee/cdn/` | Enterprise | Flag var, impl yok |
| Approval chains | `ee/workflow/` | Pro+ | Planlandı |
| Scheduled publish | `ee/workflow/` | Pro+ | Planlandı |
| Audit log / Activity feed | `ee/audit/` | Pro+ | Planlandı |

---

## Zaten EE-Ready Olan Altyapı

- [x] Database schema — tüm EE kolonları mevcut, RLS korumalı
- [x] Provider pattern — interface core'da, impl değiştirilebilir
- [x] Permissions system — role-based tool filtering
- [x] Branch workflow — engine agnostic, merge kararı call site'da
- [x] Content engine — partial update + merge, plan-agnostic
- [x] Agent usage tracking — source column (studio/byoa) ayrımı
- [x] Enterprise bridge — dynamic import, graceful degradation
- [x] Plan content models — plans + plan-features in Contentrain
- [x] Overage pricing — defined in plan-features content model
- [x] Trial support — trial_ends_at on workspace, not a separate plan
