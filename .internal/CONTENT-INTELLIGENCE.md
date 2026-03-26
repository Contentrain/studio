# Content Intelligence — Client-Side Content Brain for Studio

> **Tarih:** 2026-03-26
> **Durum:** Research complete, architecture designed
> **Bağımlılık:** Content Engine ✅, CDN ✅, Snapshot system ✅
> **Tahmini süre:** 3-4 hafta (core) + progressive enhancement

---

## Sorun

Studio'daki AI agent içeriğe **parça parça** erişiyor:

```
Kullanıcı: "30 blog'un SEO analizini yap"

Bugün:
  Agent → get_content('blog-posts', 'en') → GitHub API → 30 entry döner
  Agent → get_content('blog-posts', 'tr') → GitHub API → 30 entry döner
  Agent → get_content('faq', 'en') → GitHub API → ayrı call
  = 3 tool call, 3 API request, agent parça parça düşünüyor

Cursor'da (local):
  Agent → .contentrain/ klasörünü açar → TÜM dosyaları aynı anda görür
  = 0 API call, agent bütüncül düşünüyor
```

Bu Studio'nun en büyük dezavantajı — local geliştirme deneyimi Studio'dan daha güçlü.

---

## Rakip Analiz (2026-03 Güncel)

### Sanity Content Agent (en gelişmiş rakip)

- Conversational AI agent — kullanıcı "tüm blog'ları analiz et" diyebilir
- GROQ sorguları yazarak Content Lake'ten batch veri çeker
- LLM ile analiz eder, staged draft'lar önerir
- **Sınırlama:** GROQ batch'leri + LLM context window limiti — tüm içeriği aynı anda göremez
- **Sınırlama:** Lokal dosyalara erişemez, sadece dataset'teki veri
- **Sınırlama:** Cross-document consistency "first pass discovery" — enforcement değil

### Diğerleri

- **Contentful:** Per-entry AI Actions (max 200 batch), cross-content analiz yok
- **Strapi:** AI sadece schema üretir, içerik analizi sıfır
- **Hygraph:** Per-workflow-step AI, MCP server var ama analiz dışarıda
- **Payload:** RAG/vector ile benzer içerik bulur ama analiz yok

### Hiçbirinin Yapamadığı

Tüm modellerin, tüm locale'lerin, tüm entry'lerin **aynı anda** AI context'inde olması.
Cross-model ilişki analizi. Locale parity check. Schema-aware SEO audit.
Tüm bunlar **tek prompt'ta**, sıfır API call ile.

---

## Çözüm: Content Brain

Studio'da çalışan AI agent'a **tüm proje içeriğini** browser'da indexed, compressed, searchable olarak sunmak.

### Mimari

```
GitHub Repo (.contentrain/)
         ↓
    Snapshot API (mevcut)
         ↓
    Content Brain Worker (yeni)
         ↓
┌─────────────────────────────────────┐
│  Browser — Dedicated Web Worker     │
│                                     │
│  ┌──────────────────────────┐       │
│  │  SQLite WASM (wa-sqlite) │       │
│  │  + OPFS persistence      │       │
│  │                          │       │
│  │  Tables:                 │       │
│  │   models     (schema)    │       │
│  │   entries    (content)   │       │
│  │   entries_fts (FTS5)     │       │
│  │   embeddings (vectors)   │       │
│  └──────────────────────────┘       │
│                                     │
│  ┌──────────────────────────┐       │
│  │  Transformers.js         │       │
│  │  (embedding generation)  │       │
│  │  all-MiniLM-L6-v2       │       │
│  └──────────────────────────┘       │
│                                     │
│  ┌──────────────────────────┐       │
│  │  EdgeVec (vector search) │       │
│  │  HNSW index, SQ8 quant  │       │
│  └──────────────────────────┘       │
│                                     │
│  ┌──────────────────────────┐       │
│  │  CompressionStream       │       │
│  │  (gzip for large bodies) │       │
│  └──────────────────────────┘       │
└─────────────────────────────────────┘
         ↓
    BroadcastChannel (cross-tab sync)
         ↓
    Main Thread (Studio UI + Agent)
```

### Nasıl Çalışır

**1. İlk Yükleme (project açılışında)**

```
User projekte açar
  → Snapshot API'den model listesi + content summary çekilir (mevcut)
  → Content Brain Worker başlatılır
  → Worker tüm content dosyalarını GitHub API'den çeker (paralel)
  → SQLite'a yazar: models, entries, FTS5 index
  → Embeddings üretir (Transformers.js, background)
  → EdgeVec index'i oluşturur
  → BroadcastChannel ile main thread'e "ready" sinyali
```

**2. Agent Conversation**

```
User: "30 blog'un SEO analizini yap"

Bugün (3 tool call):
  Agent → get_content('blog-posts', 'en') → GitHub API → bekle → döner
  Agent sonuç analiz eder
  Agent → get_content('blog-posts', 'tr') → GitHub API → bekle → döner
  ...

Content Brain ile (0 tool call):
  Agent system prompt'unda zaten var:
  "## Content Brain (indexed, 450 entries across 10 models)
   blog-posts: 30 entries (en/tr) — titles, slugs, meta, word counts
   faq: 15 entries — questions, categories
   ..."

  Agent ihtiyaç duyduğunda yeni tool:
  → brain_search("SEO meta description eksik olan blog'lar") → FTS5 query → anında döner
  → brain_query("SELECT * FROM entries WHERE model='blog-posts' AND locale='en'") → SQLite → anında döner
  → brain_semantic("blog posts similar to 'AI content management'") → vector search → anında döner
```

**3. Content Değiştiğinde**

```
Webhook (mevcut) → snapshot invalidate → Content Brain re-sync
Veya: Agent save_content yaptı → Brain Worker'a "entry changed" mesajı
→ Worker ilgili entry'yi günceller (full re-sync gerekmez)
→ FTS5 + embedding re-index (sadece değişen entry)
→ BroadcastChannel ile diğer tab'lara bildirim
```

---

## Agent'a Sunulan Yeni Yetenekler

### System Prompt Context Index

Her conversation başında agent'a tüm projenin özeti verilir:

```
## Content Brain — Full Project Index

Status: 450 entries indexed, 10 models, 2 locales (en, tr)
Last sync: 2 minutes ago

### Models & Entry Summaries
blog-posts (collection, 30 entries, en/tr):
  Published: 24 | Draft: 6
  Avg word count: 850 | Missing meta_description: 8
  Tags: [ai, content, management, tutorial, guide...]
  Recent: "AI Content in 2026" (3 days ago)

hero-section (singleton, en/tr):
  title: "Build faster with AI" | cta: "Get Started"

faq (collection, 15 entries, en):
  Categories: [general, pricing, technical]
  Missing: 0 required fields

### Content Health
- 8 entries missing meta_description
- 3 entries with title > 60 chars
- 2 stale entries (90+ days)
- Locale parity: en=30, tr=25 (5 untranslated)
```

Bu **sıfır tool call** ile agent'a tam proje bilinci verir. Sanity Content Agent bunu yapamaz — her sorguda GROQ yazması lazım.

### Yeni Agent Tools

```ts
{
  name: 'brain_query',
  description: 'Query all project content via SQL. Returns matching entries instantly from local index.',
  inputSchema: {
    properties: {
      sql: { type: 'string', description: 'SQL query against entries table' },
    }
  }
}

{
  name: 'brain_search',
  description: 'Full-text search across all content. Finds entries by keyword, phrase, or field value.',
  inputSchema: {
    properties: {
      query: { type: 'string' },
      model: { type: 'string', description: 'Optional: limit to specific model' },
      locale: { type: 'string', description: 'Optional: limit to specific locale' },
    }
  }
}

{
  name: 'brain_semantic',
  description: 'Semantic similarity search. Finds content conceptually related to the query.',
  inputSchema: {
    properties: {
      query: { type: 'string' },
      limit: { type: 'number', default: 10 },
    }
  }
}

{
  name: 'brain_analyze',
  description: 'Run a pre-built analysis on all content. Types: seo_audit, locale_parity, stale_content, relation_integrity, quality_score.',
  inputSchema: {
    properties: {
      type: { type: 'string', enum: ['seo_audit', 'locale_parity', 'stale_content', 'relation_integrity', 'quality_score'] },
    }
  }
}
```

### Token Verimliliği

Agent'a tüm content'i ham JSON olarak vermek token israfı:

```
30 blog × 1000 kelime = 30,000 kelime ≈ 40,000 token
Bu context window'un %20'si — çok pahalı
```

Bunun yerine Content Brain **özetlenmiş index** verir:

```
Content Brain summary: 450 entries, 10 models
blog-posts: 30 entries, 8 missing meta_description, 5 untranslated
= ~200 token (%0.1 context window)
```

Agent detaya ihtiyaç duyduğunda `brain_query` veya `brain_search` ile **sadece ihtiyacı olanı** çeker:

```
Agent: brain_query("SELECT title, meta_description FROM entries WHERE model='blog-posts' AND meta_description IS NULL")
→ 8 satır döner, sadece 2 field = ~400 token
```

Bu **Sanity Content Agent'ın yapamadığı** bir optimizasyon — çünkü Sanity'de GROQ sorgusu her seferinde API'ye gider, latency var. Content Brain'de sorgu browser'da SQLite'ta çalışır — **0ms latency.**

---

## Teknik Detay: SQLite Schema

```sql
-- Models (schema cache)
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  name TEXT,
  kind TEXT,
  domain TEXT,
  i18n BOOLEAN,
  fields_json TEXT,  -- compressed JSON
  updated_at INTEGER
);

-- Entries (all content, all models, all locales)
CREATE TABLE entries (
  id TEXT,
  model_id TEXT,
  locale TEXT,
  data_json TEXT,          -- compressed entry data
  title TEXT,              -- extracted primary field (for display)
  status TEXT,             -- draft/published
  word_count INTEGER,      -- computed
  has_meta_description BOOLEAN,
  updated_at INTEGER,
  PRIMARY KEY (id, model_id, locale)
);

-- Full-text search index
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, content, tags,
  content=entries,
  content_rowid=rowid
);

-- Vector embeddings (stored separately for EdgeVec)
CREATE TABLE embeddings (
  entry_id TEXT,
  model_id TEXT,
  locale TEXT,
  vector BLOB,  -- float32 array, compressed
  PRIMARY KEY (entry_id, model_id, locale)
);

-- Sync metadata
CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Keys: last_sync, content_hash, project_id, commit_sha
```

---

## Teknik Detay: Storage Verimliliği

### Compression

```
30 blog × ortalama 5KB JSON = 150KB raw
CompressionStream (gzip): %70 compression → 45KB stored
450 entry × ortalama 2KB = 900KB raw → 270KB stored

Embedding storage:
450 entry × 384 dim × 4 bytes (float32) = 691KB
SQ8 quantization (EdgeVec): 691KB / 4 = 173KB

Total browser storage: ~500KB-1MB for typical project
Max for large project (5000 entries): ~10-15MB
```

Browser storage quota: **en az 1GB** (çoğu browser %60 disk). 10MB bile sorun değil.

### Performance Budget

```
İlk yükleme (cold start):
  Content fetch: 2-3 saniye (30 paralel GitHub API call)
  SQLite init: 100ms
  FTS5 index build: 200ms
  Embedding model load: 3-5 saniye (first time, cached after)
  Embedding generation: 450 entries × 10ms = 4.5 saniye
  Total cold start: ~10-15 saniye (background, UI blocked değil)

Sonraki yüklemeler (warm start):
  SQLite + OPFS: 50ms (cache'ten)
  Delta sync: 500ms (sadece değişenler)
  Total warm start: <1 saniye

Query performance:
  brain_query (SQL): <1ms
  brain_search (FTS5): <5ms
  brain_semantic (vector): <1ms (EdgeVec)
  brain_analyze (aggregate): <50ms
```

---

## Progressive Enhancement Stratejisi

Herkese hepsini birden vermek gerekmez:

### Tier 1: Content Index (tüm planlar, 1 hafta)

- Snapshot'tan model + entry summary çıkar
- System prompt'a content index ekle
- `brain_query` tool (basit — mevcut get_content'in genişletilmişi)
- **Yeni teknoloji gerektirmez** — mevcut snapshot verisi yeterli

### Tier 2: Full-Text Search (Pro+, 1 hafta)

- SQLite WASM (wa-sqlite) + OPFS in Web Worker
- Tüm content browser'a indirilir, SQLite'a yazılır
- FTS5 full-text search
- `brain_search` tool
- Compressed storage (CompressionStream)

### Tier 3: Semantic Search (Team+, 2 hafta)

- Transformers.js in Web Worker (all-MiniLM-L6-v2)
- EdgeVec vector index
- `brain_semantic` tool
- Progressive: embedding'ler background'da üretilir

### Tier 4: Content Analysis (tüm planlar, 1 hafta)

- `brain_analyze` tool — pre-built SQL aggregation queries
- SEO audit, locale parity, stale content, quality score
- Schema validation integration
- Health dashboard data source

---

## Neden Rakipler Bunu Yapamaz

### Contentful/Strapi/Hygraph

İçerik database'de. Browser'a indirmek için tüm content'i API'den çekmek lazım:
- Rate limit: 7 req/sec (Contentful)
- Pagination: 100 entry/page
- 1000 entry = 10 page × 10 model = 100 API call = 14 saniye minimum
- Ve her sayfa değişiminde yeniden çekmek lazım

Contentrain: snapshot + content dosyaları git'ten paralel fetch → 2-3 saniye, OPFS'te cache → sonraki açılışta 50ms.

### Sanity

Sanity Content Agent GROQ ile sorgular — ama her sorgu API'ye gider:
- Latency: 200-500ms per query (network round-trip)
- Context window: GROQ sonuçlarını LLM'e vermeli — büyük dataset'lerde truncation

Contentrain Content Brain: SQLite sorgusu browser'da çalışır — 0ms latency. FTS5 + vector search de browser'da. Network dependency sıfır (cache'ten).

### Payload

RAG/vector search var ama:
- Enterprise-only
- Server-side — client'ta çalışmaz
- Retrieval, analysis değil ("benzer bul" vs "tüm content'i analiz et")

Contentrain: vector search browser'da, tüm planlarda (progressive enhancement).

---

## Plan Gating

| Yetenek | Free | Pro | Team | Enterprise |
|---------|------|-----|------|------------|
| Content Index (system prompt) | ✅ | ✅ | ✅ | ✅ |
| brain_query (SQL) | ✅ | ✅ | ✅ | ✅ |
| brain_search (FTS5) | — | ✅ | ✅ | ✅ |
| brain_semantic (vector) | — | — | ✅ | ✅ |
| brain_analyze (health) | ✅ | ✅ | ✅ | ✅ |
| Offline mode | — | ✅ | ✅ | ✅ |

---

## Implementasyon Sırası

1. **Content Index + brain_query** (Tier 1) — mevcut snapshot'ı genişlet
2. **SQLite WASM + FTS5 + brain_search** (Tier 2) — wa-sqlite + OPFS
3. **brain_analyze** (Tier 4) — SQL aggregation queries
4. **Embeddings + brain_semantic** (Tier 3) — Transformers.js + EdgeVec
5. **Delta sync + cross-tab** — BroadcastChannel + SharedWorker
6. **Offline mode** — Service Worker + OPFS persistence

---

## Sonuç

Content Brain Contentrain'i **sadece bir CMS değil, AI content intelligence platform** yapıyor.

Hiçbir rakip bunu yapamaz çünkü:
1. İçerikleri database'de — browser'a verimli şekilde taşıyamazlar
2. API rate limit'leri var — tüm content'i hızlıca çekemezler
3. Client-side indexing altyapıları yok — SQLite/FTS5/vector search yokBugün var:

Contentrain'de tüm content git'te → browser'a indir → SQLite'ta indexle → FTS5 + vector search → agent'a sun. **Sıfır latency, sıfır API call, tam project awareness.**

Bu "nice to have" değil — bu **erişilmez rekabet avantajı.**
