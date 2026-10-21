# AstraGrid AI — $0/Month Free Hosting Plan (Cloudflare Pages + Render)

Status: **prepared and verified locally — NOT deployed.** Nothing has been pushed,
connected, or created on any provider. Deployment starts only after you connect
GitHub and (for the one AWS identity step) approve it explicitly.

Goal: a genuinely **$0/month** hosting setup with **no new paid AWS resources**
and **no mechanism that can produce an unexpected charge**.

---

## 1. Architecture

```text
  Browser ──HTTPS──▶ Cloudflare Pages (free, static SPA, unlimited bandwidth)
             │        https://<project>.pages.dev
             │        build-time env: VITE_API_URL (public, not a secret)
             ▼
  GET {VITE_API_URL}/api/...
             │
             ▼
  Render Free Web Service (Express API, sleeps after 15 min idle)
             │        https://<service>.onrender.com
             │        env (dashboard only): ALLOWED_ORIGINS, ASTRAGRID_TABLE_NAME,
             │        AWS_REGION, AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
             ▼
  Existing AWS ap-south-2 resources — UNCHANGED
     DynamoDB table (GSI1, TTL, stream) → AstraGridDetectionLambda
        → EventBridge astragrid-events → /aws/events/astragrid-anomalies
```

- Frontend: React/Vite static build on **Cloudflare Pages**.
- Backend: the **existing Express API** (unchanged code) on **Render Free**.
- Database & event pipeline: the existing DynamoDB/Streams/Lambda/EventBridge/
  CloudWatch resources — **not modified, not replaced, not deleted**.
- The previously proposed Amplify + HTTP API + Lambda deployment is **on hold and
  will not be deployed** (see `docs/deployment.md`).
- Sensor simulator: stays an optional **local** process (requirement 6).
- ML package (`ml/`): untouched, offline only (requirement 7).

---

## 2. Verified free-tier limits (checked 2026-10-21)

### Cloudflare Pages — Free plan
*Source: developers.cloudflare.com/pages/platform/limits + cloudflare.com/plans*

| Limit | Value |
| --- | --- |
| Builds | **500 per month**, 1 concurrent, 20-minute timeout |
| Requests / bandwidth | **Unlimited** (static assets; no metering) |
| Projects / files | 100 projects, 20,000 files, 25 MiB max asset |
| Custom domains | 100, with free TLS |
| Credit card | **Not required** ("Start building for free — no credit card required") |
| Charge risk | None: there is no usage-based billing on the free plan |

### Render — Free compute plan
*Source: render.com/docs/free (official) + render.com/pricing*

| Behavior | Value |
| --- | --- |
| Instance hours | **750 free hours per workspace per calendar month**; a spun-down service consumes none. If exhausted → Free web services are **suspended until the next month** (suspension, not a charge). |
| Sleep | **Spins down after 15 min without inbound HTTP/WebSocket traffic**; spins back up on the next request in **~1 minute** (a loading page is shown meanwhile). |
| Outbound bandwidth | **5 GB included per workspace per month** (reduced from 100 GB in April 2026), then $0.15/GB — **but if no payment method is on file, Render suspends the Free services for the rest of the month instead of billing.** |
| Build pipeline | **500 minutes/month included**, then billing — **without a payment method (or if a spend limit is reached), new builds are disabled for the month; running services keep serving their existing artifacts.** |
| Instance | 512 MB shared, single instance, no scaling; may be restarted by Render at any time; **ephemeral filesystem** (harmless here — all state lives in DynamoDB) |
| Not available on Free | persistent disks, SSH, private networking, one-off jobs, edge caching |
| Service-initiated traffic | Render may suspend a Free service that sends an uncommonly high volume of outbound traffic (our DynamoDB calls are KB-scale — far below this at demo volume) |
| Credit card | **Not required** to sign up and run Free services |

**The single most important anti-charge rule: do NOT add a payment method to the
Render workspace.** With no payment method, every possible overage (bandwidth,
build minutes) converts into a **suspension/disable, never an invoice**. Render
emails you before and after any usage limit.

### Cold start — handled by the existing frontend
Render's spin-up page returns non-JSON; the dashboard's `fetch` fails to parse,
shows the amber "Unable to refresh live data" banner, and **retries every 4 s**
(plus offline detection). After the ~1 min wake, the next retry succeeds and the
dashboard loads — no code change needed.

### AWS-side costs
No new AWS resources are created. The only AWS change proposed is a **free**
IAM user + inline policy (`docs/iam/astragrid-render-api-policy.json`).
Existing resources keep billing as before (≈ $0–2/month for the demo-scale
DynamoDB/EventBridge/CloudWatch usage; unchanged by this plan). AWS data transfer
out for API responses is well inside the monthly free egress allowance at demo
volumes. See `docs/deployment.md` §7 for the verified ap-south-2 unit prices.

---

## 3. Repo changes (minimal set — all local, committed by you)

| File | Purpose |
| --- | --- |
| `apps/web/public/_redirects` | SPA fallback `/* → /index.html 200` for Pages (app itself uses hash routes) |
| `render.yaml` | Render blueprint: Free plan, exact build/start commands, env scaffold (`sync: false` for secrets) |
| `docs/iam/astragrid-render-api-policy.json` | Least-privilege DynamoDB policy for the Render API identity (no secrets inside) |
| `docs/deployment-free.md` | This guide |
| `docs/deployment.md` | Previous AWS proposal, marked ON HOLD (not deployed) |
| `README.md` | Points to this plan |

No application code changed for this plan — the API already provides everything
requirement 3 asks for:

- **Build/start**: `npm ci --include-workspace-root --workspace=@astragrid/api`
  → `npm run build --workspace=@astragrid/api`; start `node apps/api/dist/index.js`
  (reads Render's `PORT`, binds `0.0.0.0`).
- **Health endpoint**: `GET /api/health` → `{"data":{"status":"ok",...}}`.
- **Production CORS**: `ALLOWED_ORIGINS` (exact origin match; browser requests
  from any other origin get no CORS header; non-browser callers unaffected).
- **Input validation**: sensor/zone whitelist, finite non-negative values,
  timestamps, 16 KB body cap.
- **Safe errors**: generic `{error:{code,message}}` payloads, stack traces only
  in server logs, explicit 503 when the data store is unreachable.

**Everything below was proven in an isolated copy of this repo** (the exact
commands above, then production-like smoke tests):

```text
npm ci (api filtered)   OK   node_modules 63 MB
api build               OK
GET /api/health + allowed origin   → 200 + body ok + ACAO echo   PASS
GET health + foreign origin        → 200, NO ACAO header         PASS
OPTIONS preflight (allowed origin) → 204 + ACAO                  PASS
unknown route                      → 404 NOT_FOUND               PASS
malformed JSON                     → 400 INVALID_JSON            PASS
invalid reading                    → 400 INVALID_READING         PASS
npm ci (web filtered)   OK
web build with VITE_API_URL        OK (URL baked in; no localhost fallback; no key-like strings)
dist/_redirects present            PASS
```

---

## 4. Secure DynamoDB access from Render (requirement 5)

**Chosen mechanism: a dedicated, least-privilege IAM user whose only power is
item-level access to the one operational table; its access keys live exclusively
in Render's dashboard secrets — never in git, never in the frontend.**

Policy: `docs/iam/astragrid-render-api-policy.json` — exactly five actions
(`dynamodb:Query, BatchGetItem, PutItem, UpdateItem, TransactWriteItems`,
matching every command the repository issues), scoped to the table ARN **and its
indexes**. Implicit deny covers everything else in the account: no stream reads,
no `Scan`/`DescribeTable`, no EventBridge, no IAM, no `Resource: *`. Cost/blast
radius ceiling: demo table contents (simulated data, 7-day TTL readings).

Why the alternatives were rejected — all would require either a **paid service**,
**new AWS resources** (forbidden by requirement 9), or **unacceptable risk**:

| Alternative | Verdict |
| --- | --- |
| Credentials broker (small Lambda/API issuing STS sessions) | New AWS resources — not allowed |
| OIDC federation (Render → `AssumeRoleWithWebIdentity`) | Render does not provide workload identity tokens for AWS |
| AWS IAM Roles Anywhere | Needs an X.509 issuer/CA infrastructure (paid or operational burden) |
| Long-lived keys committed to the repo or baked into `VITE_*` | Explicitly forbidden (they would be public) |
| Broad `AmazonDynamoDBFullAccess`-style user | Violates least privilege |

**Residual risk, stated plainly:** access keys do not expire on their own. If the
Render workspace were breached, an attacker could read/modify **only this demo
table's items** — nothing else in AWS, no deletions of other resources, no
stream/EventBridge access. Mitigations: keys exist only in Render's encrypted
secret storage; the IAM user has no console password; keys can be rotated or the
user deleted at any time with one command (revocation is immediate); CloudTrail
management events remain available for auditing. For simulated, TTL'd demo data
this is an acceptable risk — if you judge it unacceptable, the safe fallback is
**no public backend**: the frontend already ships an "API URL not configured"
state and everything stays local.

### Approval-gated step (NOT executed yet)

```sh
# Run only after explicit approval (or run them yourself — they are all free):
aws iam create-user --user-name astragrid-render-api
aws iam put-user-policy --user-name astragrid-render-api \
  --policy-name AstraGridOperationalTableOnly \
  --policy-document file://docs/iam/astragrid-render-api-policy.json
# Then, in the AWS console (so the secret never passes through chat/files):
# IAM → Users → astragrid-render-api → Security credentials → Create access key
# → paste the pair directly into Render's environment settings.
```

Rotation/revoke:
`aws iam create-access-key --user-name astragrid-render-api` (new pair) → update
Render → `aws iam delete-access-key --user-name astragrid-render-api --access-key-id <old>`.
Full removal: delete the user (nothing else depends on it).

---

## 5. Exact deployment instructions (GitHub → free dashboards)

Order matters because of the two URL handshakes. **You** connect GitHub (I cannot
and will not claim completion before the real URLs are verified).

### Step 1 — Cloudflare Pages (frontend)

1. Sign up / log in to Cloudflare (no card needed) → **Workers & Pages → Create
   → Pages → Connect to Git** → select `temujin1893/astragrid-ai`, branch `main`.
2. Build settings (the repo's `amplify.yml` is not used by Pages — enter these):
   - Build command: `npm ci --include-workspace-root --workspace=@astragrid/web && npm run build --workspace=@astragrid/web`
   - Build output directory: `apps/web/dist`
   - Root directory: `/` (repository root)
   - Environment variable: `NODE_VERSION` = `20` (`.nvmrc` also pins 20)
3. Deploy. Note the URL: `https://<project>.pages.dev`.
   It will show **"API URL not configured"** until Step 3 — expected and handled.
4. The SPA fallback ships automatically via `public/_redirects` → `dist/_redirects`
   (verified above), so refresh/deep links resolve to `index.html`.

### Step 2 — Render (backend)

1. *(After your approval of §4)* create the IAM user + policy, then create its
   access key in the AWS console.
2. Render → **New → Web Service → Connect a repository** → same repo, branch `main`.
   Render detects **`render.yaml`** (blueprint). Confirm before creating:
   - Compute plan: **Free** (render.yaml sets `plan: free`; verify the dashboard
     shows Free — never Starter/Pro).
   - Region: the one closest to `ap-south-2` offered during creation (lower
     DynamoDB round-trip latency; expect ~100–250 ms).
   - Build: `npm ci --include-workspace-root --workspace=@astragrid/api && npm run build --workspace=@astragrid/api`
   - Start: `node apps/api/dist/index.js`
3. Set the three `sync: false` environment variables (dashboard → Environment):
   - `ALLOWED_ORIGINS` = `https://<project>.pages.dev`
   - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` = the pair from step 1
     (**enter here only — never in git, never anywhere in the frontend**)
   - (`ASTRAGRID_TABLE_NAME`, `AWS_REGION`, `NODE_VERSION` come from render.yaml)
4. Create/deploy. Note the URL `https://<service>.onrender.com` and verify:

   ```sh
   curl -s https://<service>.onrender.com/api/health
   # first call may take ~60 s (cold start) → {"data":{"status":"ok",...}}
   curl -s -o /dev/null -D - -H "Origin: https://evil.example" \
     https://<service>.onrender.com/api/health | grep -i access-control-allow-origin
   # must print nothing
   ```

### Step 3 — Connect the two

1. Pages → your project → **Settings → Environment variables** → add
   `VITE_API_URL` = `https://<service>.onrender.com` → **Retry deployment** (env
   vars are baked at build time).
2. Re-run the verification checklist in §8 before calling anything "live".

Redeploys: push to `main` → both platforms rebuild automatically (Pages 500
builds/mo; Render 500 pipeline minutes/mo — keep pushes occasional).

---

## 6. What works publicly vs. what needs the local simulator (truthful)

| Capability | Publicly available? |
| --- | --- |
| Dashboard UI (HTTPS, any browser) | ✅ Pages URL, always |
| `GET /api/health`, `/api/dashboard`, `/api/sensors`, `/api/zones`, `/api/incidents` | ✅ Render URL — data comes from the existing DynamoDB table |
| `POST /api/readings` | ✅ publicly reachable (same as the previously approved public design) — but see caveat |
| Fresh sensor values, ONLINE statuses, new incidents | ⚠️ **only while the simulator runs on your machine**: `API_URL=https://<service>.onrender.com npm run dev:simulator`, then stop it after the demo. Without it, sensors show their last stored values and go `OFFLINE` (15 s staleness rule); no new readings/incidents are created. |
| Streams → Detection Lambda → EventBridge → CloudWatch | ✅ fires for **every write** (simulator-driven); verify in the ap-south-2 console while the simulator runs. Reads never trigger it. |
| ML package | 🖥️ offline/local only, intentionally not hosted |
| First load after 15 idle minutes | ⏳ ~60 s wake with automatic retry (banner shown meanwhile) |

---

## 7. Cost & security checklist ($0 proof)

### Cost

- [ ] Cloudflare Pages: free plan, **no card on file possible to charge** —
      unlimited bandwidth/requests, 500 builds/mo. → **$0**
- [ ] Render: Free plan selected (`plan: free` in render.yaml — verify in
      dashboard). **No payment method added** → bandwidth/build overages suspend
      service instead of billing (official docs). 750 instance-hours/mo reset
      monthly; sleeping costs nothing. → **$0, chargeable by construction: no**
- [ ] AWS: no new chargeable resources; only a free IAM user; existing stack
      untouched (run `cd infra && npx cdk diff` anytime to confirm it still shows
      no changes vs the live stack — do **not** deploy it while this plan is active)
- [ ] Usage discipline: keep dashboard tabs closed outside demos (24/7 polling
      would exhaust Render's 5 GB outbound/750 h faster than intended →
      suspension, still $0); occasional pushes stay within both 500-unit caps
- [ ] AWS Billing alert (recommended, free): set a $1 threshold alarm on the
      existing account as a belt-and-braces check

### Security

- [ ] No AWS credentials, keys, or secrets in the repo or in any `VITE_*` var —
      verified: bundle grep for `AKIA…/ASIA…` patterns finds nothing; only the
      public API URL is baked in
- [ ] Backend secrets only in Render env (encrypted at rest, `sync: false`)
- [ ] IAM: 5 DynamoDB actions on exactly 1 table + its indexes; no console user;
      rotation/revocation commands documented (§4)
- [ ] CORS: exact-origin allow-list (`ALLOWED_ORIGINS`); foreign origins get no
      ACAO header (tested); CORS is not authentication — the API URL itself is
      public, same as any demo backend, bounded by input validation, 16 KB body
      cap, generic error payloads, and read/write scope limited to demo items
- [ ] Errors: generic `{code,message}` only; stack traces stay in server logs
- [ ] Data: simulated, TTL'd after 7 days, labeled "SIMULATED DATA · DEMO
      ENVIRONMENT" in the UI footer; ML output remains offline-only

---

## 8. Post-deployment verification (before anything is called "live")

- [ ] `https://<project>.pages.dev` loads the dashboard (not the
      "API URL not configured" state)
- [ ] `curl https://<service>.onrender.com/api/health` → `status: "ok"`
- [ ] Browser dev tools: dashboard request goes to the Render host and renders
      data (CORS working); foreign-origin curl shows no ACAO header
- [ ] Run the simulator for a few minutes → values update, `GET /api/sensors`
      reflects them, KATPADI ≥ 90 cm creates an incident on screen
- [ ] CloudWatch: `/aws/lambda/AstraGridDetectionLambda` invocation logged and
      `/aws/events/astragrid-anomalies` contains the matching
      `SensorAnomalyDetected` event (ap-south-2) — the preserved pipeline works
- [ ] Stop the simulator → within 15 idle minutes Render sleeps; a later request
      wakes it (~60 s) and the dashboard recovers automatically
- [ ] `git status` clean, no secrets anywhere (`git log -p | grep -E 'AKIA|AWS_SECRET'`
      returns nothing)
- [ ] Record the final public URLs and test results here.
