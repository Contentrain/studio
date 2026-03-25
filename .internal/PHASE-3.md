# Phase 3: CDN Content Delivery ✅ IMPLEMENTED

> Süre: ~2-3 hafta
> Gelir: Pro tier — ilk monetizasyon ($14/ay)
> Phase 2 tamamlandı. Phase 3 implementasyonu tamamlandı — test/polish aşamasında.
> Bağımlılık: Content Engine ✅, GitHub Webhook ✅, GitProvider read ✅, license.ts ✅

---

## Amaç

Git'teki `.contentrain/` içeriğini webhook-driven build pipeline ile CDN storage'a yayınla, API key ile güvenli şekilde sun. Mobile, desktop ve non-web uygulamaların Contentrain içeriklerini HTTP üzerinden tüketmesini sağla.

**Bir cümle:** Contentrain Studio'nun ilk gelir üreten katmanı — Pro plan kullanıcıları içeriklerini CDN üzerinden sunabilir.

---

## Hazır Altyapı (Phase 2'den)

| Bileşen | Durum | Dosya |
|---|---|---|
| `hasFeature('cdn.delivery')` | ✅ | `server/utils/license.ts` |
| `getPlanLimit('cdn.*')` | ✅ | `server/utils/license.ts` |
| `content_updated_at` column | ✅ | `supabase/migrations/004_content_updated_at.sql` |
| GitHub webhook handler | ✅ | `server/api/webhooks/github.post.ts` |
| Content Engine (Git read/write) | ✅ | `server/utils/content-engine.ts` |
| Content paths resolution | ✅ | `server/utils/content-paths.ts` |
| Meta filtering types | ✅ | `@contentrain/types` EntryMeta |
| Provider pattern | ✅ | `server/providers/*.ts` |
| EE directory structure | ✅ | `ee/README.md` |

---

## Mimari

```
Content Change → Git Push → GitHub Webhook → Build Pipeline → R2 Storage
                                                                   ↓
Mobile/Desktop App → CDN Edge → API Key Validation → JSON Response (<10ms)
```

### Build & Push Pattern (On-Demand Değil)
- Read latency <10ms (static file)
- Git rate limit yok (sadece build'de API çağrısı)
- Webhook-driven invalidation (~saniye)
- CDN edge cache + stale-while-revalidate

---

## Teknik Implementasyon Sırası

### Adım 1: Database + CDN Provider Interface

**Yeni:** `supabase/migrations/005_cdn.sql`
- `ALTER TABLE projects ADD COLUMN cdn_enabled, cdn_branch`
- `CREATE TABLE cdn_api_keys` (key_hash, key_prefix, name, environment, rate_limit, allowed_origins, expires_at, revoked_at)
- `CREATE TABLE cdn_builds` (project_id, trigger_type, commit_sha, status, file_count, total_size, duration, error)
- `CREATE TABLE cdn_usage` (project_id, api_key_id, period_start, request_count, bandwidth_bytes)
- RLS policies: workspace owner/admin can manage keys/builds, members can view builds
- Index: `idx_cdn_api_keys_hash` on key_hash WHERE revoked_at IS NULL

**Yeni:** `server/providers/cdn.ts` — CDNProvider interface
```ts
interface CDNProvider {
  putObject(projectId, path, data, contentType): Promise<CDNObject>
  getObject(projectId, path): Promise<{ data, contentType, etag } | null>
  deleteObject(projectId, path): Promise<void>
  deletePrefix(projectId, prefix): Promise<void>
  listObjects(projectId, prefix?): Promise<CDNObject[]>
  purgeCache(projectId, paths?): Promise<void>
  getStorageUrl(projectId, path): string
}
```

**Yeni:** `server/utils/cdn-keys.ts` — API key generation + validation
- Key format: `crn_live_{32-byte-base62}` (~50 char)
- Storage: SHA-256 hash + display prefix (ilk 16 char)
- Validation: hash lookup → revoked/expired check → return projectId

### Adım 2: Build Pipeline

**Yeni:** `server/utils/cdn-builder.ts`

Build akışı:
1. Webhook push → project lookup → plan check → cdn_enabled check
2. Changed paths → affected models tespit
3. `cdn_builds` tablosuna 'pending' kayıt
4. Her affected model için:
   - Git'ten content oku (GitProvider.readFile)
   - Meta filtrele (`status === 'published'`, publish_at/expire_at)
   - Serialize (canonical JSON)
   - Documents: frontmatter parse + markdown → HTML
5. `_manifest.json` oluştur (commit sha, timestamp, model list)
6. CDNProvider.putObject() ile upload (sadece değişen dosyalar)
7. CDNProvider.purgeCache()
8. `cdn_builds` → 'success' güncelle

**Selective build:** config.json değişti → full rebuild. Content/meta değişti → sadece o model.

### ⚠️ CRITICAL: Content Path Resolution

İçerik dosyaları 3 katmanlı path sistemiyle dağınık olabilir:

```
Katman 1: contentRoot (proje seviyesi)
  "" (kök) | "apps/web" (monorepo) | "packages/docs"

Katman 2: Standart PATH_PATTERNS (.contentrain/ altında)
  .contentrain/content/{domain}/{modelId}/{locale}.json

Katman 3: content_path override (model bazlı — .contentrain/ DIŞINDA!)
  model.content_path = "content/blog" → content/blog/{locale}.json
  model.content_path = "docs"         → docs/{slug}/{locale}.md
```

**Builder MUTLAKA `resolveContentPath()` kullanmalı:**
1. Tüm model tanımlarını oku (`models/*.json`)
2. Her model için `resolveContentPath(ctx, model, locale)` çağır — hardcoded path kullanma
3. `model.content_path` varsa dosya `.contentrain/` dışında olabilir
4. Document kind'da `content_path` override ile slug dizinleri tamamen farklı yerde olabilir

**Webhook changed paths analizi:**
- Sadece `.contentrain/` prefix'e bakma — content_path override olan modellerin path'lerini de kontrol et
- Builder başlatmadan önce tüm model tanımlarını oku, content_path'leri çıkar
- Changed path herhangi bir model'in content_path'iyle eşleşiyorsa o modeli rebuild et

**getAffectedModels() doğru implementasyon:**
```ts
function getAffectedModels(changedPaths: string[], models: ModelDefinition[], contentRoot: string): string[] {
  const affected = new Set<string>()
  const ctx = { contentRoot }

  for (const path of changedPaths) {
    // Config change → full rebuild
    if (path === resolveConfigPath(ctx)) return models.map(m => m.id)

    // Standard .contentrain/ paths
    for (const model of models) {
      // Model definition changed
      if (path === resolveModelPath(ctx, model.id)) {
        affected.add(model.id)
        continue
      }

      // Content path — resolves custom content_path if set
      for (const locale of supportedLocales) {
        const contentPath = resolveContentPath(ctx, model, locale)
        if (path.startsWith(contentPath.replace(/\/[^/]+$/, ''))) {
          affected.add(model.id)
          break
        }
      }
    }
  }
  return Array.from(affected)
}
```

**CDN output yapısı:**
```
{project-id}/
├── _manifest.json
├── models/_index.json
├── models/{modelId}.json
├── content/{modelId}/{locale}.json
├── documents/{modelId}/_index/{locale}.json
├── documents/{modelId}/{slug}/{locale}.json
└── meta/{modelId}/{locale}.json
```

### Adım 3: Cloudflare R2 Implementation (EE)

**Yeni:** `ee/cdn/cloudflare-cdn.ts` — CloudflareCDNProvider
- S3-compatible API (AWS SDK `@aws-sdk/client-s3`)
- Bucket: `contentrain-cdn`
- Path pattern: `{projectId}/{path}`
- Runtime config: `NUXT_CDN_R2_ACCOUNT_ID`, `NUXT_CDN_R2_ACCESS_KEY_ID`, `NUXT_CDN_R2_SECRET_ACCESS_KEY`, `NUXT_CDN_R2_BUCKET`

**Değiştir:** `server/utils/providers.ts` — `useCDNProvider()` factory eklenmesi

### Adım 4: Webhook Enhancement

**Değiştir:** `server/api/webhooks/github.post.ts`
- Push event'te: project lookup → cdn_enabled + plan check
- Changed paths'ten `.contentrain/` content change tespit
- Background'da CDN build trigger (`triggerCDNBuild()`)
- Build status tracking

### Adım 5: Public CDN API

**Yeni:** `server/api/cdn/v1/[projectId]/[...path].get.ts`
- API key validation (Bearer token → SHA-256 hash → DB lookup)
- CDNProvider.getObject() ile content serve
- ETag / If-None-Match → 304 Not Modified
- Cache-Control headers: `public, max-age=60, s-maxage=3600, stale-while-revalidate=86400`
- Rate limit headers (X-RateLimit-*)
- CORS handling

**Endpoints:**
| Path | Response |
|---|---|
| `/_manifest` | Build metadata |
| `/config` | Project config |
| `/models` | Model index |
| `/models/{modelId}` | Full model definition |
| `/content/{modelId}?locale=en` | Collection/Singleton/Dictionary |
| `/content/{modelId}/{entryId}?locale=en` | Single entry |
| `/documents/{modelId}?locale=en` | Document index |
| `/documents/{modelId}/{slug}?locale=en` | Document with body + html |
| `/meta/{modelId}?locale=en` | Entry metadata |

### Adım 6: Key Management + Build Management API

**Yeni routes:**
```
server/api/workspaces/[workspaceId]/projects/[projectId]/cdn/
├── keys/
│   ├── index.get.ts        # List API keys (hash hidden, prefix shown)
│   ├── index.post.ts       # Create key → return full key ONCE
│   └── [keyId].delete.ts   # Revoke key (set revoked_at)
├── builds/
│   ├── index.get.ts        # List recent builds (status, duration, errors)
│   └── trigger.post.ts     # Manual rebuild
└── settings.patch.ts       # Toggle cdn_enabled, set cdn_branch
```

### Adım 7: Studio UI

**Değiştir:** Settings page veya Project Settings
- CDN toggle (enable/disable)
- CDN branch selector (default branch vs custom)
- API key management (create, list, revoke)
- Build history (status, timestamp, file count, errors)
- Manual rebuild button
- SDK code snippets (TypeScript, Flutter, Swift, Kotlin)

### Adım 8: Usage Tracking (EE)

**Yeni:** `ee/cdn/cdn-usage.ts` — Request counting + bandwidth tracking
**Yeni:** `ee/cdn/cdn-rate-limiter.ts` — Per-key rate limiting

---

## Auth Middleware Skip

`server/middleware/auth.ts` → PUBLIC_PATHS'e `/api/cdn/` ekle (CDN API kendi key auth'unu kullanır)

---

## EE/Core Ayrışımı

| Katman | Konum | Neden |
|---|---|---|
| CDNProvider interface | `server/providers/cdn.ts` (Core) | Contract tanımı |
| cdn-builder.ts | `server/utils/cdn-builder.ts` (Core) | GitProvider + content-paths kullanır |
| CDN API routes | `server/api/cdn/` (Core) | hasFeature() ile gated |
| Key management | `server/utils/cdn-keys.ts` (Core) | Hash + validate logic |
| DB schema | `supabase/migrations/` (Core) | Her zaman core |
| CloudflareCDNProvider | `ee/cdn/cloudflare-cdn.ts` (EE) | Storage vendor |
| Usage metering | `ee/cdn/cdn-usage.ts` (EE) | Billing entegrasyon |
| Rate limiter | `ee/cdn/cdn-rate-limiter.ts` (EE) | Plan-specific logic |
| Custom domain | `ee/cdn/cdn-advanced.ts` (EE) | Business+ |

---

## Plan Limitleri

| | Free | Pro ($14/mo) | Business ($99/mo) | Enterprise |
|---|---|---|---|---|
| CDN Access | ❌ | ✅ | ✅ | ✅ |
| API Keys | 0 | 3 | 10 | ∞ |
| Requests/ay | 0 | 100K | 1M | Custom |
| Bandwidth/ay | 0 | 10GB | 100GB | Custom |
| Environments | — | production | + preview | Custom |
| Manual rebuild | — | ✅ | ✅ | ✅ |
| Allowed origins | — | — | ✅ | ✅ |
| Custom domain | — | — | — | ✅ |

---

## Güvenlik Checklist

- [x] API key SHA-256 hash (plaintext DB'de yok)
- [x] Key sadece oluşturulduğunda bir kez gösterilir
- [x] Revoked key anında devre dışı (revoked_at check)
- [x] Expired key otomatik reject (expires_at check)
- [x] Rate limiting per-key (ee/cdn/cdn-rate-limiter.ts)
- [ ] Draft/review içerik CDN'de yok → Phase 6'ya ertelendi (publish workflow olmadan anlamsız)
- [x] publish_at/expire_at korunur (time-based filter aktif)
- [x] Webhook HMAC-SHA256 doğrulaması
- [x] API key project scope'lu (key_hash → project_id lookup)
- [ ] Plan downgrade → CDN otomatik disable → Phase 10 (Billing)

---

## Validation Kriterleri

Phase 3 tamamlandığında:

1. [x] Pro plan workspace'de CDN enable edilebilir
2. [x] API key oluşturulabilir, listelenebilir, revoke edilebilir
3. [x] Git push sonrası CDN otomatik rebuild (webhook)
4. [x] Manual rebuild Studio UI'dan tetiklenebilir (SSE progress ile)
5. [x] Collection, Singleton, Dictionary content CDN'den okunabilir
6. [x] Document (markdown) content parsed HTML ile CDN'den okunabilir
7. [x] Multi-locale content doğru locale ile sunulur
8. [ ] Draft content CDN'de görünmez → Phase 6 (scheduled publishing)
9. [x] API key olmadan CDN'e erişilemez (401)
10. [x] Free plan'da CDN endpoint'leri 403 döner
11. [x] ETag ile conditional request çalışır (304)
12. [x] Build status Studio UI'dan takip edilebilir (SSE progress bar)

---

## SDK CDN Mode

`@contentrain/query` SDK'ya CDN HTTP transport eklenmesi gerekiyor.
Detaylı spec: `.internal/SDK-CDN-UPGRADE.md`

Özet:
- `createContentrain({ projectId, apiKey, baseUrl })` factory
- Async API: `await client.collection('faq').locale('en').all()`
- ETag caching, error handling, relation resolution
- Backward compat: mevcut sync local mode kırılmaz

---

## Kritik Dosyalar

| Dosya | İşlem | Adım |
|---|---|---|
| `supabase/migrations/005_cdn.sql` | YENİ | 1 |
| `server/providers/cdn.ts` | YENİ | 1 |
| `server/utils/cdn-keys.ts` | YENİ | 1 |
| `server/utils/cdn-builder.ts` | YENİ | 2 |
| `ee/cdn/cloudflare-cdn.ts` | YENİ | 3 |
| `server/utils/providers.ts` | DEĞİŞTİR | 3 |
| `server/api/webhooks/github.post.ts` | DEĞİŞTİR | 4 |
| `server/api/cdn/v1/[projectId]/[...path].get.ts` | YENİ | 5 |
| `server/api/.../cdn/keys/*.ts` | YENİ | 6 |
| `server/api/.../cdn/builds/*.ts` | YENİ | 6 |
| `server/api/.../cdn/settings.patch.ts` | YENİ | 6 |
| `server/middleware/auth.ts` | DEĞİŞTİR | 5 |
| `nuxt.config.ts` | DEĞİŞTİR | 3 |
| `ee/cdn/cdn-usage.ts` | YENİ | 8 |
| `ee/cdn/cdn-rate-limiter.ts` | YENİ | 8 |

---

## Sonraki Phase'ler (Yol Haritası)

| Phase | Kapsam | Süre |
|---|---|---|
| **4** | Media Management (upload, processing, Asset Manager) | 2-3 hafta |
| **5** | Connectors + Integrations (Canva, Figma, Recraft, Webhooks outbound) | 2 hafta |
| **6** | Advanced Content Ops (scheduling, versioning, translation memory, analytics) | 2-3 hafta |
| **7** | Team & Audit (activity log, audit trail, approval chains) | 1-2 hafta |
| **8** | Multi-Provider (GitLab, Bitbucket) | 2 hafta |
| **9** | Enterprise (SSO SAML/OIDC, white-label, REST API) | 2 hafta |
| **10** | Billing + Stripe (payment, plan upgrade/downgrade, seat pricing) | 2 hafta |

---

## Teknoloji Kararları

| Karar | Seçim | Neden |
|---|---|---|
| CDN Pattern | Build & Push | <10ms read, Git rate limit yok |
| Storage | Cloudflare R2 (EE) | Sıfır egress, S3-compat |
| API Auth | Bearer token (API key) | Basit, stateless |
| Key Storage | SHA-256 hash | Plaintext DB'de yok |
| Build Trigger | Webhook + Manual | Otomatik + gerektiğinde manual |
| Content Filter | Meta-based | status, publish_at, expire_at |
| Document Parse | Her zaman body + html | Gate'lenmez, tüm platformlar kullanır |
| Preview Branch | Phase 3'te yok | Business+ olarak sonraki fazda |
| SDK | Mevcut @contentrain/sdk'ya CDN mode | Ayrı paket gereksiz |

---

## Bilinçli Erteleme Kararları (Review 2026-03-24)

Review'daki 27 bulgunun 25'i çözüldü. Kalan açık maddeler:

| # | Bulgu | Durum | Not |
|---|---|---|---|
| P1.5 | CDN draft content filtreleme | ✅ Çözüldü | `shouldIncludeEntry()` + publish workflow (`4fb88d9`) |
| P1.7 | Workspace owner/admin tüm projeleri görür | ✅ By design | Spec'e uygun |
| P1.9 | GitHub setup primary workspace | ✅ By design | Kullanıcının kendi workspace'i |
| P2.1 | Chat history sıralaması | ✅ By design | Son N mesaj pattern'i |
| P2.11 | Secret validation fail-closed | ✅ Çözüldü | Nitro plugin (`b793365`) |
| P2.13 | SSR route protection | ✅ Çözüldü | `ssr: false` ile ortadan kalktı |
| P2.14 | Stale project context | ✅ Çözüldü | `watch([projectId, slug])` (`11d85f7`) |
| P2.15 | Mobile shell | Açık | Phase 4 — hamburger + slide-over |
| P3.1 | Provider boundary | Açık | Phase 8 — ikinci provider geldiğinde |
| P3.3 | Hardcoded strings | Açık | Sürekli cleanup |
