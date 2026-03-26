# Content Intelligence — Client-Side Content Brain for Studio

> **Tarih:** 2026-03-26 (revised)
> **Durum:** Research complete, architecture designed
> **Bağımlılık:** Content Engine ✅, CDN ✅, Snapshot system ✅
> **Plan konumlaması:** KARAR VERİLMEDİ — ayrıca tartışılacak

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

Studio'nun en büyük dezavantajı — local geliştirme deneyimi Studio'dan daha güçlü.

---

## Rakip Analiz (2026-03 Güncel)

### Sanity Content Agent (en gelişmiş rakip)

- Conversational AI agent — kullanıcı "tüm blog'ları analiz et" diyebilir
- GROQ sorguları yazarak Content Lake'ten batch veri çeker
- LLM ile analiz eder, staged draft'lar önerir
- **Sınırlama:** GROQ batch'leri + LLM context window limiti — tüm içeriği aynı anda göremez
- **Sınırlama:** Lokal dosyalara erişemez, sadece dataset'teki veri

### Contentful

- Per-entry AI Actions (max 200 batch), cross-content analiz yok
- AI Actions field-level transform — SEO optimize per entry, compare yok

### Strapi

- AI sadece schema üretir (Content Type Builder), içerik analizi sıfır

### Hygraph

- Per-workflow-step AI Agents, MCP server var ama analiz dışarıda yapılmalı

### Payload

- RAG/vector ile benzer içerik bulur ama cross-content analiz yok, Enterprise-only

### Gerçek Moat: Mimari Fark

Rate limit argümanı zayıf — rakipler kendi dashboard'larında rate limit'i bypass edebilir. **Gerçek fark mimari:**

```
API-native CMS (Contentful, Sanity, Strapi):
  İçerik → Database → API → Browser
  ↑ Her transferde serialization/deserialization
  ↑ Multi-tenant DB paylaşımı = performans izolasyonu zor
  ↑ Client'a tüm content'i indirmek = bandwidth maliyeti (her müşteri için)
  ↑ Client-side index altyapısı yok — sıfırdan kurulması lazım

Git-native CMS (Contentrain):
  İçerik → .json dosyaları → Git repo → Browser
  ↑ Zaten portable format (JSON files)
  ↑ Git tree API ile delta sync (sadece değişenler)
  ↑ Client'ta indexlendiğinde TÜM sorguları local çalıştırabilir
  ↑ Browser cache = sonraki açılışlarda 0 transfer
```

Rakipler teknik olarak bunu yapabilir mi? Evet — ama **yapmak için tüm mimarilerini değiştirmeleri lazım.** Database-first'ten file-first'e geçiş = yıllar süren yeniden yazım.

---

## Çözüm: Content Brain

Studio'da çalışan AI agent'a **tüm proje içeriğini** browser'da indexed, compressed, searchable olarak sunmak.

### Mimari

```
GitHub Repo (.contentrain/)
         ↓
    Git Tree API (delta sync)
         ↓
    Content Brain Worker (Dedicated Web Worker)
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
│  └──────────────────────────┘       │
│                                     │
│  ┌──────────────────────────┐       │
│  │  CompressionStream       │       │
│  │  (gzip for JSON bodies)  │       │
│  └──────────────────────────┘       │
│                                     │
│  ┌──────────────────────────┐       │
│  │  Transformers.js         │       │ ← FUTURE (Tier 3, ihtiyaç doğarsa)
│  │  + EdgeVec vector search │       │
│  └──────────────────────────┘       │
└─────────────────────────────────────┘
         ↓
    BroadcastChannel (cross-tab sync)
         ↓
    Main Thread (Studio UI + Agent)
```

### Data Flow

**1. İlk Yükleme (project açılışında)**

```
User projeyi açar
  → git.getTree() → 1 API call → tüm dosya SHA listesi
  → Cache'teki SHA'larla karşılaştır (delta detection)
  → Sadece yeni/değişen dosyaları readFile() → 5-100 call (projeye göre)
  → Content Brain Worker'a gönder
  → Worker: SQLite'a yaz, FTS5 index, computed fields (word_count, has_meta vb.)
  → BroadcastChannel → main thread'e "ready" sinyali
```

**2. Sonraki Açılışlar (warm start)**

```
User projeyi açar
  → OPFS'teki SQLite cache'i aç → 50ms
  → git.getTree() → SHA karşılaştır → delta varsa güncelle
  → Yoksa: zaten güncel, sıfır transfer
```

**3. Content Değiştiğinde**

```
Agent save_content yaptı
  → Content Engine commit eder
  → Brain Worker'a "entry changed" mesajı
  → Worker: sadece o entry'yi günceller (full re-sync gerekmez)
  → FTS5 re-index (sadece o entry)
```

---

## GitHub API Verimliliği

Endişe: 30 model × 3 locale = 90+ dosya çekmek GitHub rate limit'i tüketir mi?

**Git Tree API bunu çözüyor:**

```
Yaklaşım 1 (kötü): Her dosya için readFile() = 90 call
Yaklaşım 2 (doğru): getTree() + selective readFile()

getTree() → 1 call → tüm dosyaların SHA hash'leri
Cache'teki SHA'larla karşılaştır:
  - Değişmeyen dosya: skip (0 call)
  - Değişen dosya: readFile() (1 call per file)

İlk yükleme: 1 + 90 = 91 call (bir kerelik)
Sonraki sync: 1 + (değişen dosya sayısı) = tipik 1-5 call
Rate limit: 5000/saat → sorun yok
```

`git.getTree()` zaten GitProvider'da implement edilmiş — kullanılması lazım.

---

## Agent'a Sunulan Yeni Yetenekler

### System Prompt Content Index

Her conversation başında agent'a projenin özeti verilir:

```
## Content Brain — Full Project Index

Status: 450 entries indexed, 10 models, 2 locales (en, tr)
Last sync: 2 minutes ago

### Models & Entry Summaries
blog-posts (collection, 30 entries, en/tr):
  Published: 24 | Draft: 6
  Avg word count: 850 | Missing meta_description: 8
  Tags: [ai, content, management, tutorial, guide...]

hero-section (singleton, en/tr):
  title: "Build faster with AI" | cta: "Get Started"

faq (collection, 15 entries, en):
  Categories: [general, pricing, technical]

### Content Health
- 8 entries missing meta_description
- 3 entries with title > 60 chars
- 2 stale entries (90+ days)
- Locale parity: en=30, tr=25 (5 untranslated)
```

~200 token — context window'un %0.1'i. Agent **sıfır tool call** ile tüm projeyi biliyor.

### Agent Tools

```ts
// Structured query — tüm content'e SQL ile erişim
brain_query(sql: "SELECT title, slug FROM entries WHERE model='blog-posts' AND meta_description IS NULL")
→ 8 satır, <1ms, 0 API call

// Full-text search — tüm modeller, tüm locale'ler üzerinde
brain_search(query: "pricing", model?: "faq", locale?: "en")
→ FTS5 ranked results, <5ms

// Pre-built analysis — aggregation queries
brain_analyze(type: "seo_audit" | "locale_parity" | "stale_content" | "quality_score")
→ Hazır rapor, <50ms

// FUTURE: Semantic similarity search
brain_semantic(query: "AI content management", limit: 10)
→ Vector search, <1ms (ihtiyaç doğarsa, Tier 3)
```

### Token Verimliliği

```
Geleneksel yaklaşım:
  Agent: get_content('blog-posts', 'en') → 30 blog × 1000 kelime = 40,000 token
  Bu context window'un %20'si

Content Brain yaklaşımı:
  System prompt: content index = 200 token
  Agent ihtiyaç duyduğunda: brain_query("SELECT title, meta FROM ...") = 400 token
  Toplam: 600 token (%0.3)

66x daha token-verimli.
```

---

## Teknik Detay: SQLite Schema

```sql
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  domain TEXT,
  i18n BOOLEAN DEFAULT 0,
  fields_json TEXT,
  updated_at INTEGER
);

CREATE TABLE entries (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  data_json TEXT NOT NULL,       -- compressed (gzip) entry data
  title TEXT,                    -- extracted primary field
  status TEXT,
  word_count INTEGER DEFAULT 0,
  has_meta_description BOOLEAN DEFAULT 0,
  has_image BOOLEAN DEFAULT 0,
  sha TEXT,                      -- git SHA for delta sync
  updated_at INTEGER,
  UNIQUE(id, model_id, locale)
);

CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, content, tags,
  content=entries,
  content_rowid=rowid
);

CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

---

## Storage Verimliliği

```
Tipik proje (30 model, 500 entry):
  Raw JSON: ~1MB
  Compressed (gzip): ~300KB
  SQLite overhead: ~100KB
  FTS5 index: ~200KB
  Total: ~600KB

Büyük proje (100 model, 5000 entry):
  Raw JSON: ~10MB
  Compressed: ~3MB
  SQLite + FTS5: ~5MB
  Total: ~8MB

Browser storage quota: en az 1GB → sorun yok.
```

---

## Performance Budget

```
Cold start (ilk kez):
  getTree(): 500ms
  Content fetch (paralel): 2-3 saniye
  SQLite init + write: 300ms
  FTS5 index: 200ms
  Total: ~3-4 saniye (background, UI blocked değil)

Warm start (cache'ten):
  OPFS SQLite open: 50ms
  Delta check (getTree): 500ms
  Delta sync (0-5 files): 0-500ms
  Total: <1 saniye

Query performance:
  brain_query (SQL): <1ms
  brain_search (FTS5): <5ms
  brain_analyze (aggregate): <50ms
```

---

## Browser Uyumluluk

| Teknoloji | Chrome | Safari | Firefox | Risk |
|-----------|--------|--------|---------|------|
| Web Workers | ✅ | ✅ | ✅ | Yok |
| IndexedDB | ✅ | ✅* | ✅ | *Safari incognito: 0 quota |
| OPFS | ✅ 86+ | ✅ 15.2+ | ✅ 111+ | Safari incognito: yok |
| OPFS sync (Worker) | ✅ 108+ | ✅ 17+ | ✅ 111+ | Eski Safari: async only |
| CompressionStream | ✅ 80+ | ✅ 16.4+ | ✅ 113+ | Yok |
| SQLite WASM | ✅ | ✅ | ✅ | WASM universal |
| BroadcastChannel | ✅ | ✅ | ✅ | Yok |

### Fallback Stratejisi

```
Tier 1: OPFS mevcut → SQLite + OPFS (en hızlı, persistent)
Tier 2: OPFS yok → SQLite + IndexedDB VFS (yavaş ama çalışır)
Tier 3: Hiçbiri yok (Safari incognito) → Mevcut davranış (her seferinde API)
```

%99+ kullanıcı Tier 1 veya 2 alır. Studio authenticated app — incognito kullanımı nadir.

---

## Over-Engineering Değerlendirmesi

| Bileşen | Over-engineering mi? | Karar |
|---------|---------------------|-------|
| Content Index (system prompt) | **Hayır** — mevcut snapshot'ı genişletmek | YAPILMALI |
| brain_query (SQL) | **Hayır** — SQLite + OPFS production-ready | YAPILMALI |
| brain_search (FTS5) | **Hayır** — gerçek fark burada | YAPILMALI |
| brain_analyze (aggregation) | **Hayır** — SQL query'ler, basit | YAPILMALI |
| Delta sync (getTree) | **Hayır** — zaten GitProvider'da var | YAPILMALI |
| Transformers.js (embeddings) | **EVET** — 23MB model, 300MB memory | FUTURE/OPTIONAL |
| EdgeVec (vector search) | **EVET** — FTS5 çoğu case'i karşılar | FUTURE/OPTIONAL |
| SharedWorker (cross-tab) | **Kısmen** — BroadcastChannel yeterli başta | SONRA |

**Tier 3 (semantic search) ÇIKARILABİLİR.** FTS5 "meta description eksik olanları bul" için yeterli. Vector search "buna benzer content bul" için güzel ama critical değil. İhtiyaç doğarsa eklenir.

---

## Implementasyon Sırası

### Adım 1: Content Index + brain_query (1 hafta)

Mevcut snapshot'ı genişlet — entry title/status/word_count ekle.
System prompt'a content index section.
`brain_query` tool — basit: tüm content'i memory'de tut, JavaScript filter.
**Yeni dependency yok.** Hemen yapılabilir.

### Adım 2: SQLite WASM + FTS5 + brain_search (1-2 hafta)

wa-sqlite dependency.
Web Worker + OPFS persistence.
FTS5 full-text search.
`brain_search` tool.
CompressionStream for storage.

### Adım 3: Delta Sync + brain_analyze (1 hafta)

getTree() SHA comparison.
Incremental sync (sadece değişenler).
Pre-built analysis queries (SEO, locale parity, stale, quality).
BroadcastChannel cross-tab notification.

### Adım 4: Semantic Search — FUTURE/OPTIONAL

Transformers.js + EdgeVec.
Sadece ihtiyaç doğarsa ve kullanıcı geri bildirimi talep ederse.
