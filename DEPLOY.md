# Deployment Guide — CRE Financial Suite

Follow these steps **in order** to get the app fully working in production.
Each step maps to a finding in the audit report.

---

## Step 1 — Set Frontend Environment Variables (F-001)

Set these in your hosting provider (Vercel / Netlify / Cloudflare Pages):

| Variable | Value |
|----------|-------|
| `VITE_SUPABASE_URL` | `https://<your-project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Found in Supabase Dashboard → Project Settings → API → anon public |
| `VITE_STRIPE_PUBLISHABLE_KEY` | `pk_live_...` from Stripe Dashboard |

> **Never put these in `.env` and commit them.** Use your host's secret management.

---

## Step 2 — Apply Database Migrations (F-002)

```bash
# Link your local project to production
supabase link --project-ref YOUR_PROJECT_REF

# Push all 80+ migrations
supabase db push
```

If `supabase db push` fails on a conflict, run:
```bash
supabase db push --include-all
```

---

## Step 3 — Deploy All Edge Functions (F-003)

```bash
# Deploy every function at once
supabase functions deploy

# Or deploy individually if you want to control which go live:
supabase functions deploy ingest-file
supabase functions deploy normalize-pdf-output
supabase functions deploy lease-extraction-worker
supabase functions deploy generate-budget
# ... repeat for each function in supabase/functions/
```

---

## Step 4 — Set Supabase Edge Function Secrets

### Required — App Will Not Work Without These

```bash
# Email sending (F-006) — get key from resend.com
supabase secrets set RESEND_API_KEY=re_YOUR_KEY

# AI lease extraction (F-004) — pick ONE provider:
# Option A: Anthropic Claude
supabase secrets set ANTHROPIC_API_KEY=sk-ant-YOUR_KEY

# Option B: Google Vertex AI (alternative to Anthropic)
supabase secrets set VERTEX_PROJECT_ID=your-gcp-project-id
supabase secrets set VERTEX_LOCATION=us-central1
supabase secrets set GOOGLE_SERVICE_ACCOUNT_KEY='{"type":"service_account","project_id":"...","private_key":"..."}'

# Inter-function authentication (F-005) — generate any 32-char random string
supabase secrets set WORKER_INTERNAL_SECRET=CHANGE_ME_TO_A_RANDOM_32_CHAR_SECRET
```

### Required for Billing (F-020)

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_YOUR_KEY
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_YOUR_SECRET
```

### Optional

```bash
# Frontend URL (used in signup confirmation emails)
supabase secrets set FRONTEND_URL=https://your-app.vercel.app

# UPS address validation
supabase secrets set UPS_CLIENT_ID=your_ups_client_id
supabase secrets set UPS_CLIENT_SECRET=your_ups_client_secret
```

---

## Step 5 — Verify Storage Bucket (F-015)

1. Go to Supabase Dashboard → Storage
2. Confirm a bucket named `financial-uploads` exists
3. If it does not exist, run:
   ```sql
   INSERT INTO storage.buckets (id, name, public)
   VALUES ('financial-uploads', 'financial-uploads', false)
   ON CONFLICT (id) DO NOTHING;
   ```

---

## Step 6 — Verify Supabase Auth Settings

In Supabase Dashboard → Authentication → URL Configuration:

- **Site URL**: `https://your-app.vercel.app`
- **Redirect URLs**: Add `https://your-app.vercel.app/**`

In Authentication → Email Templates:
- Confirm the confirmation URL points to your production domain

---

## Step 7 — Test the Critical Paths

After all steps above are complete, test in order:

1. **Signup** → check that confirmation email arrives
2. **Login** → confirm auth works
3. **Add a Property** → confirms DB + RLS working
4. **Upload a Lease PDF** → confirms storage + pipeline
5. **Lease Review** → confirms AI extraction + edge functions
6. **Create a Budget** → confirms budget generation flow
7. **Send a test email** (invite a user) → confirms Resend

---

## Quick Reference — Generate WORKER_INTERNAL_SECRET

```bash
# macOS / Linux
openssl rand -hex 16

# Windows PowerShell
[System.Web.Security.Membership]::GeneratePassword(32, 4)

# Or just use any 32-character random string:
# e.g. xK9mP2qR7vL4nB8wZ1cY5tH6jF3eA0sU
```

---

## Checklist

- [ ] VITE_SUPABASE_URL set to production URL (not localhost)
- [ ] VITE_SUPABASE_ANON_KEY set to production key
- [ ] `supabase db push` completed without errors
- [ ] `supabase functions deploy` completed
- [ ] RESEND_API_KEY set
- [ ] ANTHROPIC_API_KEY (or Vertex creds) set
- [ ] WORKER_INTERNAL_SECRET set
- [ ] STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET set
- [ ] `financial-uploads` storage bucket exists
- [ ] Supabase Auth redirect URLs updated
- [ ] Signup → email confirmation tested
- [ ] Lease upload → AI extraction tested
- [ ] Budget creation tested
