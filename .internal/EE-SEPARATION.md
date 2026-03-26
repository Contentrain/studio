# Enterprise Edition (ee/) Separation Guide

> **Tarih:** 2026-03-23
> **Durum:** Temel yapı kuruldu — license.ts, ee/ dizini, feature flags aktif

---

## Özet

Proje mimari olarak **zaten EE-ready**. Database schema, RLS policies, permissions sistemi ve provider pattern sayesinde EE ayrışımı **konfigürasyon + UI** düzeyinde — mimari değişiklik gerektirmiyor.

---

## Ayrışım Kararları

### Taşınması Gereken (ee/ dizinine)

| # | Bileşen | Yaklaşım | Efor |
|---|---------|----------|------|
| 1 | Reviewer/Viewer rolleri | `agent-permissions.ts` → core interface + ee/ genişleme | Düşük |
| 2 | specificModels + allowedModels | #1 ile birlikte, aynı dosya | Düşük |
| 3 | BYOA API key yönetimi | `chat.post.ts`'de feature flag | Düşük |
| 4 | Settings UI rol seçenekleri | `settings.vue`'de plan-bazlı conditional render | Orta |

### Taşınmayacak — Zaten Doğru Yerde

| Bileşen | Neden Kalıyor |
|---------|---------------|
| `content-engine.ts` | Workflow-agnostic, branch oluşturur, merge kararı dışarıda |
| Branch API routes (list, diff, merge, reject) | Permissions zaten role-gated, merge/reject 403 döner |
| `useBranches.ts` | Pure data fetching, iş mantığı yok |
| `BranchDetailView.vue` | Pure UI, `canManage` prop ile zaten gated |
| Multi-locale logic | Plan-agnostic, config'den gelir |
| Database schema | Tüm kolonlar mevcut, RLS ile korunuyor |

### Neden Taşınmıyor — Detay

**content-engine.ts:** Engine her zaman branch oluşturur. Auto-merge vs review kararı `chat.post.ts`'deki `shouldAutoMerge()` fonksiyonunda yapılıyor. Engine'in kendisi workflow bilmez.

**Branch API routes:** `merge.post` ve `reject.post` zaten `resolveAgentPermissions` ile reviewer+ kontrolü yapıyor. Free tier'da kimse reviewer değil → 403. Code movement gerekmez.

**Multi-locale:** Locale bilgisi `.contentrain/config.json`'dan gelir, herhangi bir plan kısıtlaması yok. 5 locale sınırı gibi bir limit istenirse sadece UI'da gating yeterli.

---

## Dosya Yapısı

```
ee/
├── LICENSE                          ← Proprietary license text
├── README.md                        ← EE feature documentation
├── permissions/
│   └── advanced-roles.ts            ← Reviewer/Viewer + specificModels logic
├── cdn/
│   ├── cloudflare-cdn.ts            ← Cloudflare R2 CDNProvider impl (Pro+)
│   ├── aws-cdn.ts                   ← AWS S3 + CloudFront impl (future)
│   ├── cdn-usage.ts                 ← Usage metering, bandwidth tracking
│   ├── cdn-rate-limiter.ts          ← Per-plan rate limiting logic
│   └── cdn-advanced.ts              ← Custom domains, IP allowlist (Business+)
├── media/
│   ├── sharp-processor.ts           ← Sharp-based image processing (Pro+)
│   ├── variant-generator.ts         ← Variant generation (resize, format, quality)
│   ├── blurhash-calculator.ts       ← Blurhash loading placeholder
│   ├── media-optimizer.ts           ← Original optimization (EXIF strip, normalize)
│   ├── storage-usage.ts             ← Workspace storage metering + limits
│   └── duplicate-detector.ts        ← Content hash duplicate detection
├── connectors/
│   ├── canva.ts                     ← Canva Connect API (Pro+)
│   ├── figma.ts                     ← Figma REST API (Pro+)
│   ├── recraft.ts                   ← Recraft API (Pro+)
│   ├── google-drive.ts              ← Google Drive (Business+)
│   └── notion.ts                    ← Notion API (Business+)
├── ai/
│   └── studio-key.ts               ← Studio-hosted key logic + metering
├── workflow/
│   ├── approval-chains.ts          ← Multi-step approval (Business+)
│   └── scheduled-publish.ts        ← Scheduled content publishing
├── sso/
│   ├── saml.ts                     ← SAML 2.0 (Enterprise)
│   └── oidc.ts                     ← OpenID Connect (Enterprise)
└── branding/
    └── white-label.ts              ← Custom branding (Enterprise)
```

### CDN Core/EE Ayrışımı

CDN tamamen Pro+ feature. Core ve EE arasındaki sorumluluk dağılımı:

| Bileşen | Konum | Neden |
|---------|-------|-------|
| `CDNProvider` interface | Core (`server/providers/cdn.ts`) | Contract — tüm impl'ler bunu implement eder |
| `cdn-builder.ts` | Core (`server/utils/`) | GitProvider + content-paths (core) kullanır |
| CDN API routes | Core (`server/api/cdn/v1/`) | `hasFeature()` ile gated, free'de 403 |
| API key yönetimi | Core (`server/utils/cdn-keys.ts`) | Key gen/hash/validate — generic |
| DB schema | Core (`supabase/migrations/`) | Her zaman core'da |
| Cloudflare R2 impl | **EE** (`ee/cdn/cloudflare-cdn.ts`) | Ticari storage implementasyonu |
| Usage metering | **EE** (`ee/cdn/cdn-usage.ts`) | Billing ile entegre |
| Rate limiter | **EE** (`ee/cdn/cdn-rate-limiter.ts`) | Plan-specific business logic |
| Advanced config | **EE** (`ee/cdn/cdn-advanced.ts`) | Custom domain, IP allowlist (Business+) |

**Core çalışır, EE yoksa:** CDN routes `hasFeature()` ile 403 döner. Builder çalışmaz çünkü CDNProvider implementasyonu yok. Graceful degradation.

Implemented in Phase 3.

### Media Core/EE Ayrışımı

Media Management tamamen Pro+ feature. Aynı R2 altyapısını CDN ile paylaşır.

| Bileşen | Konum | Neden |
|---------|-------|-------|
| `MediaProvider` interface | Core (`server/providers/media.ts`) | Contract — upload, variant, metadata |
| Variant preset definitions | Core (`server/utils/media-variants.ts`) | Preset config'ler generic |
| Media API routes | Core (`server/api/.../media/`) | `hasFeature()` ile gated, free'de 403 |
| Agent tools (search/upload/get) | Core (`server/utils/agent-tools.ts`) | Tool defs core'da, plan check execution'da |
| Asset Manager UI | Core (`app/components/organisms/`) | UI her zaman core'da |
| DB schema (media_assets, media_usage) | Core (`supabase/migrations/`) | Her zaman core'da |
| Sharp image processor | **EE** (`ee/media/sharp-processor.ts`) | Image processing business logic |
| Variant generator | **EE** (`ee/media/variant-generator.ts`) | Resize + format + quality |
| Blurhash calculator | **EE** (`ee/media/blurhash-calculator.ts`) | Loading placeholder generation |
| Storage usage tracking | **EE** (`ee/media/storage-usage.ts`) | Billing entegrasyonu, plan limits |
| Duplicate detector | **EE** (`ee/media/duplicate-detector.ts`) | Content hash dedup |

**Core çalışır, EE yoksa:** Media routes `hasFeature()` ile 403 döner. Image field'lar sadece manual path input olarak çalışır (mevcut davranış). Asset Manager "Upgrade to Pro" gösterir.

Implemented in Phase 4.

---

## Feature Flag Mekanizması

```ts
// server/utils/license.ts (core — AGPL)
export type Plan = 'free' | 'pro' | 'business' | 'enterprise'

export function getWorkspacePlan(workspace: { plan?: string }): Plan {
  return (workspace.plan as Plan) ?? 'free'
}

export function hasFeature(plan: Plan, feature: string): boolean {
  const matrix: Record<string, Plan[]> = {
    // Roles
    'roles.reviewer': ['pro', 'business', 'enterprise'],
    'roles.viewer': ['pro', 'business', 'enterprise'],
    'roles.specific_models': ['pro', 'business', 'enterprise'],

    // AI
    'ai.byoa': ['pro', 'business', 'enterprise'],
    'ai.studio_key': ['pro', 'business', 'enterprise'],

    // Connectors
    'connector.canva': ['pro', 'business', 'enterprise'],
    'connector.figma': ['pro', 'business', 'enterprise'],
    'connector.recraft': ['pro', 'business', 'enterprise'],
    'connector.google_drive': ['business', 'enterprise'],
    'connector.notion': ['business', 'enterprise'],

    // Workflow
    'workflow.review': ['pro', 'business', 'enterprise'],
    'workflow.approval_chains': ['business', 'enterprise'],
    'workflow.scheduled_publish': ['business', 'enterprise'],

    // Team
    'team.audit_log': ['business', 'enterprise'],
    'team.activity_feed': ['business', 'enterprise'],

    // CDN
    'cdn.delivery': ['pro', 'business', 'enterprise'],
    'cdn.preview_branch': ['business', 'enterprise'],
    'cdn.custom_domain': ['enterprise'],
    'cdn.ip_allowlist': ['business', 'enterprise'],

    // Media
    'media.upload': ['pro', 'business', 'enterprise'],
    'media.library': ['pro', 'business', 'enterprise'],
    'media.connectors': ['pro', 'business', 'enterprise'],
    'media.custom_variants': ['business', 'enterprise'],

    // Enterprise
    'sso.saml': ['enterprise'],
    'sso.oidc': ['enterprise'],
    'branding.white_label': ['enterprise'],
    'api.webhooks_outbound': ['business', 'enterprise'],
    'api.rest': ['business', 'enterprise'],
  }
  return matrix[feature]?.includes(plan) ?? false
}

// Plan-specific numeric limits (CDN + Media)
export function getPlanLimit(plan: Plan, limit: string): number {
  const limits: Record<string, Record<Plan, number>> = {
    'cdn.api_keys': { free: 0, pro: 3, business: 10, enterprise: Infinity },
    'cdn.requests_per_month': { free: 0, pro: 100_000, business: 1_000_000, enterprise: Infinity },
    'cdn.bandwidth_gb': { free: 0, pro: 10, business: 100, enterprise: Infinity },
    'media.storage_gb': { free: 0, pro: 1, business: 5, enterprise: Infinity },
    'media.max_file_size_mb': { free: 0, pro: 10, business: 50, enterprise: 100 },
    'media.variants_per_field': { free: 0, pro: 4, business: 10, enterprise: Infinity },
  }
  return limits[limit]?.[plan] ?? 0
}
```

---

## Uygulama Noktaları

### 1. agent-permissions.ts — Rol Gating

```ts
// CORE: resolveAgentPermissions()
// Free tier: reviewer/viewer → fallback to editor (degraded)
// EE: full role mapping

const effectiveRole = projectRole ?? 'viewer'

// Feature check: does plan support advanced roles?
if (!hasFeature(plan, 'roles.reviewer') && effectiveRole === 'reviewer') {
  effectiveRole = 'editor' // Degrade gracefully
}
if (!hasFeature(plan, 'roles.viewer') && effectiveRole === 'viewer') {
  effectiveRole = 'editor' // Degrade gracefully
}
```

### 2. chat.post.ts — BYOA Gating

```ts
// Only check ai_keys table if plan supports BYOA
if (hasFeature(plan, 'ai.byoa')) {
  const { data: byoaKey } = await client.from('ai_keys')...
  if (byoaKey?.encrypted_key) {
    apiKey = decryptApiKey(...)
    usageSource = 'byoa'
  }
}
```

### 3. settings.vue — UI Conditional

```ts
const plan = activeWorkspace.value?.plan ?? 'free'
const showAdvancedRoles = hasFeature(plan, 'roles.reviewer')
const showSpecificModels = hasFeature(plan, 'roles.specific_models')
```

---

## Plan Matrisi

| Özellik | Free | Pro $29 | Business $99 | Enterprise |
|---|---|---|---|---|
| Workspace | 1 | 3 | Unlimited | Unlimited |
| Team | 2 kişi | 10 | 50 | Unlimited |
| Roller | Owner, Editor | + Reviewer, Viewer | + Custom | + SSO |
| Locale | Unlimited | Unlimited | Unlimited | Unlimited |
| AI Agent | Studio key | + BYOA | Unlimited | Custom model |
| **CDN** | **—** | **✓ (100K req, 10GB, 3 key)** | **✓ (1M req, 100GB, 10 key)** | **Custom** |
| CDN Advanced | — | — | + IP allowlist, preview branch | + Custom domain |
| **Media** | **—** | **✓ (1GB, 10MB/file, 4 variant)** | **✓ (5GB, 50MB/file, 10 variant)** | **Custom** |
| Media Advanced | — | — | + Custom variant config | + Unlimited |
| Connector | URL, File | + Canva, Figma, Recraft | + Notion, Drive | Custom SDK |
| Workflow | Auto-merge | + Review | + Approval chain | + Scheduled |
| Audit | — | — | Full log | + Export |
| API | — | — | Webhook | Full REST |
| SSO | — | — | — | SAML + OIDC |

---

## Zaten EE-Ready Olan Altyapı

- [x] Database schema — tüm EE kolonları mevcut, RLS korumalı
- [x] Provider pattern — interface core'da, impl değiştirilebilir
- [x] Permissions system — role-based tool filtering
- [x] Branch workflow — engine agnostic, merge kararı call site'da
- [x] Content engine — partial update + merge, plan-agnostic
- [x] UI gating — `canManage` prop pattern, conditional render
- [x] Agent usage tracking — source column (studio/byoa) ayrımı

---

## Implementasyon Sırası

1. **`server/utils/license.ts`** — Feature flag fonksiyonları (hasFeature + getPlanLimit)
2. **`ee/LICENSE`** — Proprietary license text
3. **`ee/permissions/advanced-roles.ts`** — Reviewer/Viewer + specificModels
4. **`agent-permissions.ts`** güncelle — plan check ekle
5. **`chat.post.ts`** güncelle — BYOA feature flag
6. **`settings.vue`** güncelle — conditional role UI
7. **CDN altyapısı** ✅ Implemented (Phase 3)
8. **Media altyapısı** ✅ Implemented (Phase 4)
9. **Connector interface** — `server/providers/connector.ts`
10. **İlk connector** — URL fetch (ücretsiz)
11. **Pro connectors** — Canva, Figma, Recraft (ee/connectors/)
