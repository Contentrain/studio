# Contentrain Studio — Product Ideas & Roadmap

> **Tarih:** 2026-03-26 (revised)
> **Durum:** Validated against codebase + product strategy review

---

## Active Ideas

### 1. Webhook Outbound

**Neden:** Studio'yu event source yaparak Vercel/Netlify rebuild, Slack bildirim, Zapier/Make otomasyon zincirleri mümkün olur. Deploy hooks bu sistemin alt kümesi.

**Mevcut altyapı:**
- GitHub webhook ingress var (`server/api/webhooks/github.post.ts`)
- CDN build trigger zaten post-push hook olarak çalışıyor
- `hasFeature('api.webhooks_outbound')` feature flag tanımlı (Business+)

**Tetikleyici eventler:**
- `content.saved` — save_content tool sonrası
- `content.deleted` — delete_content tool sonrası
- `model.saved` — save_model tool sonrası
- `branch.merged` — merge_branch sonrası (→ deploy hook olarak da kullanılır)
- `branch.rejected` — reject_branch sonrası
- `cdn.build_complete` — CDN build tamamlandığında
- `media.uploaded` — media upload sonrası
- `form.submitted` — form submission geldiğinde

**Gereken:**
- DB: `webhooks` (project_id, url, events[], secret, active) + `webhook_deliveries` (status, retry_count)
- Event emission: content-engine write operations → emit event
- Async delivery: exponential backoff retry
- HMAC-SHA256 signature: `X-Contentrain-Signature` header
- API: CRUD endpoints + test webhook button
- UI: Project settings → Webhooks tab

**Efor:** 2 hafta | **Plan:** Business+ | **Öncelik:** HIGH

---

### 2. Project Health (Schema Validation + Health Dashboard)

**Neden:** Geliştirici model'i elle değiştirip push edebilir — Studio bunu validate etmiyor. Ayrıca "projemin durumu ne?" sorusuna tek bakışta cevap yok.

**İki bileşen, tek feature:**
- **Schema Validation** — breaking change detection, field type check, relation integrity
- **Health Dashboard** — freshness, coverage, validation status, build health

**Mevcut altyapı:**
- `useSnapshot()`: models, content, config, vocabulary — tümü mevcut
- `content-validation.ts`: 27 field type desteği
- CDN builds: status, timing, file count
- `@contentrain/types` FieldType enum

**Detaylı spec:** `.internal/SCHEMA-VALIDATION.md`

**Efor:** 2 hafta | **Plan:** Free (core) | **Öncelik:** HIGH

---

### 3. Multi-Repository Governance

**Neden:** Büyük ekiplerde 5-10 repo olabilir. Hepsinde aynı vocabulary, aynı brand terms, aynı tone olmalı.

**Zamanlama:** Enterprise müşteri satışı başladığında. Şu an erken.

**Gereken:**
- Workspace-level shared vocabulary (merge: workspace + project)
- Workspace-level governance rules (naming, locale policy, approval)
- Agent prompt: workspace governance rules injection

**Efor:** 2 hafta | **Plan:** Enterprise | **Öncelik:** LOW (ihtiyaç doğduğunda)

---

## Kapsanan / Silinen Fikirler

| Fikir | Neden silindi | Nerede kapsandı |
|-------|---------------|-----------------|
| Content Analytics | Actionable değil, ayrı dashboard gereksiz | Project Health dashboard'da basit metrikler yeterli |
| Content Quality Score | Schema validation olmadan anlamsız | Schema Validation üzerine doğal gelir |
| Agent Marketplace / Custom Rules | Over-engineering, kullanıcı tabanı yetersiz | Conversation API `custom_instructions` alanı aynı işi görüyor |
| Schema Registry / Versioning | Git zaten versiyon kontrolü | SCHEMA-VALIDATION.md breaking change detection |
| Notification System | In-app notification gereksiz | Webhook Outbound + email (Forms spec) yeterli |
| Deploy Hooks | Webhook Outbound'un alt kümesi | Webhook Outbound `branch.merged` event'i |

---

## Müşteri Değer Matrisi

| Feature | Free | Pro | Business | Enterprise | Gelir etkisi |
|---------|------|-----|----------|------------|-------------|
| Project Health | ✅ | ✅ | ✅ | ✅ | Retention |
| Forms & Submissions | ✅ (1 form) | ✅ (5 form) | ✅ (∞) | ✅ | Acquisition + Upsell |
| Conversation API | — | — | ✅ | ✅ | Lock-in + Direct |
| Content REST API | — | — | ✅ | ✅ | Direct |
| Webhook Outbound | — | — | ✅ | ✅ | Direct |
| Multi-Repo Governance | — | — | — | ✅ | Enterprise sales |
