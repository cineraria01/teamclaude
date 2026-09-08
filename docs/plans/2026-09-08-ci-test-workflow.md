---
status: APPROVED
created: 2026-09-08
approved_by: user
scope: "기존 CI 진행 위임의 인수인계 실행"
restate: "실제 테스트 결과를 표시하는 CI와 배지를 완성한다."
acceptance_criteria:
  - id: AC1
    desc: "전체 Node 테스트 통과"
    verifier: "node --test --test-concurrency=1"
    status: passed
  - id: AC2
    desc: "모델 복구 evidence 검증 통과"
    verifier: "python3 -m unittest discover -s test -p test_model_recovery_gate.py -v"
    status: passed
constraints:
  - "실패 테스트 삭제·약화 금지"
  - "운영 계정과 서비스 변경 금지"
out_of_scope:
  - "npm 배포"
  - "운영 런타임 배포"
---

# 테스트 CI와 자동 배지 실행 계획

Spec: docs/specs/2026-09-08-ci-test-workflow.md

1. 완료: 인계 원문 사용자 의도, clean 워크트리, PR #34 OPEN, 최신 기본 브랜치 PR #33 통합 확인.
2. 완료: 깨끗한 환경에서 CLI 실패와 느린 lsof·한글 경로 변환을 재현. Claude 추가 조사는 풀 제한으로 미검증.
3. 완료: 날짜 로케일·lsof 조회 수정, SHA evidence 갱신, Actions workflow와 README 배지 연결.
4. 완료: 변경분 정리, 독립 CLI/API QA 28/28, Ubuntu 전체 테스트 860/860 통과. 아래 실행별 근거와 로컬 검증 한계를 구분한다.
5. 공개 반영: 공식 독립 검토와 로컬 전체 재실행을 마친 뒤 PR #34를 머지하고 기본 브랜치 Actions·배지를 관찰한다. 실제 머지·최종 실행 상태는 [PR #34](https://github.com/sangrokjung/teamclaude/pull/34)와 비공개 인수인계에 기록한다.

## Verification

- 시작 HEAD: `5cc7cd5bf7a5753e236cf2c89a1062b3d766c71a`.
- 통합한 기본 브랜치: `09de69e` (PR #33).
- qgate 최초 baseline 티켓은 stdin 스크립트 전달 방식이 detach 실행에 맞지 않아 시작 전 취소했다. 테스트 증거로 사용하지 않는다.
- 추가 Claude 조사: `--model fable --effort xhigh` 호출을 실제 실행했으나 계정 풀 제한으로 exit 1. UNVERIFIED.

## 원인 조사 기록

- 가설 1(로케일): `LC_ALL=C`에서 `한글경로`가 macOS `ps` 출력의 vis escape로 변환됨. `LC_ALL=''`, `LC_TIME=C`, 기존 유효 `LC_CTYPE` 보존 시 날짜는 POSIX·경로는 한글 그대로 관찰.
- 가설 2(시간 예산): 로컬 `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` 1.656초, 동일 조회에 `-b` 추가 시 0.081초. 양쪽 모두 동일한 실제 리스너 PID를 반환. 기본 프로브 시간 1.5초를 초과해 lifecycle 검증이 생략됨.
- 가설 3(환경 오염): `TEAMCLAUDE_PROVIDER`, `TEAMCLAUDE_SESSION_SUPERVISED`, `TEAMCLAUDE_CLAUDE_BIN`이 상속됨. 제거한 재현에서도 느린 lsof로 CLI remove의 'restart' 안내를 관찰하여 환경만이 원인은 아님을 확인.
- 추가 Claude 조사 1차: exit 1, `is_error=true`, modelUsage 없음. 계정 풀 제한으로 UNVERIFIED. 동일 Fable 설정 재시도에서도 같은 제한을 확인했다.

## 구현 검증

- 회귀 재현: 한글 경로와 느린 lsof 조건에서 CLI remove 테스트가 수정 전 exit 1 (`Applied...` 누락), 수정 후 exit 0 (1/1)로 전환됐다.
- 실제 CLI/API: 한국어 로케일·한글 symlink 경로에서 help/status/priority/disable/enable/remove 성공. 잘못된 remove는 exit 1 + Usage 안내. 인증된 status로 계정 목록과 supervisor/worker PID 보존 확인. 임시 서버 종료·설정 정리 완료.
- `node --check` 대상 JS 4개, ESLint 9 대상 4개, actionlint workflow, `git diff --check`: exit 0.
- SHA evidence 단일 Python 테스트: 1/1 PASS.
- 전체 테스트 1차: 860개 중 859 PASS / 1 FAIL. 구독 hot-reload 테스트의 고정 종료일이 이미 지나 상태 기대값과 달라졌다. 날짜 fixture 수정 후 전체 재실행을 qgate에 제출했다.
- 정리 패스: 기존 로케일 테스트의 중복 설명을 줄이고, 추가된 회귀는 기존 assertion을 보존·강화했다. 테스트나 assertion 삭제·완화 없음.
- Claude 조사 재시도: exit 1, is_error=true, modelUsage 없음. 풀 제한 지속, UNVERIFIED.

- 로컬 운영 watchdog 비교는 실패했다. 설치본의 로컬 전용 기본값이 공개 코드와 다르며 운영본 수정은 범위 밖이다. 전체 테스트·gate는 지원되는 `CODEX_WATCHDOG_DEPLOYED_PATH`로 고정된 기본 브랜치 비교 파일을 지정한다. 이 결과를 실제 운영본 일치 증거로 해석하지 않는다.

## 날짜 의존 회귀 수정

- `test/subscription-supervisor.test.js`의 고정 종료일은 실행일 이후로 유지되지 않았다. `subscriptionSnapshot`을 실제 호출해 과거 종료일이 `end-date-reached`를 반환함을 확인했다.
- 종료일을 실행일 기준 7일 뒤로 만들었다. KST 날짜의 UTC `15:00:00.000Z` 변환, 취소 예약/해제, worker PID 유지, 자격증명 비노출 assertion은 그대로 유지했다.
- 수정 후 해당 통합 테스트 1/1 PASS, `node --check`, ESLint 9, `git diff --check` PASS. LSP는 응답 시간 초과로 결과를 확보하지 못했다.
- 날짜 변경분 정리 검토: 공유 변수 외 추상화나 중복이 없어 추가 변경 없음.
- 기존 고정 커밋의 goal/code/security 소스 검토는 PASS였다. 날짜 변경 후 최종 커밋의 재검토와 QA/context 검토는 별도로 수행한다.
- Claude 추가 구현 검증과 날짜 원인 조사도 동일 Fable 설정으로 실제 실행했으나 계정 풀 제한으로 exit 1, `is_error=true`, modelUsage 없음. PASS로 소비하지 않는다.
- 첫 전체 실행이 남긴 임시 supervisor는 작업 경로·PID·시작 시각을 확인하고 종료했다.

## 검증 실행 환경과 리뷰 전송

- 두 번째 전체 실행은 호스트 load1 51.80으로 qgate hard limit 48.0에 걸려 exit 75로 중단됐다. 통과로 집계하지 않는다. 그 실행의 `run-recovery` 임시 디렉터리 `ENOTEMPTY`는 단독 재실행에서 통과했고 전체 재시도를 큐에 유지했다.
- 기존 Python 전체 verifier는 격리 환경에서 운영본 비교 환경변수가 제거되고 자식 서버가 남아 실패했다. 공식 격리 evidence는 공개 소스 SHA와 모의 watchdog 회귀 103개를 실행해 모두 통과했다. 전체 Node 테스트와 실제 CLI QA 의무는 별도로 유지한다.
- 공식 리뷰 시크릿 스캔은 README의 명령 경로 예시와 명령 파싱 코드의 `token` 콜백·정규식 quote를 오탐했다. 실제 키는 없었다. 명령 조각 변수명을 명확히 하고 quote 정규식을 동등한 alternation으로 바꿨으며, 절대 경로 예시를 간결하게 했다. 정규식 두 표현은 137,257개 문자열에서 동일했다. 탐지기·정책·receipt는 수정하지 않았다.
- 추가 Fable 검증 재시도는 풀 제한(exit 1) 이후 240초 timeout도 발생했다. 실질 결과와 modelUsage를 얻지 못해 UNVERIFIED로 유지한다.

## Ubuntu CI 실행과 환경 보강

- `b58c2cc` 독립 실제 QA: 한글 경로·`ko_KR.UTF-8`에서 28/28 PASS. 인증 HTTP readback, priority/disable/enable/remove·구독 cancel/clear, supervisor·worker PID 유지, 잘못된 입력 거부, 출력 자격증명 비노출을 확인했다. 임시 프로세스와 설정을 정리했다.
- 같은 커밋의 로컬 전체 재실행은 복구 verifier 3/3·프록시 호환성 통과 후 load1 57.59로 qgate hard limit 48.0에 걸려 exit 75로 중단됐다. 재실행은 큐에 유지하며 전체 PASS로 기록하지 않는다.
- GitHub push 실행 `34220789793` 및 PR 실행 `34220789838`: 둘 다 860 tests / 836 pass / 23 fail / 1 skipped. 23 fail은 wrapper 하위 19개와 부모 그룹 4개이며, 다른 파일의 실패는 없었다.
- 실패는 wrapper 실행의 null 종료 상태 17건과 명시적인 spawn ENOENT 2건이다. 파일 생성·readback·실행 권한 테스트는 통과했다. wrapper와 fixture가 `/bin/zsh`를 요구하므로 CI에 zsh 설치와 실제 실행 확인을 추가했다. 누락 인터프리터가 있는 공백 경로 스크립트는 ENOENT, 유효 인터프리터는 exit 0인 것을 별도 재현했다. 설치 후 두 원격 전체 실행이 모두 통과해 원인을 확인했다.
- 한국어 locale을 생성하고 존재를 확인하여 기존 locale 테스트도 Ubuntu에서 실행한다. 테스트·assertion·실패 판정은 변경하지 않는다.
- `sync-docs`: `CLAUDE.md` 198줄·기본 브랜치 대비 불변, 관련 rules 파일 없음. housekeeping 스크립트가 빈 파일 목록에서 숫자를 중복 출력해 JSON이 잘못됐으므로 PASS로 소비하지 않았다. `git ls-files --others --exclude-standard`로 미추적 파일 0개를 별도 확인했다.

## 머지 전 확인한 결과

- 검증 커밋: `4e786a6a8f5d970631377bb1a3b84e65bcce9c06`.
- [push 실행 34221523291](https://github.com/sangrokjung/teamclaude/actions/runs/34221523291)과 [PR 실행 34221528150](https://github.com/sangrokjung/teamclaude/actions/runs/34221528150): 각각 `completed/success`, 860 tests / 860 pass / 0 fail / 0 cancelled / 0 skipped. `zsh 5.9`와 `ko_KR.UTF-8` 생성·확인 단계도 성공했다.
- 두 실행 모두 pinned full recovery verifier 3/3 PASS. AC1·AC2의 passed는 이 Ubuntu 실행 결과이며, 로컬 운영 watchdog 설치본과의 일치를 뜻하지 않는다.
- 이전 QA 커밋과 검증 커밋의 `src`, `test`, `package.json`은 동일하다. 독립 QA가 이 동일성과 앞선 28개 실제 CLI/API 결과를 대조하고, 검증 커밋에서 help 2건·잘못된 명령·오프라인 status의 종료 코드와 설정 불변을 추가 확인했다.
- 코드 품질·보안·요구사항·맥락·실제 QA의 독립 검토 5개는 검증 커밋에서 PASS다. 이는 공식 gate receipt를 대신하지 않는다. 공개 반영에는 현재 generation의 공식 `goal-correctness`·`runtime-security` APPROVE가 별도로 필요하다.
- 로컬 전체 재실행과 Node 복구 회귀를 포함한 공식 verifier는 qgate에 제출했다. 앞선 부하 안전 중단은 성공으로 집계하지 않는다. 서비스 관련 상속 환경을 제거하고 고정 기준선 watchdog 파일을 비교한다. 완료 결과는 PR과 비공개 인수인계에 남긴다.
- Claude Code 추가 조사·구현 검증은 지정한 Fable 설정으로 실제 실행했으나 풀 제한 또는 시간 초과로 실질 결과를 얻지 못했다. UNVERIFIED이며 성공 검증으로 소비하지 않는다.

## 자동 시작 서버의 검증 후 정리

- `aa316ac`의 원격 push `34223235746`·PR `34223239444`는 각각 860/860·실패/취소/스킵 0이다. 로컬 첫 실행은 859/860으로 임시 서버 시작 제한 1건이 실패했고, 단독 실행 1/1 및 전체 재실행 860/860으로 확인했다. assertion은 변경하지 않았다.
- 동일한 격리 HOME·PATH에서 Node 복구 verifier는 통과했으나, 공식 verifier는 잔여 자식 프로세스로 evidence를 거부했다. `run` 자동 시작 후 `stop`을 직접 실행하니 종료된 부모 PID와 실제 부모 PID 1이 달라 신원 검증이 거부됐다. PID·시작 시각·명령은 모두 동일했다.
- 수정 범위는 이 정상 reparenting 조건과 실패한 자동 시작의 자식 정리다. 자동 시작 통합 테스트에 변조된 시작 시각·살아 있는 부모 PID의 거부와 정상 종료를 추가한다. 기존 인증·worker 부모 검사·신호 직전 검사 및 모든 assertion은 유지한다.
- 순서: 강화한 테스트의 실패 확인 → lifecycle·실패 시작 정리 수정 → targeted test·실제 CLI 검증 → 전체 CI·공식 verifier·독립 검토 → PR 반영 및 기본 배지 관찰.
- 강화한 자동 시작 테스트는 수정 전 0/1 FAIL, 수정 후 자동 시작 종료·실패 시작의 시간 제한·포트 이동 복구 3/3 PASS다. 정상 종료뿐 아니라 잘못된 시작 시각과 살아 있는 부모 PID를 기록하면 신호를 거부함을 확인했다. `sameProcessIdentity` 자체와 worker 부모 검사는 변경하지 않았다.
- 정리 패스: 변경은 supervisor 비교 조건과 직접 생성한 daemon 정리에 한정했다. 공유 추상화 추가나 기존 assertion 삭제가 없다. 최신 변경을 포함한 전체 결과와 공식 판정은 PR·비공개 인수인계의 실행 기록으로 확인한다.

## 최종 실행 근거와 격리 검증의 범위

- 실행 커밋 `f5c42e32ef2d004190819a47a302fcbd5bc9d9f5`: 로컬 전체 860/860, 실제 CLI·HTTP 28/28, 실패 자동 시작 daemon의 직접 생성·SIGTERM 전달·PID 소멸을 확인했다. 정상 자동 시작 stop과 변조된 시작 시각·살아 있는 부모 PID의 거부도 통과했다.
- [push CI 34227259843](https://github.com/sangrokjung/teamclaude/actions/runs/34227259843)와 [PR CI 34227263500](https://github.com/sangrokjung/teamclaude/actions/runs/34227263500)는 각각 860 tests / 860 pass / 0 fail / 0 cancelled / 0 skipped다. 두 실행 모두 전체 Node 스위트와 그 안의 pinned Python 복구 verifier를 실행했다.
- 공식 macOS 격리 검증은 `/bin/ps` 실행 자체가 `Operation not permitted`로 차단된다. 같은 명령의 일반 실행은 exit 0이었다. 동일 격리 조건의 진단에서 lifecycle 정보가 없어 정상 stop·계정 hot reload 테스트가 실패하고 자식 서버가 남는 것을 확인했다. 제품 테스트·assertion·격리 정책을 변경하지 않았다.
- 공식 verifier에는 기존 `test/gate_qa_status_cli.py`의 실제 CLI 테스트와 공개 소스 SHA·모의 watchdog 검증을 사용한다. 이는 위 전체 실행을 대체하지 않는다. 격리 환경에서 증명할 수 없는 프로세스 신원·종료 동작은 위 로컬 전체·실사용 QA와 두 Ubuntu 실행으로 확인했다.
- 이 문서 갱신은 실행 코드·테스트·workflow를 변경하지 않는다. 아래 SHA-256은 두 원격 성공 실행의 커밋에서 직접 추출한 파일 바이트이며, 이후 문서 커밋의 검토자는 현재 번들 파일과 대조할 수 있다.

| 파일 | 실행 커밋의 SHA-256 |
|---|---|
| `.github/workflows/tests.yml` | `ebfc95d5829505957e6c0c77b422cd9fa58efd0ee3260ee56f164e89ac8d1c0b` |
| `src/index.js` | `f6a8329f618c11203f22a2568fc85e0481fa9ae5703387c9729fc4f72e862446` |
| `src/cmux-process-guard.js` | `837229b97f7766f669b8eb7334ebb721a8a2ad899adbfe8b26f618cc90eb6559` |
| `test/process-identity-locale.test.js` | `d727845f1f9e979593549e180207102b7c93a604859e050c2d9e06c1a3f0a8b6` |
| `test/server-supervisor.test.js` | `21e24b19a58d1bbd19328179fbbda13c02b5be16244aac0feb54220e937fe9f5` |
| `test/subscription-supervisor.test.js` | `ded85ee04a516143fe86c97f2cb9eb6aa2e67d5ab81a49aa99140f723c040fb3` |
| `test/test_model_recovery_gate.py` | `dc8ac6009d16c39f05965f313e9cb059acc7200f963768e426f5041cc10ad257` |

- Claude Code 추가 제품 소스 검증은 지정 Fable 모델에서 exit 0·is_error=false·APPROVE로 완료됐다. 별도 검증 도구 원인 조사는 시간 초과였고, 공식 receipt로 소비하지 않는다. 공식 승인과 기본 브랜치 배지 관찰은 별도 완료 조건이다.
