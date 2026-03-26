# Content Intelligence — Client-Side Content Brain for Studio

> **Tarih:** 2026-03-26 (revised v3)
> **Durum:** Research complete, architecture designed
> **Bağımlılık:** Content Engine ✅, CDN ✅, Snapshot system ✅
> **Plan konumlaması:** Tüm planlarda bedava (sunucu maliyeti sıfır, tüm compute browser'da)
> **Teknoloji:** IndexedDB + FlexSearch + Web Worker (SQLite WASM değil — aşağıda gerekçe)

---

## Sorun

Studio'da 6 ayrı katman content'e erişiyor — hepsi birbirinden habersiz:

```
CLIENT:
  1. useSnapshot      → IndexedDB cache (5dk TTL) → /api/snapshot → Git API
  2. useModelContent   → Memory + IndexedDB cache (5dk TTL) → /api/content/[model] → Git API

SERVER:
  3. snapshot.get      → Git API (cache yok, ~4+3N+NL call per request)
  4. content/[model].get → Git API (cache yok, ~3-5 call per request)
  5. chat.post         → Git API (HER mesajda system prompt için ~4+3N call)
  6. cdn-builder       → Git API (her build'de tüm content)

Sorunlar:
  - Model tanımları 4+ kez ayrı ayrı okunuyor
  - Server-side cache SIFIR
  - Agent HER mesajda system prompt için Git API okur
  - Client cache invalidation gap — agent content değiştirdiğinde UI stale kalabilir
  - 2 ayrı client cache (snapshot IDB + modelContent IDB) ayrı invalidation
```

---

## Rakipler Neden Bunu Yapamaz

**Gerçek moat rate limit değil, mimari fark:**

```
API-native CMS (Contentful, Sanity, Strapi):
  İçerik → Database (multi-tenant) → API → Browser
  • Tüm content'i client'a transfer = database export + serialize + bandwidth
  • Client-side indexleme altyapıları yok
  • Her müşteri transfer = sunucu maliyeti
  • Mimarileri değiştirmek = yıllar süren yeniden yazım

Git-native CMS (Contentrain):
  İçerik → .json/.md dosyaları → Git repo → Browser
  • Zaten portable format (JSON/Markdown files)
  • Git Tree API ile delta sync (sadece değişenler, tek call)
  • Client'ta indexlendiğinde TÜM sorguları local çalıştırabilir
  • Sunucu maliyeti sıfır (browser compute)
```

Sanity Content Agent (en yakın rakip) GROQ batch sorguları çalıştırıyor ama:
- Her sorgu API'ye gidiyor (200-500ms latency)
- LLM context window limiti — tüm content'i aynı anda yükleyemiyor
- Kullanıcının browser'ında çalışmıyor — sunucu-side

---

## Neden IndexedDB, SQLite WASM Değil

Content Brain'in sorguları SQL-seviyesi complexity gerektirmiyor:

| Sorgu | IndexedDB ile | SQLite ile | Fark |
|-------|--------------|-----------|------|
| Model'e göre entry listele | Index on model_id → getAll | SELECT WHERE model_id= | Aynı hız |
| Field değerine göre filtre | Compound index → key range | SELECT WHERE field= | Aynı hız |
| Keyword arama | FlexSearch library (6KB) | FTS5 virtual table | FlexSearch yeterli |
| Aggregate (count, group) | getAll → JS reduce | GROUP BY | JS reduce yeterli |

**IndexedDB avantajları:**
- Zaten kullanıyoruz (idb-keyval) — ek dependency yok
- Universal browser support, sıfır WASM binary
- Structured clone = JSON nesneleri doğrudan saklanır
- Compound index + getAllRecords() (Chrome 141+) hızlı
- OPFS/COOP/COEP header gerektirmez

**SQLite dezavantajları:**
- wa-sqlite: ~300KB WASM binary download
- OPFS sync handle: Dedicated Worker zorunlu
- COOP/COEP header gerekebilir
- Ek dependency, ek karmaşıklık
- Over-engineering — Brain sorguları basit

**Karar:** İhtiyaç doğarsa (5000+ entry, complex JOIN'ler) SQLite'a migrate edilir. Başlangıçta IndexedDB + FlexSearch yeterli.

---

## Contentrain Dosya Yapısı — Brain Ne İndexler

### .contentrain/ Yapısı

```
.contentrain/
├── config.json                                    # Proje config (stack, locales, domains, workflow)
├── context.json                                   # Last operation + stats
├── vocabulary.json                                # Shared terminology
├── models/
│   ├── blog-posts.json                           # Model definition (fields, kind, domain, i18n)
│   ├── faq.json
│   └── hero-section.json
├── content/
│   └── {domain}/
│       ├── {modelId}/
│       │   ├── en.json                           # i18n: true → locale file (collection/singleton/dictionary)
│       │   ├── tr.json
│       │   └── data.json                         # i18n: false → data.json
│       └── {slug}/                               # Document kind
│           ├── en.md                             # i18n: true → locale markdown
│           └── tr.md
└── meta/
    └── {modelId}/
        ├── en.json                               # Entry metadata (status, source, updated_by)
        ├── tr.json
        └── {slug}/                               # Document meta (per-slug)
            └── en.json
```

### content_path Override

Model tanımında `content_path` varsa dosyalar `.contentrain/` **dışında** yaşar:

```json
{
  "id": "docs",
  "kind": "document",
  "content_path": "content/docs",
  "i18n": true
}
→ Dosya: content/docs/{slug}/{locale}.md (NOT .contentrain/content/...)
```

Brain sync'i bu override'ları da kapsamalı — `resolveContentPath()` kullanmalı.

### Content Formatları (Brain'in parse etmesi gereken)

**Collection/Singleton/Dictionary (JSON):**
```json
{
  "entry-id-1": { "title": "Hello", "body": "...", "tags": ["a", "b"] },
  "entry-id-2": { "title": "World", "body": "..." }
}
```

**Document (Markdown with frontmatter):**
```markdown
---
title: Getting Started
author: ahmet
category: tutorial
---

# Getting Started

Content body here...
```

Brain document kind'ı indexlerken:
- Frontmatter → structured fields olarak parse
- Body → full-text search index'ine
- **gray-matter parse gerekli** (server-side yapılıp gönderilmeli, client-side markdown parse ağır)

---

## Mimari: Content Brain

### Sync Endpoint (YENİ)

```
GET /api/workspaces/{wsId}/projects/{projId}/brain/sync
  ?treeSha=<optional-last-known-sha>

Response (ilk yükleme — treeSha yok):
{
  treeSha: "abc123",
  config: { ... },
  vocabulary: { ... },
  context: { ... },
  models: [
    { id: "blog-posts", name: "Blog Posts", kind: "collection", ... , fields: { ... } }
  ],
  content: {
    "blog-posts": {
      "en": {
        entries: { "id1": { title: "...", body: "..." }, ... },
        meta: { "id1": { status: "published", ... } }
      },
      "tr": { ... }
    },
    "hero-section": {
      "en": { data: { title: "...", cta: "..." }, meta: { ... } }
    }
  },
  documents: {
    "docs": {
      "en": [
        { slug: "getting-started", frontmatter: { ... }, body: "...", meta: { ... } }
      ]
    }
  }
}

Response (delta sync — treeSha var):
{
  treeSha: "def456",
  changed: {
    "blog-posts": { "en": { entries: { "id3": { ... } }, meta: { "id3": { ... } } } }
  },
  deleted: {
    "blog-posts": { "en": { entries: ["id5"] } }
  }
}
```

**Server-side:** Tek endpoint tüm content'i toplar. Document kind için `gray-matter` parse eder. Delta sync için `getTree()` SHA karşılaştırması yapar.

**Git API verimliliği:**
```
İlk sync: getTree(1) + readFile(N dosya) = ~N+1 call (bir kerelik)
Delta sync: getTree(1) + readFile(değişen dosya sayısı) = ~1-5 call
```

### Client: Content Brain Worker

```
┌─────────────────────────────────────────────────┐
│  Dedicated Web Worker: content-brain.worker.ts  │
│                                                 │
│  IndexedDB Stores:                              │
│   "brain-models"    → model definitions         │
│   "brain-entries"   → all entries (all models)   │
│   "brain-meta"      → entry metadata             │
│   "brain-config"    → config, vocab, context     │
│   "brain-sync"      → treeSha, lastSync          │
│                                                 │
│  Indexes:                                       │
│   entries: [model_id, locale] (compound)        │
│   entries: [model_id, status] (compound)        │
│   entries: [model_id, locale, has_meta_desc]    │
│   meta: [model_id, locale, status]              │
│                                                 │
│  FlexSearch Instance:                           │
│   Full-text index over entry titles + bodies    │
│   ~6KB library, <5ms search                     │
│                                                 │
│  CompressionStream:                             │
│   Large body fields gzip compressed             │
│   60-80% reduction                              │
└─────────────────────┬───────────────────────────┘
                      │ postMessage
                      ↓
┌─────────────────────────────────────────────────┐
│  Main Thread                                    │
│                                                 │
│  useContentBrain() composable:                  │
│   - init(workspaceId, projectId)                │
│   - query(modelId, filters?)                    │
│   - search(keyword, options?)                   │
│   - analyze(type)                               │
│   - getSummary() → for system prompt            │
│   - invalidate(changedModels?)                  │
│   - onReady(callback)                           │
│                                                 │
│  BroadcastChannel: "brain-sync"                 │
│   Cross-tab sync notifications                  │
└─────────────────────────────────────────────────┘
```

### Composable Entegrasyonu — Mevcut Katmanları Replace Eder

```ts
// BUGÜN: 2 ayrı composable, 2 ayrı cache
const { snapshot } = useSnapshot()           // IndexedDB cache #1
const { content } = useModelContent()         // Memory + IndexedDB cache #2

// CONTENT BRAIN İLE: tek composable, tek cache
const { brain } = useContentBrain()

// Snapshot verisi
const models = brain.models                   // reactive, Brain'den
const config = brain.config                   // reactive, Brain'den
const vocabulary = brain.vocabulary           // reactive, Brain'den

// Model content (eskiden useModelContent)
const blogEntries = brain.query('blog-posts', { locale: 'en' })  // Brain IndexedDB'den

// Full-text search (YENİ — eskiden imkansızdı)
const results = brain.search('pricing')       // FlexSearch, <5ms

// Health analysis (YENİ)
const health = brain.analyze('seo_audit')     // IndexedDB aggregate
```

### useSnapshot ve useModelContent Ne Olur?

```
Phase 1 (hemen):
  useContentBrain eklenir
  useSnapshot ve useModelContent KALIR (fallback)
  Brain hazırsa Brain'den okur, değilse mevcut endpoint'lerden

Phase 2 (Brain stabil):
  useSnapshot → useContentBrain wrapper'ına dönüşür (thin adapter)
  useModelContent → useContentBrain wrapper'ına dönüşür
  Mevcut component'ler değişmez — composable API aynı kalır

Phase 3 (temizlik):
  Eski IndexedDB cache logic silinir
  snapshot.get ve content/[model].get → brain/sync'e yönlendirilir veya kaldırılır
  Tek cache: Brain IndexedDB
```

### Agent Entegrasyonu

**System Prompt Content Index:**

```ts
// agent-system-prompt.ts
function buildContentIndex(brain: ContentBrainSummary): string {
  const lines = ['## Content Brain — Full Project Index']
  lines.push(`${brain.totalEntries} entries, ${brain.models.length} models, ${brain.locales.join('/')}`)

  for (const model of brain.models) {
    const stats = brain.modelStats[model.id]
    lines.push(`${model.name} (${model.kind}, ${stats.entryCount} entries):`)
    if (stats.missingMeta > 0) lines.push(`  ⚠ ${stats.missingMeta} missing meta_description`)
    if (stats.untranslated > 0) lines.push(`  ⚠ ${stats.untranslated} untranslated`)
    if (stats.stale > 0) lines.push(`  ⚠ ${stats.stale} stale (90+ days)`)
  }

  return lines.join('\n') // ~200-500 token
}
```

**Agent'ın Brain tool'ları — sunucu değil, client üzerinden çalışır:**

```
Kullanıcı: "SEO analizi yap"

Agent system prompt'unda content index zaten var (Brain summary)
Agent ihtiyaç duyduğunda:

→ brain_query tool call
→ chat.post.ts bu tool'u tanır
→ Client'a "run brain query" mesajı gönderir (SSE üzerinden)
→ Client Worker'da IndexedDB query çalıştırır
→ Sonucu chat.post.ts'e geri gönderir
→ Agent sonucu görür

VEYA (daha basit):
→ brain_query tool call
→ chat.post.ts kendi server-side cache'inden çalıştırır
  (brain/sync endpoint zaten tüm veriyi biliyor)
```

**İkinci yaklaşım daha pragmatik** — agent tool'ları server-side çalışır, Brain verisi server'da da cache'lenir. Client Brain + Server Brain aynı veriyi paylaşır.

---

## Server-Side Brain Cache

Brain sadece client-side değil — server-side da cache'lenmeli:

```ts
// server/utils/brain-cache.ts
const projectBrains = new Map<string, {
  treeSha: string
  models: ModelDefinition[]
  config: ContentrainConfig
  entryIndex: Map<string, { title: string, status: string, locale: string, wordCount: number }[]>
  lastSync: number
}>()

// brain/sync endpoint çağrıldığında otomatik güncellenir
// Agent tool'ları bu cache'ten okur — Git API'ye gitmez
// TTL: webhook ile invalidate veya 5dk stale
```

Bu sayede:
- Agent HER mesajda Git'e gitmez (bugünkü sorun)
- System prompt content index Brain cache'ten oluşur
- brain_query/brain_search tool'ları server cache'ten çalışır
- Client ve server aynı veriyi paylaşır

---

## Data Flow (Tüm Akış)

```
SYNC:
  Proje açılır
    → Client: useContentBrain.init()
    → Client → GET /api/brain/sync?treeSha=<cached>
    → Server: getTree() → SHA compare → delta dosyaları oku
    → Server: Brain cache güncelle (Map'te)
    → Response: delta JSON (veya full, ilk kez)
    → Client Worker: IndexedDB güncelle, FlexSearch re-index
    → BroadcastChannel: "brain:ready"
    → UI component'ler reactive state'ten render

READ (UI):
  Content panel → model tıkla
    → useContentBrain.query('blog-posts', { locale: 'en' })
    → Worker: IndexedDB compound index query → <1ms
    → Sonuç reactive state'e → UI render

READ (Agent):
  User message → chat.post.ts
    → System prompt: buildContentIndex(serverBrainCache) → ~200 token
    → Agent: brain_query("entries missing meta_description")
    → Server: serverBrainCache'ten query → <1ms
    → Agent: sonucu analiz eder, öneriler sunar

WRITE:
  Agent: save_content → Content Engine → git commit
    → Content Engine: commit başarılı
    → Server: Brain cache invalidate (o model için)
    → Response: affected models
    → Client: Worker'a "invalidate" → brain/sync delta → IndexedDB güncelle
    → BroadcastChannel: "brain:updated" → tüm tab'lar güncellenir
    → UI anında yeni veriyi gösterir
```

---

## Kaldırılacak / Sadeleşecek Kodlar

| Dosya | Bugün | Brain ile |
|-------|-------|----------|
| `useSnapshot.ts` | 165 satır, IndexedDB cache, 5dk TTL | Thin wrapper → `useContentBrain().config/models` |
| `useModelContent.ts` | 130 satır, memory + IDB cache | Thin wrapper → `useContentBrain().query()` |
| `snapshot.get.ts` | 130 satır, ~4+3N+NL Git call | Kaldırılır → `brain/sync` replace eder |
| `content/[modelId].get.ts` | 124 satır, ~3-5 Git call | Kalır ama Brain fallback olarak kullanılır |
| `chat.post.ts` system prompt | Her mesajda ~4+3N Git call | Server Brain cache'ten → 0 Git call |

**Toplam tasarruf:**
- Git API call'ları: ~%90 azalma
- Client cache karmaşıklığı: 2 ayrı sistem → 1 tek Brain
- System prompt build: ~200ms Git okuma → <1ms cache okuma

---

## content_path Override Desteği

Brain sync endpoint model tanımlarını okurken `content_path` override'ları resolve etmeli:

```ts
// Server-side brain sync
for (const model of models) {
  const locales = model.i18n ? supportedLocales : ['data']

  for (const locale of locales) {
    // resolveContentPath handles content_path override automatically
    const contentPath = resolveContentPath(ctx, model, locale)
    const content = await git.readFile(contentPath, branch)
    // ...
  }

  if (model.kind === 'document') {
    // Document kind: content_path override changes base directory
    const baseDir = model.content_path
      ? prefixed(ctx.contentRoot, model.content_path)
      : `${ctx.contentRoot ? ctx.contentRoot + '/' : ''}.contentrain/content/${model.domain}/${model.id}`

    const slugs = await git.listDirectory(baseDir, branch)
    for (const slug of slugs) {
      // gray-matter parse on server (not client)
      const mdPath = resolveContentPath(ctx, model, locale, slug)
      const raw = await git.readFile(mdPath, branch)
      // Parse frontmatter + body, send structured to client
    }
  }
}
```

**Kritik:** Document markdown parse'ı **server-side** yapılır (gray-matter). Client'a structured JSON gider — client markdown parse etmez.

---

## IndexedDB Schema

```ts
// Store: brain-config
{ key: "config", value: ContentrainConfig }
{ key: "vocabulary", value: Record<string, Record<string, string>> }
{ key: "context", value: ContextJson }
{ key: "treeSha", value: string }
{ key: "lastSync", value: number }
{ key: "projectId", value: string }

// Store: brain-models (keyPath: "id")
{ id: "blog-posts", name: "Blog Posts", kind: "collection", domain: "marketing",
  i18n: true, fields: { ... }, content_path: null }

// Store: brain-entries (keyPath: auto, indexes below)
{ model_id: "blog-posts", entry_id: "abc123", locale: "en",
  title: "Getting Started", status: "published", word_count: 850,
  has_meta_description: true, has_image: true,
  data: { /* compressed or full entry JSON */ },
  updated_at: 1711500000 }

// Indexes on brain-entries:
//   [model_id, locale]         → fast model content listing
//   [model_id, status]         → filter published/draft
//   [model_id, locale, status] → compound filter
//   [status]                   → cross-model status query

// Store: brain-meta (keyPath: auto)
{ model_id: "blog-posts", entry_id: "abc123", locale: "en",
  status: "published", source: "agent", updated_by: "user@email",
  publish_at: null, expire_at: null }
```

---

## Storage & Performance

```
Tipik proje (10 model, 300 entry):
  Entries: ~600KB (JSON, uncompressed)
  Models: ~50KB
  Config: ~5KB
  FlexSearch index: ~100KB
  Total: ~750KB

Büyük proje (30 model, 2000 entry):
  Entries: ~4MB
  With CompressionStream: ~1.5MB
  Total: ~2MB

Browser quota: en az 1GB → sorun yok

Performance:
  Cold start: brain/sync ~2-3 saniye (background)
  Warm start: IndexedDB open + delta check ~500ms
  Query: <1ms (compound index)
  Search: <5ms (FlexSearch)
  Analyze: <50ms (JS aggregate over getAll)
```

---

## Implementasyon Sırası

### Adım 1: Brain Sync Endpoint + Server Cache (1 hafta)

- `server/api/.../brain/sync.get.ts` — tek endpoint, tüm content
- `server/utils/brain-cache.ts` — server-side in-memory cache
- Git Tree API delta sync
- Document kind gray-matter parse (server-side)
- content_path override desteği

### Adım 2: Client Brain Worker + useContentBrain (1 hafta)

- `app/workers/content-brain.worker.ts` — Dedicated Worker
- IndexedDB stores + compound indexes
- `app/composables/useContentBrain.ts` — reactive composable
- useSnapshot/useModelContent → Brain wrapper (backward compat)
- BroadcastChannel cross-tab sync

### Adım 3: FlexSearch + brain_search (3-4 gün)

- FlexSearch entegrasyonu Worker içinde
- brain_search tool (agent)
- UI search (content panel'de global search)

### Adım 4: Agent Content Index + brain_query + brain_analyze (1 hafta)

- System prompt content index (Brain summary)
- brain_query tool — server Brain cache'ten
- brain_analyze tool — pre-built aggregate queries
- Eski system prompt Git okumaları kaldırılır

### Adım 5: Temizlik (3-4 gün)

- useSnapshot IndexedDB logic kaldırılır
- useModelContent memory + IDB cache kaldırılır
- snapshot.get endpoint sadeleşir veya kaldırılır
- Tek cache: Brain IndexedDB (client) + Brain Map (server)
