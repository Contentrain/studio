# Forms & Submissions — Content-In for Headless Apps

> Pro+ plan feature (Free'de 1 form, 50 submission)
> Bağımlılık: Content Engine ✅, Model system ✅, CDN API pattern ✅
> CDN bağımlılığı: YOK — form endpoint'leri tamamen bağımsız
> Tahmini süre: 2-3 hafta

---

## Amaç

Mevcut collection model'lerini form endpoint'i olarak açmak. Landing page contact formları, mobile app feedback formları, waitlist signup'ları, testimonial toplama — hepsi Contentrain üzerinden. Submission'lar Studio'da görüntülenir, approve edildiğinde content entry'ye dönüşür.

**Bir cümle:** Content-out (CDN) yanına content-in (Forms) — headless CMS'in eksik yarısı.

---

## Kritik Mimari Karar: CDN'den Bağımsızlık

Form sistemi CDN katmanına **bağımlı değil**:

| İşlem | Kanal | CDN gerekli mi |
|-------|-------|----------------|
| Form config okuma | `/api/forms/v1/{projectId}/{modelId}/config` | ❌ |
| Form submit | `/api/forms/v1/{projectId}/{modelId}/submit` | ❌ |
| Submission listele | Studio UI (session auth) | ❌ |
| Submission export | Studio UI | ❌ |
| Content tüketimi | CDN API (mevcut) | ✅ |

Bu sayede **Free plan'da bile form çalışır** — CDN ve Media olmadan.

### File Upload Ayrımı

Form'daki file upload ≠ Media Asset Manager:
- Media: optimize, variant, blurhash, R2 storage → Pro+ feature
- Form attachment: ham dosya, geçici depolama, size limit → basit storage

Form file upload için Supabase Storage veya basit R2 upload kullanılır.
Media Provider'a bağımlılık yok.

---

## Nasıl Çalışır

### 1. Model'e Form Özelliği Ekleme

Mevcut collection model'ine `form` config eklenir:

```json
{
  "id": "contact-requests",
  "name": "Contact Requests",
  "kind": "collection",
  "domain": "marketing",
  "i18n": false,
  "fields": {
    "name": { "type": "string", "required": true },
    "email": { "type": "email", "required": true },
    "company": { "type": "string" },
    "message": { "type": "markdown", "required": true },
    "budget": { "type": "select", "options": ["< $5K", "$5K-$20K", "$20K-$50K", "$50K+"] }
  },
  "form": {
    "enabled": true,
    "public": true,
    "exposedFields": ["name", "email", "company", "message", "budget"],
    "requiredOverrides": { "company": false },
    "honeypot": true,
    "captcha": "turnstile",
    "successMessage": "Thank you! We'll get back to you within 24 hours.",
    "notifications": {
      "email": ["sales@example.com"],
      "webhook": "https://hooks.slack.com/xxx"
    },
    "limits": {
      "maxPerMonth": 500,
      "rateLimitPerIp": 5,
      "maxFileSize": 5242880
    },
    "autoApprove": false
  }
}
```

`form.exposedFields`: Model'deki tüm field'lar form'da açılmaz. Admin seçer.
`form.requiredOverrides`: Model'de required olan field form'da optional olabilir (veya tersi).
`form.autoApprove`: true → submission direkt draft entry olur. false → submission ayrı tabloda bekler.

### 2. Form Config Endpoint (Public)

```
GET /api/forms/v1/{projectId}/{modelId}/config

Response:
{
  "modelId": "contact-requests",
  "modelName": "Contact Requests",
  "fields": [
    { "id": "name", "type": "string", "required": true, "label": "Name" },
    { "id": "email", "type": "email", "required": true, "label": "Email" },
    { "id": "company", "type": "string", "required": false, "label": "Company" },
    { "id": "message", "type": "markdown", "required": true, "label": "Message" },
    { "id": "budget", "type": "select", "required": false, "options": [...] }
  ],
  "captcha": { "provider": "turnstile", "siteKey": "0x..." },
  "successMessage": "Thank you! We'll get back to you within 24 hours."
}
```

Bu endpoint auth gerektirmez — form'u render etmek için public.

### 3. Submit Endpoint (Public)

```
POST /api/forms/v1/{projectId}/{modelId}/submit
Content-Type: application/json

{
  "data": {
    "name": "Ahmet",
    "email": "ahmet@example.com",
    "company": "Contentrain",
    "message": "Demo istiyorum",
    "budget": "$5K-$20K"
  },
  "captchaToken": "xxx",
  "honeypot": ""
}

Response: 200 OK
{ "success": true, "message": "Thank you! We'll get back to you within 24 hours." }
```

### 4. Submission Flow

```
Submit gelir
  ↓
Validate:
  - Honeypot boş mu (spam check)
  - Captcha token geçerli mi
  - Rate limit aşılmamış mı (IP + project)
  - Monthly limit aşılmamış mı
  - Field validation (type, required, maxLength)
  ↓
Store:
  - form_submissions tablosuna yaz
  - status: 'pending' (autoApprove=false) veya 'approved' (autoApprove=true)
  ↓
autoApprove=true ise:
  - Content Engine → saveContent(modelId, locale, submissionData)
  - Entry draft olarak oluşturulur
  ↓
Notify:
  - Email notification (configured addresses)
  - Webhook notification (configured URL)
  ↓
Response: 200 OK
```

### 5. Studio UI'da Submission Yönetimi

Sidebar'da form-enabled model altında submission count badge:

```
📋 Contact Requests (12 entries)
   └── 📥 5 new submissions
```

Tıklayınca submission listesi:
- Tablo: name, email, date, status (pending/approved/rejected/spam)
- Bulk actions: approve, reject, mark as spam, delete, export
- Approve → content entry'ye dönüşür (draft status)

### 6. Agent Entegrasyonu

Yeni tool'lar:
- `list_submissions(modelId, status?, limit?)` — submission listele
- `approve_submission(submissionId)` — entry'ye dönüştür
- `reject_submission(submissionId)` — reddet

```
User: "Bu haftaki contact form başvurularını özetle"
Agent: list_submissions('contact-requests', 'pending')
→ "12 yeni başvuru: 8 demo talebi, 3 partnership, 1 spam olarak işaretli"

User: "Demo taleplerini onayla"
Agent: approve_submission('id1'), approve_submission('id2'), ...
→ "8 submission onaylandı ve Contact Requests collection'a eklendi"
```

---

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS public.form_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,

  -- Submission data
  data JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'spam')),

  -- Metadata
  source_ip INET,
  user_agent TEXT,
  referrer TEXT,
  locale TEXT DEFAULT 'en',

  -- Tracking
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES profiles(id),
  entry_id TEXT, -- Created content entry ID (after approval)

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_form_submissions_project_model
  ON form_submissions(project_id, model_id, created_at DESC);
CREATE INDEX idx_form_submissions_status
  ON form_submissions(project_id, model_id, status);
```

---

## SDK Entegrasyonu

```ts
// @contentrain/sdk form support
const client = createContentrain({ projectId: 'xxx' })

// Get form config (no API key needed)
const config = await client.form('contact-requests').config()
// → { fields, captcha, successMessage }

// Submit form (no API key needed)
const result = await client.form('contact-requests').submit({
  name: "Ahmet",
  email: "ahmet@example.com",
  message: "Demo istiyorum"
}, { captchaToken: 'xxx' })
// → { success: true, message: "..." }
```

---

## Plan Gating

| | Free | Pro ($9) | Team ($29+seats) | Enterprise |
|---|---|---|---|---|
| Form-enabled models | 1 | 5 | ∞ | ∞ |
| Submissions/month | 50 | 500 | 5,000 | Custom |
| File upload in forms | ❌ | ✅ (10MB) | ✅ (50MB) | ✅ |
| Captcha | ❌ | Turnstile | Turnstile | Custom |
| Email notification | ❌ | 1 address | 5 addresses | ∞ |
| Webhook notification | ❌ | ❌ | ✅ | ✅ |
| Export | ❌ | CSV | CSV + JSON | + API |
| Auto-approve | ❌ | ✅ | ✅ | ✅ |
| Spam AI filter | ❌ | ❌ | ✅ | ✅ |
| Submission API access | ❌ | ❌ | ✅ | ✅ |

**Free plan'da CDN/Media olmadan bile 1 form çalışır.** Bu critical — contact form en temel ihtiyaç.

---

## Güvenlik

- [ ] Captcha enforcement (Turnstile, configurable)
- [ ] Honeypot field (invisible, bot detection)
- [ ] Rate limiting per IP (configurable, default 5/min)
- [ ] Monthly submission limit enforcement
- [ ] Field validation server-side (type, required, maxLength)
- [ ] File upload: MIME whitelist + size limit
- [ ] XSS prevention: submission data sanitized before display
- [ ] No PII in git (submissions are DB-only, not git-synced)
- [ ] GDPR: submission delete endpoint, data export
- [ ] Source IP logged but configurable (privacy compliance)

---

## Gelir Etkisi

**Acquisition:** Free plan contact form → kullanıcı content yönetimi için de kalır → Pro upgrade
**Retention:** Form + content + CDN tek platformda → switching cost yüksek
**Upsell:** 50 submission → 500 limit → Pro. Webhook + spam filter → Business.
**Market positioning:** Contentrain = Headless CMS + Form Builder → Typeform/Formspree bağımlılığı kalkar

---

## Implementasyon Sırası

1. `form_submissions` DB migration
2. Form config in model definition (`form` field in ModelDefinition)
3. Public form config endpoint (`/api/forms/v1/`)
4. Public submit endpoint (validate + captcha + store)
5. Studio UI: submission list view
6. Studio UI: form config toggle in model settings
7. Auto-approve → Content Engine entry creation
8. Agent tools: list_submissions, approve_submission, reject_submission
9. Email notification (EE)
10. Webhook notification (EE)
11. SDK form support
12. Captcha integration (Turnstile)

---

## Schema Validation (İlişkili Concern)

Form sistemi model tanımına bağlı. Geliştirici model'i elle değiştirirse form config geçersiz kalabilir. Bu genel schema validation sorunuyla birlikte çözülmeli — ayrı spec: `.internal/SCHEMA-VALIDATION.md`
