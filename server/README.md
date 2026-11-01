# ORVANTRO Insights collection service

Cloudflare Worker + D1 implementation for central pageview and browser-session measurements

This source does not provision an account, purchase a plan, create credentials or deploy a live service

## Routes

| Route | Access | Result |
| --- | --- | --- |
| `POST /collect` | Public, registered origin/site pair | Validated pageview receipt |
| `GET /api/admin/summary?range=7&site=all` | Verified operator identity | Central aggregate report |
| `GET /admin/` | Same operator checks | Operator assets from the `ASSETS` binding |
| `GET /api/public/summary` | Disabled unless `PUBLIC_STATS_ENABLED=true` | Deliberately published aggregates only |
| `GET /health` | Public | Process liveness only, not database or identity readiness |
| `/api/workspaces*` | Verified identity, then per-workspace membership | Cloud workspace, roles and scenario persistence |
| `GET /workspace/` | Verified team identity | Workspace UI from `ASSETS` |
| `/auth/login`, `/auth/callback`, `/auth/logout` | GitHub OAuth and server session | Sign-in and session revocation |

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

The selected deployment uses GitHub login without Cloudflare Zero Trust billing activation

Set `AUTH_PROVIDER=github`, the exact HTTPS `AUTH_ORIGIN`, the registered `GITHUB_CLIENT_ID`, and the owner's immutable numeric `AUTH_GITHUB_OWNER_ID`

Supply `GITHUB_CLIENT_SECRET` and `ANALYTICS_HASH_SECRET` only through Worker Secrets

`GET /auth/login` displays a sign-in form and its same-origin POST starts GitHub OAuth with PKCE S256 and a browser-bound, ten-minute, single-use state

The callback checks the authenticated GitHub numeric ID and the verified primary email using only `user:email` scope, then discards the provider tokens

Only the pinned owner can administer analytics or create workspaces; other users need an existing invitation to enter team workspaces and receive only their assigned roles

An eight-hour random session is stored as a hash in D1 and delivered only in a Secure, HttpOnly, SameSite=Lax host-only cookie

`GET /auth/logout` is a confirmation page and its same-origin POST revokes the current session; API callers receive 401 rather than OAuth redirects

The account's actual workers.dev hostname is permitted only when it exactly matches `AUTH_ORIGIN`; preview URLs remain disabled and all protected assets pass through the Worker first

The legacy Access provider below is retained for separately approved deployments and is not required by the GitHub configuration

For the optional legacy Access provider, set all of these configuration values

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
node --test server/tests/*.test.mjs
```

Tests run the migration and prepared SQL against an in-memory SQLite database, and use locally generated RSA signatures to validate real JWT checks without contacting any identity provider

`tests/support.mjs` exports `D1Database`, `env`, `token`, `now`, `fetcher` and `publicKey` for local integration tests only; never deploy that fixture or use its test signing key as production authentication

## Deployment preparation

1. Verify the actual Cloudflare account remains on the approved free Workers and D1 plan without enabling paid or overage billing
2. Create a D1 database and copy `wrangler.jsonc.example` to ignored `wrangler.jsonc`, replacing only actual returned identifiers
3. Register the GitHub OAuth application with the exact Worker `/auth/callback` URL, no wildcard, and configure the owner numeric ID
4. Supply the analytics hash and GitHub client secrets using Wrangler's secret input, never in a shell argument or tracked file
5. Apply all three numbered SQL files in `migrations/` through D1 migrations before deploying
6. Stage the operator and workspace assets under `../public_assets/admin/` and `../public_assets/workspace/`, then deploy using the reviewed configuration
7. Verify unauthenticated operator denial, successful operator login, a controlled test event and explicit data deletion/cleanup before connecting production collectors
8. Set the production collector endpoint only after the deployed origin and behavior have been verified

Do not activate paid Workers, paid Access, automatic upgrades or other services without the user's approval

Free Workers/D1 exhaustion causes request/query failures rather than an automatic upgrade, but the current account plan must be checked before claiming the deployment is free

Public aggregate statistics remain disabled until their exact intended disclosure is reviewed

For the GitHub provider, workspace access remains unavailable until the actual OAuth configuration is complete; if separately using Access, configure a distinct real `PREMIUM_ACCESS_AUD`

Workspace features do not implement billing, a paid subscription entitlement, seller API ingestion or scheduled email delivery

## Official implementation references

- [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- [D1 pricing and free-tier limits](https://developers.cloudflare.com/d1/platform/pricing/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
