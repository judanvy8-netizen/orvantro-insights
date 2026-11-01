# ORVANTRO 중앙 통계와 팀 작업공간 배포 안내

현재 사용자는 Cloudflare 또는 다른 서버 계정을 연결하지 않은 상태이며 이 저장소의 서버는 운영 배포되지 않음

코드와 로컬 검증이 준비되어 있어도 실제 로그인, 중앙 통계 수집, 계정 간 저장은 서버를 배포하고 아래 검증을 마친 뒤에만 사용할 수 있음

기존 MarginKit의 기기 내 Premium 도구는 서버 없이 계속 사용 가능하며 팀 작업공간과 별개의 저장소임

API, 권한, 데이터 제한, 보관 방식의 상세 계약은 [server/README.md](server/README.md)를 기준으로 확인

## 1 · 계정과 비용부터 확인

1. 사용자 소유 Cloudflare 계정과 배포할 도메인에 접근할 수 있는지 확인
2. 현재 계정의 Workers, D1, Access 요금제와 사용 한도, 결제 설정을 실제 대시보드에서 확인
3. 무료 범위로 설정 가능한지 확인한 뒤 진행하며 유료 전환·자동 업그레이드·유료 부가 기능은 비용 승인 없이 활성화하지 않음
4. 설치가 필요한 Wrangler도 사용자의 승인된 개발 도구 범위에서 준비하고 사용한 버전을 기록

이 문서는 무료 사용을 보장하거나 고정 요금을 제시하지 않음 배포 시점의 [Workers 요금](https://developers.cloudflare.com/workers/platform/pricing/), [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/), [Cloudflare One 요금제](https://www.cloudflare.com/plans/zero-trust-services/)와 실제 계정 상태를 함께 확인

## 2 · 로컬 검사와 공개 자산 준비

저장소 루트에서 Node 24 이상으로 실행

```powershell
node --version
node --test server/tests/worker.test.mjs server/tests/premium.test.mjs
node scripts/prepare-assets.mjs --dry-run
node scripts/prepare-assets.mjs
node scripts/prepare-assets.mjs --check
```

준비 스크립트는 아래 여섯 파일만 복사하며 `server/`, 설정·비밀 파일, 숨김 파일, 하위 임의 파일은 복사하지 않음

| 소스 | 생성 경로 |
| --- | --- |
| `admin/index.html`, `admin/admin.js`, `admin/admin.css` | `public_assets/admin/` |
| `workspace/index.html`, `workspace/workspace.js`, `workspace/workspace.css` | `public_assets/workspace/` |

모든 입력을 읽고 검증한 다음 출력 폴더를 다시 생성함 소스와 출력의 심볼릭 링크·정션을 거부하며 정리 전에 최종 절대경로가 저장소 안의 `public_assets`인지 확인

`public_assets`에 허용 목록 밖의 파일이 있으면 삭제하지 않고 중단함 해당 파일을 직접 확인한 뒤 처리해야 하며 경로 검사를 약화해 우회하지 않음

생성 결과만 정리하려면 아래 명령 사용

```powershell
node scripts/prepare-assets.mjs --clean
```

`server/wrangler.jsonc.example`의 `assets.directory`는 `../public_assets`이며 저장소 루트나 `server/`를 정적 자산 경로로 지정하지 않음

## 3 · D1과 비공개 설정

실제 계정 연결과 무료 범위 확인 후 `server` 디렉터리에서 진행

```powershell
Set-Location server
if (Test-Path -LiteralPath wrangler.jsonc) { throw '기존 설정이 있어 복사를 중단합니다 예제와 비교한 뒤 직접 수정하세요' }
Copy-Item -LiteralPath wrangler.jsonc.example -Destination wrangler.jsonc
npx wrangler login
npx wrangler d1 create orvantro-insights
```

이미 `wrangler.jsonc`가 있으면 복사로 덮어쓰지 말고 기존 설정과 예제를 비교

생성 명령이 반환한 실제 D1 ID를 `wrangler.jsonc`에 넣고 사용자 소유 도메인의 실제 Worker 경로를 설정 예제의 `REPLACE_WITH_...` 값으로 배포하지 않음

| 설정 | 필요한 실제 값 |
| --- | --- |
| `DB` 바인딩 | 이번 배포에 사용할 D1 데이터베이스 |
| `ACCESS_TEAM_DOMAIN` | 사용자 계정의 Access 팀 도메인 |
| `ACCESS_AUD` | 운영자용 Access 애플리케이션 audience |
| `PREMIUM_ACCESS_AUD` | 팀 작업공간용 별도 애플리케이션 audience |
| `AUTH_ALLOWLIST_EMAILS` | 통계 운영자로 허용한 정확한 이메일 |
| `PUBLIC_STATS_ENABLED` | 처음에는 `false` 유지 |

해시 비밀값은 안전한 비밀번호 생성기로 만든 32자 이상의 임의값을 Wrangler 비밀 입력으로 등록 명령 인수, 소스, 브라우저 JavaScript, 공유 로그에 넣지 않음

```powershell
npx wrangler secret put ANALYTICS_HASH_SECRET
```

`wrangler.jsonc`, `.dev.vars*`, `.env*`, `.wrangler/`, 생성된 `public_assets/`는 Git에서 제외됨 배포 전 `git status`와 변경 내용을 확인하고 비밀값이 이미 추적된 파일에 들어가지 않았는지도 확인

## 4 · 마이그레이션

운영 DB와 로컬 DB를 구분하고 실제 대상 이름·ID를 확인한 뒤 순서대로 적용

```powershell
npx wrangler d1 migrations list orvantro-insights --local
npx wrangler d1 migrations apply orvantro-insights --local
npx wrangler d1 migrations list orvantro-insights --remote
npx wrangler d1 migrations apply orvantro-insights --remote
```

현재 마이그레이션은 `0001_analytics.sql`과 `0002_workspaces.sql`이며 번호 순서대로 모두 적용해야 함 기존 DB에 적용할 때는 먼저 복구 가능한 백업과 이전 배포를 확보하고 적용된 SQL 파일은 수정하지 않음

명령은 [D1 마이그레이션 공식 안내](https://developers.cloudflare.com/d1/reference/migrations/)와 현재 Wrangler 도움말을 함께 확인 대상 DB를 잘못 선택한 상태에서 재시도하지 않음

## 5 · 운영자와 작업공간 인증 분리

Access 애플리케이션을 최소 두 개로 분리

| 용도 | 보호 경로 | 서버 검증 |
| --- | --- | --- |
| 통계 운영자 | `/admin*`, `/api/admin/*` | `ACCESS_AUD` JWT와 운영자 이메일 허용 목록 |
| 팀 작업공간 | `/workspace*`, `/api/workspaces*` | `PREMIUM_ACCESS_AUD` JWT와 작업공간별 멤버·역할 |

두 audience 값은 달라야 함 일반 작업공간 사용자를 통계 운영자 허용 목록에 넣지 않으며 작업공간 토큰으로 운영자 API를 호출할 수 없어야 함

각 Access 정책은 필요한 사용자 또는 그룹만 허용 인증 실패를 해결하려고 `Everyone`, 우회 정책 또는 공유 비밀로 보호를 제거하지 않음

서버는 JWT 서명·발급자·audience·만료를 검증하며 이메일 헤더만 신뢰하지 않음 [Access JWT 검증 공식 안내](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

`/collect`는 로그인 없는 수집 경로로 유지하되 등록된 사이트·Origin과 입력 스키마 검사 적용 `assets.run_worker_first: true`를 유지해 정적 `/admin/` 또는 `/workspace/` 경로로 인증을 우회할 수 없도록 함

`workers_dev: false`, `preview_urls: false`를 유지하고 다른 공개 별칭·미리보기 URL로 운영자 자산이 노출되지 않는지 확인

## 6 · 서버 배포와 실제 합성 확인 1회

저장소 루트에서 자산 준비·검사를 다시 실행한 후 `server`에서 검토한 설정으로 배포

```powershell
npx wrangler deploy
```

실제 운영 데이터나 고객 정보를 쓰지 않는 하나의 통제된 검증 세션을 진행

1. 로그인하지 않은 `/admin/`, `/api/admin/summary`, `/workspace/`, `/api/workspaces` 접근이 로그인 또는 명시적 거부로 끝나는지 확인
2. 운영자 계정으로 통계 화면을 열고 초기 DB가 빈 상태와 연결 오류를 서로 다르게 표시하는지 확인 `/health` 성공만으로 DB와 인증이 준비됐다고 판단하지 않음
3. 합성 UUID-v4 `eventId`와 `sessionId` 하나로 허용된 사이트의 `/collect` 요청을 전송 수신 1건과 운영자 집계 증가를 확인 같은 `eventId`로 한 번 재전송해 중복으로 추가되지 않는지도 확인
4. 별도 작업공간 계정으로 합성 이름의 작업공간·시나리오 하나를 저장하고 새로고침·다른 로그인 세션에서도 서버 기록이 조회되는지 확인 운영자 토큰과 작업공간 토큰을 바꾸면 해당 API가 거부되는지도 확인
5. 서로 다른 권한으로 허용된 조회·편집 범위와 다른 작업공간의 격리를 확인 마지막 소유자 보호·동시수정 충돌 등 상세 항목은 서버 테스트와 README를 따름
6. 검증용 작업공간·시나리오와 이벤트 정리 범위를 기록 실제 고객 기록이 섞이지 않은 시험 DB를 우선 사용하며 정리 때문에 운영 DB 전체를 삭제하지 않음 측정 시작 메타데이터가 남을 수 있으므로 합성 검증 시각도 기록

이 확인은 실제 배포 환경에서 수행한 뒤에만 완료라고 기록 현재 로컬 테스트 통과를 실제 인증·전송 성공으로 대체하지 않음

## 7 · 홈페이지·MarginKit·Insights 연결

실제 서버 검증 후 각 사이트의 `central-config.js`를 따로 설정

- `ORVANTRO_CENTRAL.site`는 기존 사이트 식별자 유지
- `endpoint`는 검증된 서버의 정확한 HTTPS `/collect` 주소로 설정 쿼리·해시·사용자 정보는 포함하지 않음
- 수집 준비가 끝난 사이트만 `enabled: true`로 변경
- 각 HTML CSP의 `connect-src`에 그 서버의 정확한 HTTPS Origin만 추가 `*` 또는 전체 `https:` 허용으로 넓히지 않음
- 서버 `SITES`의 사이트·Origin 짝과 실제 사이트 도메인이 일치하는지 확인 GitHub Pages의 두 경로는 같은 Origin을 사용하므로 Origin만으로 제품을 구분했다고 주장하지 않음
- Insights의 중앙 화면 URL과 MarginKit의 작업공간 연결 URL은 검증된 서버 주소를 각각 지정 실제 설정 키와 엔드포인트는 현재 클라이언트 설정 파일과 서버 README 확인

사용자가 켠 동의와 브라우저 추적 방지 정책을 존중하며 연결 완료 전에 이전 방문 수를 만들어 넣지 않음 중앙 수집은 기존 로컬 진단 기록을 업로드하거나 소급 집계하지 않음

팀 로그인 연결만으로 판매 채널 API 자동 수집이나 예약 이메일이 생기지는 않음 해당 기능은 별도 채널·메일 제공자 인증과 서버 작업 구성이 필요하며 비용 승인 없이 추가 서비스를 연결하지 않음

## 8 · 원복

1. 문제 발생 사이트의 `ORVANTRO_CENTRAL.enabled`를 `false`로 되돌리고 수집 endpoint·중앙 화면·작업공간 연결 주소를 비워 정적 사이트를 재배포
2. CSP에서 추가한 수집 서버 Origin만 제거하고 기존 허용 항목은 유지
3. Access 정책을 열어 우회하지 말고 필요한 경우 해당 경로 접근을 차단 Worker는 검증된 이전 버전으로 되돌리되 현재 DB 스키마와 호환되는지 먼저 확인
4. 마이그레이션 SQL을 지우거나 역순 실행해 데이터를 복구하려 하지 않음 서버 버전 원복은 DB 내용을 자동으로 되돌리지 않으므로 백업·복구 절차를 별도로 검토
5. 로컬 Premium 저장 데이터는 이 원복에서 삭제하지 않음 서버 DB·Access 앱·비밀값 삭제는 실제 데이터와 영향 범위를 확인한 별도 작업으로 수행

배포 기록에는 커밋, 자산 검사 결과, 실제 도메인, 적용 마이그레이션, 요금제 확인 시각, 합성 검증 결과, 이전 정상 배포 식별자를 남기되 토큰·비밀값은 기록하지 않음
