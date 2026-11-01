# ORVANTRO Insights collection service

Cloudflare Worker + D1 implementation for central pageview and browser-session measurements

This source does not provision an account, purchase a plan, create credentials or deploy a live service

## Routes

| Route | Access | Result |
| --- | --- | --- |
| `POST /collect` | Public, registered origin/site pair | Validated pageview receipt |
| `GET /api/admin/summary?range=7&site=all` | Access JWT and operator email allowlist | Central aggregate report |
| `GET /admin/` | Same operator checks | Operator assets from the `ASSETS` binding |
| `GET /api/public/summary` | Disabled unless `PUBLIC_STATS_ENABLED=true` | Deliberately published aggregates only |
| `GET /health` | Public | Process liveness only, not database or identity readiness |
| `/api/workspaces*` | Separate Access application, then per-workspace membership | Cloud workspace, roles and scenario persistence |
| `GET /workspace/` | Separate workspace Access application | Workspace UI from `ASSETS` |

Collection payload must contain exactly the following keys

```json
{"v":1,"site":"orvantro","eventId":"UUID-v4","sessionId":"UUID-v4"}
```

Both IDs must be generated with cryptographically secure random UUIDs by the browser, never an email, customer ID, IP address or fingerprint

`eventId` is one page-load ID reused for any retry; `sessionId` is a short-lived tab-session ID managed by the collector, not a permanent visitor ID

Responses are `202 {"accepted":true,"duplicate":false}`, `202 {"accepted":true,"duplicate":true}`, or an explicit error

Recognized Do Not Track or Global Privacy Control request headers return `202 {"accepted":false,"reason":"privacy_preference"}` without storing data

## Measurement meaning

- `pageviews` counts accepted, deduplicated pageview events received by this service
- `sessions` counts distinct short-lived tab identifiers separately for each registered site and each Asia/Seoul calendar day
- Sessions are not unique people; a new tab, a new session or midnight can count again, and different sites are not joined into a cross-site visitor profile
- The collector, browser privacy settings, script blockers, offline devices and delivery errors can reduce measurements
- Origin checks and CORS limit browser callers but cannot prove that a request came from a human; a non-browser sender can forge an Origin header
- No historical traffic is invented when collection is first enabled
- Missing configuration and database failures return errors, never fabricated zero-valued reports
- An initialized database with no valid events returns `status: "empty"` and `measurement.startedAt: null`

The analytics tables contain only keyed hashes of event/session IDs, a registered site, the Asia/Seoul date and a server receipt timestamp rounded to a minute

Paths are derived from the registered site, not accepted from browser URLs

No IP address, User-Agent, full URL, query string, referrer, customer file or Access JWT is retained or logged by application code

The separate workspace tables persist only the explicitly submitted workspace/scenario data and membership identity fields described in [WORKSPACE_API.md](./WORKSPACE_API.md)

Cloudflare still receives the network request as the hosting processor; provider-level request handling and Access audit records are separate from this application database

Only the last 30 calendar days appear in reports; an hourly scheduled task physically prunes at most 5,000 expired event rows per run, so a failed schedule or a large backlog can delay physical deletion

Measurement first/last receipt metadata per registered site remains after event pruning to explain the actual collection start date

## Operator security

Set all of these configuration values before enabling operator access

- `ACCESS_TEAM_DOMAIN`: the actual Cloudflare Access team domain, for example `your-team.cloudflareaccess.com`
- `ACCESS_AUD`: the audience tag from the actual Access application
- `AUTH_ALLOWLIST_EMAILS`: the exact operator emails, comma-separated
- `ANALYTICS_HASH_SECRET`: a random secret of at least 32 characters, supplied through the Worker secret mechanism rather than source or browser JavaScript

The Worker validates the Access JWT RS256 signature, issuer, audience, expiry and not-before time against the configured tenant JWKS endpoint, then checks the signed email against the operator allowlist

The `Cf-Access-Authenticated-User-Email` header alone is never sufficient

Configure Cloudflare Access for both `/admin*` and `/api/admin/*`; keep `/collect` public and prevent static asset bypass with `assets.run_worker_first: true`

The source defaults `workers_dev` and preview URLs off so an unprotected development hostname is not accidentally published; the Worker still rejects unverified operator requests independently of the Access edge policy

Do not broaden the Access policy or operator allowlist to make login work

Use relative asset URLs such as `./admin.js` from `/admin/`; `/admin` redirects to `/admin/` after authorization

The asset binding points to the staged `../public_assets` directory with separate `admin/` and `workspace/` subdirectories

The Worker maps only `/admin/`, `/admin/admin.js`, `/admin/admin.css`, `/workspace/`, `/workspace/workspace.js` and `/workspace/workspace.css`; direct fallback paths are denied

## Local validation

Run from the repository root with Node 24 or newer

```text
node --test server/tests/worker.test.mjs server/tests/premium.test.mjs
```

Tests run the migration and prepared SQL against an in-memory SQLite database, and use locally generated RSA signatures to validate real JWT checks without contacting any identity provider

`tests/support.mjs` exports `D1Database`, `env`, `token`, `now`, `fetcher` and `publicKey` for local integration tests only; never deploy that fixture or use its test signing key as production authentication

## Deployment preparation

1. Verify the actual Cloudflare account remains on the approved free Workers, D1 and Access plans
2. Create a D1 database and copy `wrangler.jsonc.example` to ignored `wrangler.jsonc`, replacing only actual returned identifiers
3. Add the real custom-domain route and configure separate admin and workspace Access applications/policies
4. Supply the hash secret using Wrangler's secret input, never in a shell argument or tracked file
5. Apply both numbered SQL files in `migrations/` through D1 migrations before deploying
6. Stage the operator and workspace assets under `../public_assets/admin/` and `../public_assets/workspace/`, then deploy using the reviewed configuration
7. Verify unauthenticated operator denial, successful operator login, a controlled test event and explicit data deletion/cleanup before connecting production collectors
8. Set the production collector endpoint only after the deployed origin and behavior have been verified

Do not activate paid Workers, paid Access, automatic upgrades or other services without the user's approval

Free Workers/D1 exhaustion causes request/query failures rather than an automatic upgrade, but the current account plan must be checked before claiming the deployment is free

Public aggregate statistics remain disabled until their exact intended disclosure is reviewed

Workspace access also remains unavailable until `PREMIUM_ACCESS_AUD` is set to a real, separate Access application audience and its policy is intentionally configured

Workspace features do not implement billing, a paid subscription entitlement, seller API ingestion or scheduled email delivery

## Official implementation references

- [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- [D1 pricing and free-tier limits](https://developers.cloudflare.com/d1/platform/pricing/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
