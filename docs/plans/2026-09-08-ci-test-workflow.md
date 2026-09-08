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
    status: pending
  - id: AC2
    desc: "모델 복구 evidence 검증 통과"
    verifier: "python3 -m unittest discover -s test -p test_model_recovery_gate.py -v"
    status: pending
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
4. 진행 중: 변경분 정리 및 CLI/API QA 통과. 전체 테스트와 독립 검증을 진행한다.
5. 대기: PR 갱신, GitHub Actions 실제 결과 확인, 허용 범위 내 공개 반영과 인수인계.

## Verification

- 시작 HEAD: `5cc7cd5bf7a5753e236cf2c89a1062b3d766c71a`.
- 통합한 기본 브랜치: `09de69e` (PR #33).
- qgate 최초 baseline 티켓은 stdin 스크립트 전달 방식이 detach 실행에 맞지 않아 시작 전 취소했다. 테스트 증거로 사용하지 않는다.
- 추가 Claude 조사: `--model fable --effort xhigh`로 실행 중. 결과 미확정.

## 원인 조사 기록

- 가설 1(로케일): `LC_ALL=C`에서 `한글경로`가 macOS `ps` 출력의 vis escape로 변환됨. `LC_ALL=''`, `LC_TIME=C`, 기존 유효 `LC_CTYPE` 보존 시 날짜는 POSIX·경로는 한글 그대로 관찰.
- 가설 2(시간 예산): 로컬 `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` 1.656초, 동일 조회에 `-b` 추가 시 0.081초. 양쪽 모두 동일한 실제 리스너 PID를 반환. 기본 프로브 시간 1.5초를 초과해 lifecycle 검증이 생략됨.
- 가설 3(환경 오염): `TEAMCLAUDE_PROVIDER`, `TEAMCLAUDE_SESSION_SUPERVISED`, `TEAMCLAUDE_CLAUDE_BIN`이 상속됨. 제거한 재현에서도 느린 lsof로 CLI remove의 'restart' 안내를 관찰하여 환경만이 원인은 아님을 확인.
- 추가 Claude 조사 1차: exit 1, `is_error=true`, modelUsage 없음. 계정 풀 제한으로 UNVERIFIED. 기존 하네스·동일 Fable 설정으로 재시도 예정.

## 구현 검증

- 회귀 재현: 한글 경로와 느린 lsof 조건에서 CLI remove 테스트가 수정 전 exit 1 (`Applied...` 누락), 수정 후 exit 0 (1/1)로 전환됐다.
- 실제 CLI/API: 한국어 로케일·한글 symlink 경로에서 help/status/priority/disable/enable/remove 성공. 잘못된 remove는 exit 1 + Usage 안내. 인증된 status로 계정 목록과 supervisor/worker PID 보존 확인. 임시 서버 종료·설정 정리 완료.
- `node --check` 대상 JS 4개, ESLint 9 대상 4개, actionlint workflow, `git diff --check`: exit 0.
- SHA evidence 단일 Python 테스트: 1/1 PASS.
- 전체 테스트: qgate 실행 대기. 기준선은 별도 고정 worktree에 보존하여 수정 코드와 섞이지 않게 했다.
- 정리 패스: 기존 로케일 테스트의 중복 설명을 줄이고, 추가된 회귀는 기존 assertion을 보존·강화했다. 테스트나 assertion 삭제·완화 없음.
- Claude 조사 재시도: exit 1, is_error=true, modelUsage 없음. 풀 제한 지속, UNVERIFIED.

- 로컬 운영 watchdog 비교는 실패했다. 설치본의 로컬 전용 기본값이 공개 코드와 다르며 운영본 수정은 범위 밖이다. 전체 테스트·gate는 지원되는 `CODEX_WATCHDOG_DEPLOYED_PATH`로 고정된 기본 브랜치 비교 파일을 지정한다. 이 결과를 실제 운영본 일치 증거로 해석하지 않는다.
