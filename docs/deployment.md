# AstraGrid AI — AWS-Native Deployment Proposal (ap-south-2) — **ON HOLD, NOT DEPLOYED**

> **Status (2026-10-21): superseded for now by the $0 free-hosting plan in
> `docs/deployment-free.md`** (Cloudflare Pages + Render). Nothing in this file
> was ever deployed, and the Amplify + HTTP API + Lambda resources described
> here will **not** be deployed unless you explicitly approve reviving this
> proposal. Do not run `cdk deploy` while the free plan is active. The verified
> ap-south-2 unit prices in §7 remain useful reference material.

This document is the **final deployment proposal** for hosting AstraGrid AI on AWS.
It records the exact infrastructure diff, the Lambda-compatible API plan, verified
monthly costs, the public-endpoint security posture, and the rollback plan.
**Nothing in this document has been deployed yet** — deployment starts only after
explicit approval of this proposal.

Region: **ap-south-2 (Hyderabad)** — unchanged, matching the existing stack.
Account: `682047236179`. Prepared: 2026-10-21.

---

## 1. Critical finding: Lambda Function URLs are not available in ap-south-2

The originally approved backend host was **AWS Lambda + Function URL**. Evidence
gathered on 2026-10-21 shows the feature is **not available in ap-south-2**:

| Evidence | Result in ap-south-2 | Control (us-east-1) |
| --- | --- | --- |
| `lambda CreateFunctionUrlConfig` (any function) | `AccessDeniedException: Unable to determine service/operation name to be authorized` | n/a |
| `lambda GetFunctionUrlConfig` | same error | `ResourceNotFoundException` (operation works) |
| `lambda ListFunctionUrlConfigs` | same error | works |
| CDK 2.273.0 CloudFormation validation | `Resource type 'AWS::Lambda::Url' does not exist in 'ap-south-2'` | no warning |

The caller holds `AdministratorAccess`, so this is **not** an IAM policy problem —
the regional Lambda endpoint does not implement the Function URL operations, and
CloudFormation has no `AWS::Lambda::Url` type in this region. Independent sources
also list ap-south-2 among the regions without Function URLs.

**Proposed equivalent (this proposal): AWS Lambda + API Gateway HTTP API.**

- Same serverless, scales-to-zero, same Lambda, same IAM, same region.
- Verified available: `apigatewayv2 get-apis --region ap-south-2` succeeds.
- HTTP APIs invoke Lambda with **payload format 2.0** — exactly the event shape
  the prepared handler (`apps/api/src/lambda.ts`) is written for.
- Cost is comparable to a Function URL at demo scale (see §7).

Rejected alternatives: Function URL in another region (breaks the ap-south-2
constraint and adds cross-region DynamoDB access), App Runner (closed to new
customers since 2026-04-30), Fargate + ALB (~$25–30/mo, always-on worker-like
cost, against condition 5).

---

## 2. Route compatibility plan (condition 2 — verified, no assumptions)

The Express server **cannot** run on Lambda as-is (it calls `app.listen()` and
runs a long-lived process). It was therefore refactored so the local server and
the Lambda share one code path:

```text
apps/api/src/app.ts    NEW  createApp(): all routes, CORS, validation, error
                            handling — moved verbatim from index.ts
apps/api/src/index.ts  slim local entry: createApp() + app.listen()
apps/api/src/lambda.ts NEW  Lambda entry: createApp() once per cold start,
                            exported handler = @codegenie/serverless-express
                            bridge (adapter for payload v2.0 events)
```

Adapter: **`@codegenie/serverless-express` 4.17.1** (maintained successor of
`@vendia/serverless-express`), bundled by the CDK via esbuild. No route was
rewritten; no behavior was changed.

### Route-by-route status

| Route | Method | Lambda path | Verified |
| --- | --- | --- | --- |
| `/api/health` | GET | same app | ✅ 200 `{data:{status:"ok"}}` |
| `/api/sensors` | GET | same app | ✅ code path; live check post-deploy |
| `/api/sensors/:sensorId` | GET | same app | ✅ code path; 404 contract preserved |
| `/api/readings` | POST | same app | ✅ validation 400s + body parsing verified |
| `/api/zones` | GET | same app | ✅ code path |
| `/api/incidents` | GET | same app | ✅ code path |
| `/api/dashboard` | GET | same app | ✅ 503 contract on data failure verified |
| unknown route | any | same 404 handler | ✅ 404 `NOT_FOUND` |
| CORS preflight OPTIONS | any | `cors` middleware answers | ✅ 204 + headers |

**Verification performed before this proposal (no deployment):**

1. `npm run typecheck` and `npm run build` pass in all four workspaces.
2. `cdk synth` succeeds; the Lambda asset bundles (881 KB bundle).
3. **10/10 runtime tests** invoke the real handler with synthetic HTTP API
   (payload v2.0) events: health 200, allowed-origin CORS header present,
   foreign-origin header absent, no-Origin caller allowed, preflight 204,
   404, malformed JSON 400, invalid reading 400, data-failure 503 ×2.
4. **Parity test**: the same requests against the local server
   (`node dist/index.js`) returned identical statuses, headers, and payloads.
5. Tests used a **dummy table name**, so the real table was never written to.

---

## 3. What the CDK diff contains (condition 6) — exact

`cd infra && npx cdk diff` against the **live stack** (read-only change set) shows:

### Resources added (all new — nothing replaced, nothing deleted)

```
[+] AWS::Logs::LogGroup              ApiLambdaLogGroup
[+] AWS::IAM::Role                   AstraGridApiLambdaRole
[+] AWS::IAM::Policy                 AstraGridApiLambdaRole/DefaultPolicy
[+] AWS::Lambda::Function            AstraGridApiLambda          (nodejs24.x, arm64, 512 MB, 30 s)
[+] AWS::ApiGatewayV2::Api           AstraGridHttpApi            (public HTTPS, no auth)
[+] AWS::ApiGatewayV2::Integration   .../DefaultRoute/AstraGridApiIntegration
[+] AWS::Lambda::Permission          .../AstraGridApiIntegration-Permission
[+] AWS::ApiGatewayV2::Route         AstraGridHttpApi/DefaultRoute   ($default ANY → Lambda)
[+] AWS::ApiGatewayV2::Stage         AstraGridHttpApi/DefaultStage   (throttle 25 rps / 50 burst)
[+] Output                           AstraGridApiEndpoint        (public base URL)
[+] Output                           AstraGridApiHealthEndpoint  (<base>/api/health)
```

### The only change to an existing resource

```
[~] AWS::Lambda::Function AstraGridDetectionLambda
    └─ [~] Code.S3Key  (zip hash changes; packaging timestamps only)
```

**Proven benign:** the deployed package was downloaded from Lambda and compared
byte-for-byte with a fresh bundle — `index.js` sha256 is identical
(`bdcc824f32a7e5d243ae3cd6e720a5ea157e88666088998c69d779bceb0341c9`), so the
update re-uploads identical code (in-place update, no replacement, no behavior
change). The detection Lambda's **runtime stays `nodejs20.x`** — untouched.

### Untouched (condition 1)

DynamoDB table + GSI1 + stream, `AstraGridDetectionLambda` code/runtime/role,
EventBridge bus + rule, `/aws/events/astragrid-anomalies`, and both existing log
groups are not modified. No resource is replaced or deleted anywhere in the diff.

### IAM added (least privilege, condition 4)

| Principal | Action | Resource |
| --- | --- | --- |
| `AstraGridApiLambdaRole` | `logs:CreateLogStream`, `logs:PutLogEvents` | its own log group only |
| `AstraGridApiLambdaRole` | `dynamodb:Query, BatchGetItem, PutItem, UpdateItem, TransactWriteItems` | the operational table **+ its indexes only** |
| `apigateway.amazonaws.com` | `lambda:InvokeFunction` | the API Lambda, conditioned on this API's execute-api ARN |
| `lambda.amazonaws.com` | `sts:AssumeRole` | new role (standard trust) |

Exactly the five DynamoDB actions the repository issues (verified by enumerating
every command in `dynamodb-operational-repository.ts`). No `Scan`, no
`DescribeTable`, no stream reads, no EventBridge, no `Resource: "*"`, no keys.

New function runtime is **nodejs24.x**: `nodejs20.x` stops accepting *new*
functions on 2027-02-01 (and updates on 2027-03-03), which would block future
redeploys and rollbacks. The existing detection function keeps nodejs20.x and
should be migrated separately later (requires its own approval).

---

## 4. Architecture

```text
  Browser ──HTTPS──▶ AWS Amplify Hosting (static SPA)
             │        https://<app-id>.amplifyapp.com
             │        env: VITE_API_URL (public, not a secret)
             ▼
  GET {VITE_API_URL}/api/...
             │
             ▼
  API Gateway HTTP API (public HTTPS, $default stage, throttled 25 rps)
             │  payload v2.0
             ▼
  AstraGridApiLambda  (nodejs24.x, arm64, 512 MB, 30 s, no VPC)
     handler: apps/api/src/lambda.ts → shared Express app (app.ts)
     env: ASTRAGRID_TABLE_NAME, ALLOWED_ORIGINS=<amplify origin>
     creds: execution role only — no keys anywhere
             │
             ▼
  DynamoDB single table (UNCHANGED; stream NEW_AND_OLD_IMAGES)
             │ stream INSERT/MODIFY
             ▼
  AstraGridDetectionLambda (UNCHANGED) ──▶ EventBridge astragrid-events
                                            └─▶ /aws/events/astragrid-anomalies (UNCHANGED)

  Sensor simulator: optional local process (condition 5) — never an AWS worker.
  ML package: offline only, not hosted.
```

---

## 5. Environment variables

### Frontend (Amplify Hosting → Environment variables)

| Name | Secret? | Value |
| --- | --- | --- |
| `VITE_API_URL` | **No** — baked into the public bundle | `https://<api-id>.execute-api.ap-south-2.amazonaws.com` |

Only this variable belongs in the frontend. AWS credentials, table names of an
administrative kind, or any key are **never** placed in `VITE_*` variables —
everything there is readable by anyone.

### Backend (set by CDK on the function — not committed)

| Name | Source | Secret? |
| --- | --- | --- |
| `ASTRAGRID_TABLE_NAME` | CloudFormation reference to the existing table | No |
| `ALLOWED_ORIGINS` | `cdk deploy -c amplifyOrigin=https://<app-id>.amplifyapp.com` | No |
| `AWS_REGION` | injected by Lambda (`ap-south-2`) | No |

Fail-closed default: deploying **without** the `-c amplifyOrigin` flag leaves CORS
restricted to `http://localhost:5173`, i.e. browsers on the Amplify origin would
be blocked — a broken demo, never an open CORS policy.

---

## 6. Deployment order (after approval)

```sh
# 1. Push the repository (commits: adapter refactor, CDK additions, docs,
#    amplify.yml, .nvmrc) to GitHub → branch main.

# 2. Amplify Hosting → Create app → deploy from repository
#    temujin1893/astragrid-ai, branch main, build spec: committed amplify.yml.
#    Result: https://<app-id>.amplifyapp.com  (app shows "API URL not
#    configured" until step 4 — an intentional, handled state).

# 3. Backend deploy with the frontend origin:
cd infra
npx cdk diff -c amplifyOrigin=https://<app-id>.amplifyapp.com   # expect: additions only
npx cdk deploy AstraGridStack -c amplifyOrigin=https://<app-id>.amplifyapp.com
#    Note outputs: AstraGridApiEndpoint, AstraGridApiHealthEndpoint

# 4. Amplify → Environment variables → VITE_API_URL=<AstraGridApiEndpoint>
#    (triggers a rebuild automatically)

# 5. Amplify → Rewrites and redirects:  </.*>  →  /index.html  (200 rewrite)
```

---

## 7. Estimated monthly costs (condition 6)

All unit prices were queried live from the **AWS Price List API for
ap-south-2** (2026-10-21), not estimated from memory.

### Unit prices verified (ap-south-2)

| Service | Price |
| --- | --- |
| Lambda requests (arm64) | $0.20 per million |
| Lambda duration (arm64) | $0.0000106667 per GB-second (first tier) |
| API Gateway HTTP API | **$0.95 per million requests** (first 333M tier) |
| CloudWatch Logs ingestion | $0.50 per GB (first 10TB) |
| DynamoDB (existing) | $0.1425/M read units, $0.71/M write units |
| DynamoDB Streams (existing) | 2.5M stream read units **free**/month |
| Amplify Hosting | **1,000 build minutes free/month**, then $0.01/min; artifacts $0.023/GB-mo; data served $0.15/GB |
| Data transfer out (approx.) | ≈$0.09/GB after the monthly free allowance |

### Free-tier assumptions

- **Lambda**: always-free 1M requests + 400K GB-s per month (not time-limited).
- **Amplify**: 1,000 build minutes per month at no cost (official pricing page).
- **HTTP API**: **no free tier** — this is the main variable charge.
- **DynamoDB Streams**: first 2.5M read units/month free (existing pipeline).

### Scenario A — everything on 24/7 (worst realistic case)

Dashboard polled every 5 s (~518K GETs/mo) + optional simulator every 3 s
(~864K POSTs/mo) = ~1.38M requests:

| Item | Calculation | Cost |
| --- | --- | --- |
| HTTP API | 1.38M × $0.95/M | $1.31 |
| Lambda requests | 1M free, 0.38M × $0.20/M | $0.08 |
| Lambda duration | ~150K GB-s « 400K free | $0.00 |
| API log group | ~30 MB × $0.50/GB + storage | $0.03 |
| Amplify | ≤10 builds × ~6 min « 1,000 free; ~1 GB artifacts; ~1 GB served | $0.00–0.19 |
| **New total** | | **≈ $1.40 – 1.60 / month** |

### Scenario B — typical interview demo (occasional)

| Item | Cost |
| --- | --- |
| HTTP API (~100K requests) | ≈ $0.10 |
| Lambda | $0 (within always-free tier) |
| Logs + Amplify | ≈ $0.05 |
| **New total** | **≈ $0.15 / month** |

### Existing resources (unchanged, already billing) — condition 1

DynamoDB on-demand ≈ $0–1.50 (depends on simulator cadence), detection Lambda ≈ $0
(free tier), EventBridge + existing log groups ≈ pennies → **≈ $0–2/month**, same
as before this deployment.

No NAT gateway, ALB, RDS, or always-on compute is added (condition 5).

---

## 8. Public endpoint security configuration (condition 4)

### What is public and why that matters

The HTTP API endpoint is **public and unauthenticated** (`authType` = none, like
the originally approved Function URL would have been). Implications — for a
Function URL and for this HTTP API alike:

1. **Anyone who learns the URL can invoke the API.** The URL is not a secret and
   can show up in browser dev tools, logs, or shared links. Non-browser clients
   (curl, scripts) are **not** affected by CORS — CORS is a browser-only
   mechanism, not authentication.
2. **Consequences are bounded:**
   - Reads expose only simulated demo data (no PII, no secrets, no AWS details).
   - Writes go through strict validation (registered sensor IDs/zones, finite
     non-negative values, 16 KB body cap) and only touch the demo table.
   - Cost abuse is capped: stage throttle **25 req/s, 50 burst** → beyond it the
     API returns 429, bounding Lambda/API spend even under a flood. 30 s timeout,
     generic error payloads (no stack traces), one-month log retention.
   - IAM caps blast radius: the function can only `Query/BatchGet/Put/Update/
     TransactWrite` **this one table and its indexes** — nothing else in the
     account, no stream reads, no EventBridge, no admin actions.
3. **Residual risk to accept or mitigate:** an unauthenticated caller who guesses
   a sensor ID can post a fake reading (it would appear on the dashboard and may
   trigger the deterministic rule pipeline). For a demo of simulated data this is
   acceptable; if it ever matters, add an HTTP API API-key/jwt authorizer or move
   behind Cognito (documented as future work — note a key embedded in a `VITE_*`
   variable is public by definition).

### CORS restricted to the Amplify origin (single owner, no duplicates)

- The **Express app** owns CORS: `ALLOWED_ORIGINS` = the exact Amplify origin.
  Browser requests from any other origin receive **no**
  `Access-Control-Allow-Origin` header (verified by tests), so the browser blocks
  reading the response. Non-browser callers (curl, the simulator) send no Origin
  and pass through, unchanged from current behavior.
- The gateway deliberately does **not** also emit CORS headers: AWS documents that
  when both the gateway and the function return CORS headers, browsers reject the
  response ("header contains multiple values"). Exactly one layer owns the policy.
- Preflight `OPTIONS` reaches the Lambda and is answered by the `cors` middleware
  (verified: 204 + correct headers).

### Secrets posture

- No AWS keys/secrets in the repo, in `VITE_*` vars, or in function env; `.env`
  is gitignored; the Lambda uses its execution role via the SDK default chain.
- The browser receives only a public HTTPS URL.

---

## 9. Rollback plan (condition 6)

Everything deployed here is **additive**, which makes rollback clean:

1. **Frontend**: Amplify console → the app’s deployment history → roll back to
   the previous successful build (one click), or `git revert` + push → automatic
   rebuild. Remove/blank `VITE_API_URL` to force the "API URL not configured"
   state.
2. **Backend**: `git revert` the infra commit, then
   `cd infra && npx cdk deploy AstraGridStack -c amplifyOrigin=...`.
   CloudFormation deletes **only** the new resources (HTTP API, API Lambda, role,
   log group). The table, stream, detection Lambda, EventBridge bus/rules, and
   existing log groups are untouched by both deploy and rollback.
3. **Mid-deploy failure**: CloudFormation leaves the stack in its last complete
   state; a failed changeset does not partially delete anything. Re-run the
   deploy or roll back from the CloudFormation console.
4. **Emergency stop of the public API without deleting resources**: set the stage
   throttle to 1 rps / 1 burst (console or CDK) — traffic returns 429 while all
   resources remain for inspection.
5. **Detection pipeline**: unaffected by deploy and rollback (its code bytes are
   proven unchanged); no stream checkpoints or event-bus state is modified.

---

## 10. Post-deployment verification (conditions 7 & 8)

The app is **not** claimed live until every item passes:

- [ ] `curl https://<api-id>.execute-api.ap-south-2.amazonaws.com/api/health`
      returns `{"data":{"status":"ok",...}}` over HTTPS.
- [ ] Frontend URL loads; dashboard renders (not the "not configured" state).
- [ ] Dashboard shows live sensor values from the **public** API (browser dev
      tools: request to execute-api host, response readable → CORS correct).
- [ ] Start the optional simulator once:
      `API_URL=https://<api-id>... npm run dev:simulator` →
      `GET /api/sensors` shows updated values; KATPADI water ≥ 90 cm creates an
      ACTIVE incident visible in the dashboard; stop the simulator afterwards.
- [ ] DynamoDB: new READING items present (7-day TTL intact), GSI1 queries work.
- [ ] Pipeline: `/aws/lambda/AstraGridDetectionLambda` logged an invocation for
      that stream record, and `/aws/events/astragrid-anomalies` contains the
      matching `SensorAnomalyDetected` event (both in ap-south-2).
- [ ] CORS negative check: `curl -H "Origin: https://evil.example" <api>/api/health`
      → response has **no** `Access-Control-Allow-Origin`.
- [ ] Re-run `npm run typecheck && npm run build` (green) and record final URLs,
      commands, and results in this file.

---

## 11. Summary of changed files (all committed, nothing hidden)

| File | Change |
| --- | --- |
| `apps/api/src/app.ts` | NEW — shared Express factory (routes/CORS/errors moved verbatim) |
| `apps/api/src/index.ts` | slimmed to local server entry |
| `apps/api/src/lambda.ts` | NEW — Lambda handler via serverless-express |
| `apps/api/package.json` | + `@codegenie/serverless-express`, + `@types/aws-lambda` |
| `infra/src/stack.ts` | + API Lambda, role, log group, HTTP API, throttle, outputs, `amplifyOrigin` context |
| `amplify.yml`, `.nvmrc` | Amplify build spec (monorepo → `apps/web/dist`), Node 20 pin |
| `apps/web/src/main.tsx`, `styles.css` | production `VITE_API_URL` gating, offline/not-configured states |
| `docs/deployment.md` | this document |
