# ORVANTRO cloud workspace API

Implementation source and local tests are ready, but this does not mean a cloud account, production database or deployed service exists

No paid service, billing flow, external seller connector or email delivery is activated by this implementation

## Authentication and access

- Require `DB`, `ACCESS_TEAM_DOMAIN` and a distinct `PREMIUM_ACCESS_AUD`
- `PREMIUM_ACCESS_AUD` must differ from the Insights `ACCESS_AUD`
- Protect `/workspace*` and `/api/workspaces*` with the workspace Access application and its intended user policy
- Use a separate Access application and operator allowlist for `/admin*` and `/api/admin/*`
- The Worker checks the JWT signature, issuer, workspace audience, expiry and signed identity independently of the Access edge policy
- A valid workspace JWT does not grant access to Insights admin or other users' workspaces
- `verifyIdentity` returns `{subject,email}` only after cryptographic verification; `authorize` additionally enforces the operator email allowlist
- Each workspace membership is bound to both a verified subject and normalized email
- Adding a member creates a pending email-based invitation record without sending an email
- The first verified sign-in with that email binds the pending membership to the signed subject
- A later token with a different subject but the same email cannot take over that active membership
- Email/identity changes require an owner to remove and re-add membership rather than silently transferring access

The Access policy controls who can use this private beta service, not a paid subscription entitlement

| Role | Read workspace and scenarios | Create/update/delete scenarios | Rename/delete workspace | Add/change/remove members |
| --- | --- | --- | --- | --- |
| owner | Yes | Yes | Yes | Yes |
| editor | Yes | Yes | No | No |
| viewer | Yes | No | No | No |

An outsider receives `404 workspace_not_found`; a known member without the required role receives `403 role_not_allowed`

The last active owner cannot be demoted or removed, including when another owner invitation is still pending

This invariant is checked by SQLite triggers inside the write transaction so simultaneous owner changes cannot leave an orphaned workspace

## Transport contract

- Same-origin requests only, no workspace CORS allowance
- Every POST, PUT and DELETE requires the exact request-origin `Origin` header and `Content-Type: application/json`
- Every mutation body is required, including `{}` for DELETE
- Maximum body size is 8 KiB, including when no Content-Length is provided
- PUT and DELETE require `If-Match: "N"`, where N is the current positive entity version
- Missing If-Match returns `428 precondition_required`; invalid syntax returns `400 invalid_if_match`; stale versions return `412 precondition_failed`
- Return JSON errors as `{"error":"code"}` without provider errors, stack traces or request contents
- No query parameters are accepted
- Every entity ID is a server-generated UUIDv4
- Every object schema rejects unknown keys
- Responses are `Cache-Control: no-store`

Browsers add Origin automatically for same-origin JSON mutations; Access inserts the verified JWT assertion on the service request

## Routes

All paths below start with `/api/workspaces`

| Method and suffix | Request | Success |
| --- | --- | --- |
| GET | None | `{identity,workspaces,limits}` |
| POST | `{name}` | `201 {workspace}` |
| GET `/:workspaceId` | None | `{workspace,members,scenarios}` |
| PUT `/:workspaceId` | `{name}` and workspace If-Match | `{workspace}` |
| DELETE `/:workspaceId` | `{}` and workspace If-Match | `{deleted:true}` |
| GET `/:workspaceId/members` | None | `{members}` |
| POST `/:workspaceId/members` | `{email,role}` | `201 {member}` |
| PUT `/:workspaceId/members/:memberId` | `{role}` and member If-Match | `{member}` |
| DELETE `/:workspaceId/members/:memberId` | `{}` and member If-Match | `{deleted:true}` |
| GET `/:workspaceId/scenarios` | None | `{scenarios}` |
| POST `/:workspaceId/scenarios` | `{name,simulator}` | `201 {scenario}` |
| GET `/:workspaceId/scenarios/:scenarioId` | None | `{scenario}` |
| PUT `/:workspaceId/scenarios/:scenarioId` | `{name,simulator}` and scenario If-Match | `{scenario}` |
| DELETE `/:workspaceId/scenarios/:scenarioId` | `{}` and scenario If-Match | `{deleted:true}` |

Single-entity responses include an `ETag: "N"` header matching the entity version

Workspace records have `{id,name,role,version,createdAt,updatedAt}`

Member records have `{id,email,role,version,status,createdAt,updatedAt}`, with status `pending` or `active` and no exposed member subject identifier

Scenario records have `{id,name,simulator,version,createdAt,updatedAt}`

Creation and update timestamps use server time and ISO 8601 strings

Workspace child changes advance the workspace version, so a stale workspace delete cannot remove a newly edited scenario or membership

After a membership is first activated its version also advances, so the owner should reload before changing that member again

Workspace deletion permanently cascades to its members and scenarios; the UI must make that consequence clear and require an explicit user action

## Scenario schema and limits

```json
{
  "name": "기본 판매안",
  "simulator": {
    "sell": "19900",
    "cost": "6500",
    "ship": "3000",
    "ad": "1200",
    "fixed": "500",
    "feePct": "5.8",
    "units": "300",
    "targetPct": "30",
    "reservePct": "3.3",
    "reserveEnabled": false,
    "platform": "5.8"
  }
}
```

- All 11 simulator keys are required and unknown keys are rejected
- Numeric values are unsigned ordinary decimal strings with up to 6 fractional digits, not JavaScript numbers or scientific notation
- Money values are from 0 to 1,000,000,000,000
- Units are from 0 to 1,000,000,000 and may be fractional, consistent with the existing simulator
- Percentages are from 0 to 100
- Bounds are checked with scaled BigInt values, so an out-of-range value cannot round down to an allowed boundary
- Decimal strings are preserved without automatic rounding or truncation
- `reserveEnabled` is a boolean
- `platform` is one of `3.3`, `5.8`, `10.8`, `15`, `custom`
- Names are nonempty strings up to 80 characters with no control characters
- Emails have a maximum of 254 characters and are normalized to lowercase
- A user can create up to 5 workspaces
- A workspace can contain up to 50 members and 100 scenarios
- An email can have up to 50 pending or active memberships

The API limit response is `{workspacesPerCreator:5,membersPerWorkspace:50,membershipsPerEmail:50,scenariosPerWorkspace:100}`

Local MarginKit scenarios with higher precision are rejected explicitly by the cloud form instead of silently changing their calculation inputs

This service stores validated calculation inputs; it does not claim to execute seller transactions or deliver an email report

## Data and validation

Workspace tables store workspace names, creator subject identifiers, member email/subject/role records, scenario names and the validated simulator JSON plus versions and timestamps

These records are intentionally submitted cloud data and are separate from the anonymous, short-retention analytics tables

No source sales file, customer/order list, Access JWT, IP address or User-Agent is stored by this feature

Workspace records remain until explicitly deleted; no automatic expiry is claimed for these account records

All SQL values use bound parameters and every mutation rechecks the requesting membership inside its write statement

Tests use real in-memory SQLite transactions, foreign keys and triggers plus real RSA signatures, including concurrent update conflicts, cross-workspace record substitution, role revocation between reads and writes, CSRF rejection and last-owner races
