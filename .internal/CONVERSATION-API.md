# Conversation API — External AI Content Operations

> Business+ plan feature
> Bağımlılık: Content Engine ✅, Media Provider ✅, Agent Tools ✅, CDN API pattern ✅
> Tahmini süre: 1-2 hafta (core engine hazır, sadece auth + transport layer)

---

## Amaç

Studio'nun conversation-first content engine'ini dış uygulamalara açmak. Telegram botları, Slack entegrasyonları, CI/CD pipeline'ları ve custom dashboard'lar Studio'nun AI agent'ını programatik olarak kullanabilir.

**Bir cümle:** Studio UI'daki chat deneyiminin aynısı — API key ile, herhangi bir platformdan.

---

## Kullanım Senaryoları

### 1. Marketing Bot (Telegram/Slack)
Marketing ekibi Telegram'dan: "Yaz kampanyası banner'ını güncelle, başlık 'Summer Sale %50' olsun"
→ Bot → Conversation API → Agent → save_content → git commit → CDN rebuild

### 2. E-commerce Content Automation
CI/CD pipeline yeni ürün eklendiğinde: "Create product entry for SKU-12345 with these details..."
→ Webhook trigger → Conversation API → Agent → create entry → auto-merge

### 3. Translation Workflow
Çeviri servisi tamamlandığında: "Update Turkish locale for blog post 'getting-started'"
→ Automation → Conversation API → Agent → save_content(locale: 'tr')

### 4. Content QA Bot (Discord)
QA ekibi Discord'dan: "Check all hero sections for missing alt texts"
→ Bot → Conversation API → Agent → validate → report

### 5. Scheduled Content
Cron job: "Publish the Black Friday campaign entries"
→ Scheduler → Conversation API → Agent → update status → CDN rebuild

---

## Mimari

```
External Client (Bot/Pipeline/App)
         ↓
POST /api/conversation/v1/{projectId}/message
Authorization: Bearer crn_conv_xxx
         ↓
┌──────────────────────────────────────────┐
│  Conversation API Gateway                │
│                                          │
│  1. API Key validation (SHA-256 lookup)  │
│  2. Rate limit check (per-key, per-plan) │
│  3. Permission resolution (role, models) │
│  4. Monthly usage check                  │
│  5. Custom instructions injection        │
│                                          │
│  ↓ Same engine as Studio UI ↓            │
│                                          │
│  buildSystemPrompt()                     │
│  → Claude API (tool_use)                 │
│  → Tool execution (Content Engine)       │
│  → Git commit / branch                   │
│  → Response                              │
└──────────────────────────────────────────┘
```

### Core Engine Paylaşımı

| Katman | Studio UI | Conversation API | Değişiklik |
|--------|-----------|-----------------|------------|
| Auth | Session cookie | API key → role | Yeni auth layer |
| Permissions | workspace_members + project_members | Key config (role, models, tools, locales) | Key-based resolution |
| System Prompt | buildSystemPrompt() | buildSystemPrompt() + custom_instructions | Ek section |
| Tool Execution | chat.post.ts tool switch | Aynı tool switch | Yok |
| Content Engine | createContentEngine() | Aynı | Yok |
| Media Provider | useMediaProvider() | Aynı | Yok |
| Git Provider | useGitProvider() | Aynı | Yok |
| CDN Builder | executeCDNBuild() | Aynı | Yok |

---

## API Endpoints

### Message (Core)

```
POST /api/conversation/v1/{projectId}/message
Authorization: Bearer crn_conv_{key}
Content-Type: application/json

{
  "message": "Update the hero banner title to 'Summer Sale'",
  "conversationId": "optional-existing-conversation",
  "locale": "en",
  "attachments": [
    { "url": "https://example.com/banner.jpg", "type": "image" }
  ]
}

Response:
{
  "conversationId": "uuid",
  "reply": "Done. I've updated the hero-section banner title to 'Summer Sale' and uploaded the image.",
  "toolResults": [
    { "tool": "save_content", "model": "hero-section", "merged": true },
    { "tool": "upload_media", "path": "media/original/abc123.webp" }
  ]
}
```

### Conversation History

```
GET /api/conversation/v1/{projectId}/history?conversationId=xxx&limit=20
Authorization: Bearer crn_conv_{key}

Response:
{
  "messages": [
    { "role": "user", "content": "...", "createdAt": "..." },
    { "role": "assistant", "content": "...", "toolCalls": [...], "createdAt": "..." }
  ]
}
```

### Key Management (Studio UI routes — session auth)

```
GET    /api/workspaces/{wsId}/projects/{projId}/conversation-keys
POST   /api/workspaces/{wsId}/projects/{projId}/conversation-keys
PATCH  /api/workspaces/{wsId}/projects/{projId}/conversation-keys/{keyId}
DELETE /api/workspaces/{wsId}/projects/{projId}/conversation-keys/{keyId}
```

---

## API Key Konfigürasyonu

### DB Şeması

```sql
CREATE TABLE conversation_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Auth (CDN key pattern)
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix VARCHAR(16) NOT NULL,
  name TEXT NOT NULL,

  -- Access control
  role TEXT NOT NULL DEFAULT 'editor'
    CHECK (role IN ('viewer', 'editor', 'admin')),
  specific_models BOOLEAN DEFAULT false,
  allowed_models TEXT[] DEFAULT '{}',
  allowed_tools TEXT[] DEFAULT '{}',
  allowed_locales TEXT[] DEFAULT '{}',

  -- AI configuration
  custom_instructions TEXT,
  ai_model TEXT DEFAULT 'claude-sonnet-4-5-20241022',

  -- Limits
  rate_limit_per_minute INTEGER DEFAULT 30,
  monthly_message_limit INTEGER DEFAULT 1000,

  -- Tracking
  messages_this_month INTEGER DEFAULT 0,
  month_reset_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_conv_keys_hash ON conversation_api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_conv_keys_project ON conversation_api_keys(project_id);
```

### Studio UI Key Konfigürasyonu

Key oluşturma/düzenleme modal'ında yapılandırılabilir alanlar:

| Alan | Açıklama | Default |
|------|----------|---------|
| Name | Key tanımlayıcı isim | Zorunlu |
| Role | viewer / editor / admin | editor |
| Specific Models | Sadece belirli model'lere erişim | false (tümü) |
| Allowed Models | Erişilebilir model ID listesi | [] (tümü) |
| Capabilities | İzin verilen tool'lar (read, write, media, delete, model mgmt, branch ops) | Role default |
| Allowed Locales | Erişilebilir locale'ler | [] (tümü) |
| Custom Instructions | Key-specific system prompt eki | Boş |
| Rate Limit | Dakika başı request limiti | 30 |
| Monthly Limit | Aylık mesaj limiti | 1000 |

### Custom Instructions Örneği

```
You are a marketing content assistant for the e-commerce team.

Rules:
- Only update banner titles, descriptions, and images
- Keep all text under 60 characters
- Use professional, engaging tone in Turkish
- Never modify pricing or product data
- Always set alt text when uploading images
- Respond in Turkish
```

Bu text agent system prompt'una eklenir:

```
## API Key Configuration
Key: "Marketing Bot" (editor, restricted access)
Allowed models: banner-section, hero-section
Allowed tools: get_content, save_content, search_media, upload_media
Allowed locales: en, tr

### Custom Instructions (from project admin)
You are a marketing content assistant for the e-commerce team.
[...]
```

---

## Permission Resolution

```
API Key → conversation_api_keys row
  ↓
  role: editor
  specific_models: true
  allowed_models: ['banner-section', 'hero-section']
  allowed_tools: ['get_content', 'save_content', 'search_media', 'upload_media']
  allowed_locales: ['en', 'tr']
  ↓
resolveConversationPermissions(key)
  → AgentPermissions {
      workspaceRole: 'member',
      projectRole: key.role,
      specificModels: key.specific_models,
      allowedModels: key.allowed_models,
      availableTools: intersect(TOOL_ROLES[key.role], key.allowed_tools),
    }
  ↓
buildSystemPrompt(permissions, uiContext, customInstructions)
  → Standard prompt + key restrictions + custom instructions
```

---

## Review/Approval Entegrasyonu

Conversation API, Studio'nun review workflow'uyla tam uyumlu:

| Senaryo | Davranış |
|---------|----------|
| Workflow: auto-merge, Key role: editor | Content direkt merge edilir |
| Workflow: review, Key role: editor | Branch oluşturulur, merge beklenir |
| Workflow: review, Key role: admin | Branch oluşturulur + auto-merge |
| Key role: viewer | Sadece read — write tool'lar blocked |

**Bot → branch → Studio'da review → approve/reject** akışı:

```
Telegram Bot (editor key):
  "Banner'ı güncelle" → branch: contentrain/change-abc123
  Bot yanıt: "Changes saved to review branch. Awaiting approval."

Studio UI (reviewer/admin):
  Branch listesinde görür → diff inceler → Merge/Reject

Veya Slack Bot (admin key):
  "Approve the banner change" → merge_branch('contentrain/change-abc123')
  → Auto-merge → CDN rebuild
```

---

## İlişkili API Katmanları

Conversation API tek başına yeterli olsa da, tam bir external integration deneyimi için:

### Content REST API (`api.rest`)

```
GET    /api/content/v1/{projectId}/models
GET    /api/content/v1/{projectId}/content/{modelId}?locale=en
POST   /api/content/v1/{projectId}/content/{modelId}
PATCH  /api/content/v1/{projectId}/content/{modelId}/{entryId}
DELETE /api/content/v1/{projectId}/content/{modelId}/{entryId}
```

Deterministic CRUD — Claude API maliyeti olmadan. Programatik bulk operasyonlar için.

### Media REST API (`api.media`)

```
POST   /api/media/v1/{projectId}/upload
GET    /api/media/v1/{projectId}/assets
DELETE /api/media/v1/{projectId}/assets/{assetId}
```

Programatik media upload — Claude overhead'i olmadan.

### Outbound Webhooks (`api.webhooks_outbound`)

```
content.saved     → POST callback_url
content.deleted   → POST callback_url
media.uploaded    → POST callback_url
branch.created    → POST callback_url
branch.merged     → POST callback_url
build.completed   → POST callback_url
```

Event-driven notification — bot'ların Studio'daki değişiklikleri anlık öğrenmesi.

### Tam Platform API Matrisi

| API | Amaç | Auth | Plan |
|-----|-------|------|------|
| CDN Read | Content tüketimi (mobile/web) | crn_live_ key | Pro+ |
| Conversation | AI-powered content ops | crn_conv_ key | Business+ |
| Content REST | Programatik CRUD | crn_api_ key | Business+ |
| Media REST | Programatik upload | crn_api_ key | Business+ |
| Outbound Webhooks | Event notification | Configured URL | Business+ |

---

## Gelir Modeli

### Plan Bazlı Fiyatlandırma

| | Pro ($9/mo) | Team ($29/mo + seats) | Enterprise (Custom) |
|---|---|---|---|
| Studio UI Chat | 500 msg/mo | 2,000 msg/mo | Custom |
| Conversation API Keys | ❌ | 5 keys | Unlimited |
| API Messages/month (included) | ❌ | 1,000 | Custom |
| Content REST API | ❌ | ✅ | ✅ |
| Outbound Webhooks | ❌ | 10 endpoints | Unlimited |
| Custom Instructions | ❌ | ✅ | ✅ |
| Rate Limit | — | 30 req/min | Custom |

### Ek Gelir: Usage-Based Overage

**API Message Overage ($0.05/message):**
Team plan 1,000 mesaj/ay dahil. Aşım:
- $0.05/message (flat rate)
- 20,000+: Enterprise'a yönlendir

**2. AI Model Upsell:**
Default: Claude Sonnet (hızlı, ucuz)
Premium: Claude Opus (Business+, ek $20/mo veya per-message premium)

**3. Dedicated Capacity (Enterprise):**
Custom rate limits, guaranteed throughput, SLA — annual contract.

### Gelir Projeksiyonu

| Metrik | Team | Enterprise |
|--------|------|------------|
| ARPU | $29/mo + seats + overage | $299+/mo |
| Conversation API contribution | ~$10/mo (usage overage) | Included |
| Retention impact | Bot entegrasyonu = yüksek switching cost | Lock-in |

**Key insight:** Conversation API en güçlü retention aracı. Müşteri bot yazdığında Contentrain'den ayrılması çok zor — tüm automation yeniden yazılmalı.

---

## Güvenlik Checklist

- [ ] API key SHA-256 hash (plaintext DB'de yok)
- [ ] Key sadece oluşturulduğunda bir kez gösterilir
- [ ] Revoked key anında devre dışı
- [ ] Rate limiting per-key (configurable)
- [ ] Monthly message limit enforcement
- [ ] Model-scoped access (specific_models + allowed_models)
- [ ] Tool-scoped access (allowed_tools whitelist)
- [ ] Locale-scoped access (allowed_locales whitelist)
- [ ] Custom instructions injection (admin-controlled)
- [ ] BYOA key support (müşterinin kendi Claude API key'i)
- [ ] Audit trail (conversation_id + key_id + tool_calls logged)
- [ ] IP whitelist (Enterprise, optional)

---

## Implementasyon Sırası

### Phase A: Core (1 hafta)
1. `conversation_api_keys` DB migration
2. Key generation + validation (CDN key pattern clone)
3. `/api/conversation/v1/{projectId}/message` endpoint
4. Permission resolution from key config
5. Custom instructions injection into system prompt

### Phase B: Studio UI (3-4 gün)
6. Key management panel (list, create, edit, revoke)
7. Key configuration modal (role, models, tools, locales, instructions)
8. Usage dashboard (messages this month, last used)

### Phase C: Companion APIs (1 hafta)
9. Content REST API endpoints
10. Media REST API endpoints
11. Outbound webhook configuration + delivery

### Phase D: Polish (2-3 gün)
12. Rate limiting (Redis or in-memory)
13. Monthly usage reset cron
14. API documentation page (auto-generated from endpoints)

---

## EE/Core Ayrışımı

| Katman | Konum | Neden |
|--------|-------|-------|
| conversation_api_keys migration | Core (supabase/migrations/) | DB schema always core |
| Key validation utility | Core (server/utils/) | CDN key pattern |
| Conversation API endpoint | Core (server/api/conversation/) | hasFeature() gated |
| Permission resolution | Core (server/utils/) | Extends existing agent-permissions |
| Key management routes | Core (server/api/.../conversation-keys/) | hasFeature() gated |
| Key management UI | Core (app/components/) | hasFeature() gated |
| Content REST API | Core (server/api/content/) | hasFeature() gated |
| Custom AI model selection | EE (ee/ai/) | Premium model routing |
| Overage billing | EE (ee/billing/) | Stripe metering |
| IP whitelist | EE (ee/security/) | Enterprise feature |

---

## Kritik Dosyalar

| Dosya | İşlem |
|-------|-------|
| `supabase/migrations/008_conversation_api.sql` | YENİ |
| `server/utils/conversation-keys.ts` | YENİ (CDN key pattern clone) |
| `server/api/conversation/v1/[projectId]/message.post.ts` | YENİ |
| `server/api/conversation/v1/[projectId]/history.get.ts` | YENİ |
| `server/api/.../conversation-keys/*.ts` | YENİ (CRUD routes) |
| `server/utils/agent-permissions.ts` | DEĞİŞTİR (key-based resolution) |
| `server/utils/agent-system-prompt.ts` | DEĞİŞTİR (custom instructions section) |
| `server/utils/license.ts` | DEĞİŞTİR (api.conversation feature) |
| `app/components/organisms/ConversationKeyPanel.vue` | YENİ |
| `app/components/organisms/ConversationKeyModal.vue` | YENİ |
