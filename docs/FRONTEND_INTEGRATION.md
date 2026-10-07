# ربط الفرونت الأصلي بالـ API

## 1) الـ API

`POST {API_URL}/api/chat` — الـ body بصيغة JSON:

```json
{
  "message": "شقق في القاهرة",
  "sessionId": "web_...",
  "history": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }],
  "priorFilters": { "city": "القاهرة" }
}
```

- `message` إجباري (حتى 2000 حرف). الباقي اختياري.
- `sessionId`: رقم ثابت لكل محادثة (مثلاً `web_${crypto.randomUUID()}`). الـ API بيرجّعه في الرد، فاحتفظ بيه وابعته تاني.
- `history`: آخر رسايل المحادثة (حتى 20).
- `priorFilters`: خد `filters` من الرد السابق وابعتها تاني عشان أسئلة زي "فيه أرخص؟" تشتغل.

### الرد الناجح (200)

```json
{
  "text": "نص رد المساعد",
  "properties": [ /* العقارات المطابقة */ ],
  "filters": { /* ابعتها كـ priorFilters في الرسالة اللي بعدها */ },
  "sessionId": "web_...",
  "quota": { "remaining": 3, "limit": 5, "signedIn": false }
}
```

### الأخطاء

| الحالة | `code` | معناها | اعمل إيه في الفرونت |
|---|---|---|---|
| 429 | `login_required` | زائر خلّص رسايله المجانية (5 لكل IP) | افتح شاشة تسجيل الدخول |
| 429 | `daily_limit` | المستخدم المسجّل خلّص 5 النهارده | اعرض `error` وقوله يرجع بكرة |
| 429 | `global_limit` | المشروع كله وصل للحد اليومي | اعرض `error` |
| 403 | `disposable_email` | إيميل مؤقت | اطلب إيميل حقيقي |
| 503 | — | الخدمة مش متاحة مؤقتاً | اعرض `error` وجرّب تاني |
| 400 | — | الـ body غلط | راجع الحقول |

كل الأخطاء فيها `error` نص جاهز للعرض بلغة المستخدم.

## 2) تسجيل الدخول (Supabase Auth — مشروع الحسابات)

الـ API بيقبل زائر بدون تسجيل (5 رسايل/IP)، ولو بعتّله `Authorization: Bearer <access_token>` بيحسب الليمت على الإيميل المؤكد (5 رسايل/إيميل).

```bash
npm i @supabase/supabase-js
```

```ts
import { createClient } from '@supabase/supabase-js'

// من مشروع الحسابات (anon/publishable key فقط — ممنوع service_role)
export const sb = createClient(ACCOUNTS_SUPABASE_URL, ACCOUNTS_SUPABASE_ANON_KEY)

// 1. ابعت الكود على الإيميل
await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })

// 2. المستخدم يكتب الكود
await sb.auth.verifyOtp({ email, token: code, type: 'email' })

// 3. مع كل رسالة
const { data } = await sb.auth.getSession()
const res = await fetch(`${API_URL}/api/chat`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(data.session ? { authorization: `Bearer ${data.session.access_token}` } : {}),
  },
  body: JSON.stringify({ message, sessionId, history, priorFilters }),
})
const body = await res.json()
if (body.code === 'login_required') openLoginModal()
```

الـ SDK بيجدّد التوكن لوحده. استخدم `sb.auth.onAuthStateChange` لتحديث حالة الدخول في الواجهة.

## 3) لو الفرونت على دومين تاني غير الـ API

ضيف الدومين في `ALLOWED_ORIGINS` (متغير على Cloudflare):

```bash
npx wrangler secret put ALLOWED_ORIGINS
# القيمة: https://yourfrontend.com,https://www.yourfrontend.com
```

وللتجربة المحلية ضيف `http://localhost:5173` (أو البورت بتاعك). لو الفرونت والـ API على نفس الدومين مش محتاج ده.

## 4) مرجع

`docs/demo-page.reference.txt` فيه صفحة الديمو القديمة كاملة (واجهة الشات + الدخول + عدّاد الرسايل) تقدر ترجع لها كمثال.
