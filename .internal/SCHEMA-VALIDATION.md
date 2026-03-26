# Schema Validation — Model Integrity & Breaking Change Detection

> Cross-cutting concern — tüm phase'leri etkiler
> Bağımlılık: @contentrain/types ✅, Content Engine ✅, Webhook handler ✅
> Tahmini süre: 1 hafta (core) + ongoing

---

## Problem

Geliştirici `.contentrain/models/*.json` dosyalarını doğrudan düzenleyip push edebilir. Studio bu değişikliği webhook ile alır ama **validasyon yapmaz**. Sorunlar:

1. **Geçersiz field type** — `"type": "stringg"` → agent ve UI kırılır
2. **Breaking schema change** — field silindi ama 500 entry'de hala var → veri kayıp görünümü
3. **Relation integrity** — referans edilen model silinmiş → orphan referanslar
4. **Kind değişikliği** — `collection` → `singleton` → tüm entry'ler geçersiz
5. **i18n toggle** — `false` → `true` → locale dosyaları yok
6. **Duplicate field ID** — aynı field iki kez tanımlanmış
7. **Form config orphan** — form enabled ama model field'ları değişmiş → form geçersiz

Mevcut P2.2 finding'inin genişletilmiş hali.

---

## Çözüm: İki Seviyeli Validasyon

### Seviye 1: Runtime Validation (Passive — Studio tarafı)

Webhook geldiğinde veya snapshot refresh'te çalışır:

```
GitHub push → webhook → snapshot refresh
  ↓
validateProjectSchema(models, content, config)
  ↓
Sorun varsa:
  → project.schema_warnings = [...] (DB)
  → project.status stays 'active' (kırılmaz)
  → Studio UI'da uyarı banner
  → Agent system prompt'a "Schema warnings" section
```

**Validasyon kuralları:**

| Kategori | Kural | Severity |
|----------|-------|----------|
| Model | ID unique across all models | ERROR |
| Model | ID matches filename (blog.json → id: "blog") | WARNING |
| Model | kind is valid enum value | ERROR |
| Model | domain exists in config.domains | WARNING |
| Field | type is valid FieldType enum | ERROR |
| Field | ID unique within model | ERROR |
| Field | relation target model exists | WARNING |
| Field | select type has options[] defined | WARNING |
| Content | Required fields present in entries | WARNING |
| Content | Field values match declared type | WARNING |
| Content | i18n model has locale files for all supported locales | WARNING |
| Content | Non-i18n model has data.json | WARNING |
| Schema | kind change detected (vs previous snapshot) | CRITICAL |
| Schema | Field removed (but entries contain data) | WARNING |
| Schema | Field type changed (entries may be incompatible) | WARNING |
| Schema | Required added (entries may be missing field) | WARNING |
| Form | form.exposedFields reference existing field IDs | ERROR |
| Form | form.captcha provider is supported | WARNING |

**Severity levels:**
- ERROR: Schema unusable, model skipped in UI
- CRITICAL: Breaking change, data integrity at risk
- WARNING: Potential issue, model still usable

### Seviye 2: CLI Validation (Proactive — Developer tarafı)

```bash
npx contentrain validate
```

Git pre-commit hook olarak çalışır. Push'tan önce tüm sorunları yakalar:

```bash
$ npx contentrain validate

✓ config.json valid
✓ 12 models validated

⚠ blog-posts: "author" field references model "authors" which does not exist
⚠ faq: field "category" type changed from "relation" to "string" — 45 entries may be affected
✗ hero-section: field "invalid_type" has unknown type "stringg"

2 warnings, 1 error
```

Error varsa pre-commit hook exit 1 → push engellenir.

Bu `@contentrain/cli` paketi veya `@contentrain/types` içine validation utility olarak eklenebilir.

---

## Breaking Change Detection

Webhook geldiğinde previous vs new model comparison:

```ts
interface SchemaChange {
  modelId: string
  type: 'field_removed' | 'field_type_changed' | 'field_required_added' |
        'kind_changed' | 'model_removed' | 'i18n_changed'
  field?: string
  previous?: string
  current?: string
  affectedEntries: number
  severity: 'critical' | 'warning'
}
```

Detection logic:

```
For each model in previousSnapshot:
  If model not in newSnapshot:
    → model_removed (WARNING)
    → count orphan content files

  If model.kind changed:
    → kind_changed (CRITICAL)
    → all entries potentially invalid

  If model.i18n changed:
    → i18n_changed (CRITICAL)
    → locale files missing or orphaned

  For each field in previousModel:
    If field not in newModel:
      → field_removed (WARNING)
      → count entries with this field populated

    If field.type changed:
      → field_type_changed (WARNING)
      → count entries that may be incompatible

  For each field in newModel:
    If field.required && field not in previousModel:
      → field_required_added (WARNING)
      → count entries missing this field
```

---

## Studio UI İntegrasyonu

### Schema Warning Banner

```
┌─────────────────────────────────────────────────┐
│ ⚠️ Schema changes detected (push 3 min ago)     │
│                                                  │
│ • blog-posts: "author" field removed — 500       │
│   entries still contain this field               │
│ • faq: "category" type changed relation→string   │
│   — 45 entries may have invalid references       │
│                                                  │
│ [Ask Agent to Fix]  [Review Changes]  [Dismiss]  │
└─────────────────────────────────────────────────┘
```

"Ask Agent to Fix" → Chat prompt:
```
"Fix schema warnings: migrate the author field data in blog-posts
and convert category relation references to strings in faq"
```

### Project Health Indicator

Sidebar'da project name yanında health dot:
- 🟢 Green: no warnings
- 🟡 Yellow: warnings present
- 🔴 Red: errors present (model unusable)

---

## Agent Araçları

```ts
{
  name: 'validate_schema',
  description: 'Validate all model schemas and detect issues. Returns warnings and errors.',
  inputSchema: { type: 'object', properties: {} },
}

{
  name: 'fix_schema_issue',
  description: 'Fix a specific schema issue by migrating content data.',
  inputSchema: {
    type: 'object',
    properties: {
      modelId: { type: 'string' },
      issue: { type: 'string', description: 'Issue type: field_removed, field_type_changed, etc.' },
      field: { type: 'string' },
      action: { type: 'string', description: 'migrate, remove, default_value' }
    }
  }
}
```

---

## Implementasyon Sırası

1. Schema validation utility (`server/utils/schema-validation.ts`)
   - Model validation rules
   - Field type enum check
   - Relation target resolution
   - Breaking change detection (diff-based)

2. Webhook integration
   - After snapshot refresh → run validation
   - Store warnings in project record or separate table
   - Include in agent system prompt

3. Studio UI
   - Warning banner component
   - Project health indicator in sidebar
   - "Ask Agent to Fix" integration

4. Agent tools
   - validate_schema tool
   - fix_schema_issue tool (content migration)

5. CLI validation (separate package — `@contentrain/cli`)
   - `npx contentrain validate`
   - Pre-commit hook setup guide
   - CI/CD integration docs

---

## DB Schema

```sql
-- Project schema warnings (denormalized for fast access)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  schema_warnings JSONB DEFAULT '[]';

-- schema_warnings format:
-- [
--   { "modelId": "blog", "type": "field_removed", "field": "author",
--     "severity": "warning", "affectedEntries": 500, "detectedAt": "..." },
--   ...
-- ]
```

---

## İlişkili Feature'lar

- **Forms**: form config field referansları validate edilmeli
- **CDN Builder**: geçersiz model'ler build'den exclude edilmeli (zaten silent skip)
- **Conversation API**: agent custom instructions model field'larına referans verebilir
- **Content REST API**: field type validation request'te de çalışmalı

---

## EE/Core Ayrışımı

| Katman | Konum | Neden |
|--------|-------|-------|
| Validation utility | Core | Temel schema integrity |
| Webhook integration | Core | Snapshot refresh'in parçası |
| Warning UI | Core | Tüm planlar görmeli |
| Agent tools | Core | hasFeature gerektirmez |
| CLI package | Core (ayrı npm) | Developer tool |
| AI-powered auto-fix | EE | Claude API maliyeti |
| Advanced migration tool | EE | Complex data transformations |
