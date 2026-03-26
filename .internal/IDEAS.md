# Contentrain Studio — Product Ideas & Roadmap

> **Tarih:** 2026-03-24
> **Durum:** Validated against codebase — feasibility confirmed

Contentrain is **AI-native content governance infrastructure**, not a traditional headless CMS.
The ecosystem: MCP (execution) + Skills (procedures) + Rules (policy) + Query SDK (consumption) + Studio (governance UI).

---

## 1. Webhook Outbound

**Neden:** Studio'yu event source yaparak Vercel/Netlify rebuild, Slack bildirim, Zapier/Make otomasyon zincirleri mümkün olur.

**Mevcut altyapı:**
- GitHub webhook ingress var (`server/api/webhooks/github.post.ts`) — HMAC-SHA256 doğrulama
- CDN build trigger zaten post-push hook olarak çalışıyor
- `hasFeature('api.webhooks_outbound')` feature flag tanımlı (Business+)
- WriteResult shape yeterli webhook payload için: branch, commit, diff, validation

**Tetikleyici eventler:**
- `content.saved` — save_content tool sonrası
- `content.deleted` — delete_content tool sonrası
- `model.saved` — save_model tool sonrası
- `branch.merged` — merge_branch sonrası
- `branch.rejected` — reject_branch sonrası
- `cdn.build_complete` — CDN build tamamlandığında

**Gereken:**
- DB: `webhooks` (project_id, url, events[], secret, active) + `webhook_deliveries` (status, retry_count)
- Event emission: content-engine write operations → emit event
- Async delivery: exponential backoff retry (Bull/BullMQ veya simple queue)
- HMAC-SHA256 signature: `X-Contentrain-Signature` header
- API: CRUD endpoints + test webhook button
- UI: Project settings → Webhooks tab

**Efor:** 2-3 hafta | **Plan:** Business+ | **Öncelik:** HIGH

---

## 2. Content Analytics

**Neden:** "Ne kadar içerik ürettik? Kim en aktif? Hangi model en çok değişiyor?" sorularına cevap — ROI görünürlüğü.

**Mevcut altyapı:**
- `agent_usage` tablosu: aylık message_count, input/output tokens, source (studio/byoa)
- `messages` tablosu: her chat turunu + tool_calls JSON olarak saklıyor
- `context.json`: lastOperation + stats (models, entries, locales)
- `cdn_usage`: günlük request_count, bandwidth_bytes per API key
- `cdn_builds`: status, duration_ms, file_count, total_size_bytes

**Mevcut veriden çıkarılabilecek metrikler:**
- Kullanıcı bazlı mesaj/operasyon sayısı (messages tablosundan)
- Tool kullanım frekansı (messages.tool_calls filtreleme)
- Model bazlı content operasyonları (save/delete tool çağrıları)
- CDN build success rate + ortalama süre
- Bandwidth kullanım trendi

**Gereken:**
- DB: `content_audit_log` (project_id, user_id, action, model, locale, entry, diff, timestamp)
- API: analytics query endpoints (usage timeline, model stats, health)
- UI: Dashboard component (chart library — basit SVG veya lightweight chart)
- Background: Aylık aggregation job

**Easy win:** Mevcut context.json + messages tablosundan read-only dashboard — yeni tablo yazmadan.

**Efor:** 2 hafta | **Plan:** Pro+ | **Öncelik:** MEDIUM

---

## 3. Content Quality Score

**Neden:** Validation binary (pass/fail) — ama içerik kalitesi spektrum. SEO score, completeness, freshness gibi metrikler kullanıcıya aksiyon veriyor.

**Mevcut altyapı:**
- `content-validation.ts`: 27 field type desteği, required/unique/min/max/pattern/relation integrity
- ValidationResult: error + warning severity levels
- Meta dosyaları: status (draft/published), source (agent/human), updated_by
- @contentrain/rules paketi: content-quality, seo-rules, i18n-quality, accessibility kuralları

**Scoring modeli:**
```
Base: 100
- Required field eksik: -10 (critical)
- Validation warning: -5
- Opsiyonel field boş (description var): -2
- Kırık relation: -15
- SEO eksikleri (title <10 veya >70 char, slug eksik, description eksik): -8
- Stale content (90+ gün güncellenmemiş): -5

Tier: 90+ Excellent, 75-89 Good, 50-74 Fair, <50 Poor
```

**Gereken:**
- `server/utils/content-quality.ts` — scoring fonksiyonu (mevcut validation üzerine)
- Snapshot API'ye `quality_scores` ekleme (on-demand computed)
- UI: Entry listesinde 🟢🟡🔴 badge, model bazlı ortalama score

**DB değişikliği gerektirmez** — scoring mevcut model + content'ten computed.

**Efor:** 1 hafta | **Plan:** Free (core) | **Öncelik:** MEDIUM

---

## 4. Agent Marketplace / Custom Rules

**Neden:** Farklı sektörlerin farklı content governance ihtiyaçları var. E-commerce, SaaS, media, legal — her birinin özel kuralları olmalı.

**Mevcut altyapı:**
- `buildSystemPrompt()`: 10 bölümlü, genişletilebilir yapı
- `STUDIO_TOOLS`: 15 tool, `requiredPhase` + `workflowBehavior` metadata
- `filterToolsByPermissions()`: role-based tool filtering
- `classifyIntent()`: 5 kategori intent sınıflandırma
- Vocabulary sistemi: workspace-level terminoloji

**Uzantı noktaları:**
- `buildRulesSection()` → custom rules injection
- `STUDIO_TOOLS` → runtime tool extension
- `ChatUIContext` → custom context data

**Gereken:**
- DB: `workspace_agent_config` (rules JSON, enabled_tools, updated_at)
- DB: `agent_rule_templates` (marketplace — name, description, rule_template, usage_count)
- Rule injection: buildRulesSection'a matching rules append
- UI: Workspace settings → Agent Rules tab + template browser

**Konservatif MVP:** Workspace-level prompt injection (custom rules text alanı, full rule engine değil)

**Efor:** 3-4 hafta | **Plan:** Business+ | **Öncelik:** MEDIUM

---

## 5. Multi-Repository Governance

**Neden:** Büyük ekiplerde 5-10 repo olabilir. Hepsinde aynı vocabulary, aynı brand terms, aynı tone olmalı.

**Mevcut altyapı:**
- Workspace 1:N Project ilişkisi
- Vocabulary per-project (`.contentrain/vocabulary.json`)
- Workspace-level permissions (owner/admin tüm projelere erişir)
- Plan-based feature gating workspace düzeyinde

**Gereken:**
- DB: `workspace_vocabulary` (workspace-level shared terms)
- DB: `workspace_governance` (naming conventions, locale policy, approval rules)
- Merge logic: workspace vocab + project vocab (project overrides)
- Agent prompt: workspace governance rules injection
- UI: Workspace settings → Governance tab

**Efor:** 2 hafta | **Plan:** Enterprise | **Öncelik:** LOW

---

## 6. Schema Registry / Versioning

**Neden:** Model field'ları rename/delete/type change olduğunda mevcut content bozulabilir. Migration sistemi lazım.

**Mevcut altyapı:**
- Model tanımları Git'te versiyonlanıyor (implicit — commit history)
- content-engine save_model ile model update yapabiliyor
- Validation mevcut schema'ya göre çalışıyor

**Gereken:**
- Model metadata: `version` field + `migrations[]` array
- Migration runner: read time'da eski content'e transformation uygula
- Breaking change detection: eski → yeni schema diff analizi
- UI: Model history viewer + migration wizard

**Konservatif MVP:** Schema diff only (migration engine olmadan) — `git log` model dosyası için commit history + diff gösterimi.

**Efor:** 3 hafta | **Plan:** Business+ | **Öncelik:** LOW

---

## 7. Notification System

**Neden:** Branch pending ama kimse bilmiyor. Content reject edildi ama creator habersiz. Collaboration = communication.

**Mevcut altyapı:**
- User sessions (auth)
- Workspace/project members tabloları
- Message history (chat audit trail)
- Toast sistemi (client-side only)

**Gereken:**
- DB: `notifications` (user_id, type, data JSON, read_at, created_at)
- DB: `notification_preferences` (user_id, type, channel)
- Trigger'lar: branch created → notify reviewers, merge failed → notify user
- UI: Bell icon (header) + dropdown panel + unread count
- Opsiyonel: Email (Nodemailer + SES/Mailgun)

**MVP:** In-app notification only (email sonra).

**Efor:** 2 hafta | **Plan:** Pro+ | **Öncelik:** LOW

---

## 8. Platform Deploy Hooks

**Neden:** Content merge oldu → Vercel/Netlify/Cloudflare Pages rebuild etmeli. Basit webhook URL yeterli.

**Mevcut altyapı:**
- GitHub webhook receiver (HMAC-SHA256 doğrulama, push event → CDN build trigger)
- MergeResult: merged commit SHA döndürüyor
- CDN build zaten post-push hook olarak implement edilmiş

**Gereken:**
- DB: `project_deploy_hooks` (project_id, url, events[], active, secret)
- mergeBranch() sonrası: hook URL'lere POST
- Payload: `{ event, branch, commit_sha, repository, timestamp, signature }`
- UI: Project settings → Deploy hooks (create/test/delete)

**CDN build trigger'ı zaten bu pattern'ı kullanıyor** — genelleştirmek yeterli.

**Efor:** 1 hafta | **Plan:** Business+ | **Öncelik:** HIGH

---

## 9. Content Health Dashboard

**Neden:** "Projemin içerik durumu ne?" sorusuna tek bakışta cevap. Freshness, coverage, validation, build status.

**Mevcut altyapı:**
- `useSnapshot()`: models, content, config, vocabulary, contentContext — tümü mevcut
- `context.json` stats: models, entries, locales, lastSync
- Validation sistemi: error/warning severity
- CDN builds: status, timing, file count

**Metrikler (mevcut veriden computed):**
- Content freshness: lastSync timestamp → stale threshold (30/90 gün)
- Schema health: model count vs content-bearing model count
- Locale coverage: config locales vs actual content locales (parity check)
- Validation status: error/warning aggregation per model
- CDN health: build success rate + latest build timestamp

**Gereken:**
- `server/utils/health-metrics.ts` veya client-side computed
- UI: `ContentHealthDashboard.vue` — card grid (🟢🟡🔴 indicators)
- Project overview'da widget olarak göster

**DB değişikliği gerektirmez** — tüm veri snapshot'ta mevcut.

**Efor:** 1 hafta | **Plan:** Free (core) | **Öncelik:** HIGH

---

## Implementasyon Sırası (Önerilen)

### Hemen (Sonraki Sprint)
1. **Content Health Dashboard** — 1 hafta, FREE, tüm veri mevcut
2. **Content Quality Score** — 1 hafta, FREE, validation üzerine

### Kısa Vade (Ay 1-2)
3. **Deploy Hooks** — 1 hafta, Business+, CDN pattern'ını genişlet
4. **Webhook Outbound** — 2-3 hafta, Business+, event system + delivery queue

### Orta Vade (Ay 2-4)
5. **Content Analytics** — 2 hafta, Pro+, mevcut data + dashboard
6. **Notification System** — 2 hafta, Pro+, in-app MVP
7. **Multi-Repo Governance** — 2 hafta, Enterprise, workspace-level policies

### Uzun Vade (Ay 4+)
8. **Agent Marketplace** — 3-4 hafta, Business+, rule engine + templates
9. **Schema Versioning** — 3 hafta, Business+, migration system

---

## ee/ Dizin Yapısı (Planlandı)

```
ee/
├── analytics/
│   ├── audit-log.ts              ← Content change audit trail
│   ├── metrics.ts                ← Computed analytics metrics
│   └── dashboard-data.ts         ← Analytics API responses
├── integrations/
│   ├── webhooks.ts               ← Outbound webhook delivery
│   ├── deploy-hooks.ts           ← Platform rebuild triggers
│   ├── slack.ts                  ← Slack notifications
│   └── discord.ts                ← Discord notifications
├── quality/
│   ├── scoring.ts                ← Content quality scoring algorithm
│   └── rules-engine.ts           ← Custom quality rules
├── agents/
│   ├── rule-engine.ts            ← Custom agent rule injection
│   └── templates/                ← Pre-built rule packs
│       ├── ecommerce.json
│       ├── saas.json
│       └── media.json
├── governance/
│   ├── workspace-vocabulary.ts   ← Cross-repo terminology sync
│   ├── naming-conventions.ts     ← Schema naming enforcement
│   └── locale-policy.ts          ← Locale parity enforcement
├── schema/
│   ├── versioning.ts             ← Model version tracking
│   ├── migration-runner.ts       ← Schema migration execution
│   └── diff.ts                   ← Schema comparison
├── notifications/
│   ├── service.ts                ← Notification delivery
│   ├── email.ts                  ← Email templates + sending
│   └── preferences.ts            ← User notification settings
├── cdn/                          ← (Phase 3 — implemented)
├── connectors/                   ← (Phase 3+ — planned)
├── permissions/                  ← (Phase 2 — gating active)
├── ai/                           ← (Phase 2 — BYOA gating active)
└── workflow/                     ← (Phase 4 — planned)
```

---

## Müşteri Değer Matrisi

| Idea | Free | Pro | Business | Enterprise | Monetization |
|---|---|---|---|---|---|
| Health Dashboard | ✓ | ✓ | ✓ | ✓ | Retention |
| Quality Score | ✓ | ✓ | ✓ | ✓ | Retention |
| Content Analytics | — | ✓ | ✓ | ✓ | Direct |
| Notifications | — | ✓ | ✓ | ✓ | Indirect |
| Deploy Hooks | — | — | ✓ | ✓ | Direct |
| Webhook Outbound | — | — | ✓ | ✓ | Direct |
| Agent Rules | — | — | ✓ | ✓ | Direct |
| Multi-Repo Gov. | — | — | — | ✓ | Direct |
| Schema Registry | — | — | ✓ | ✓ | Indirect |
