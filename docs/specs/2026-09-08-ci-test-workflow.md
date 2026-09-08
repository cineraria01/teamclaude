# 테스트 CI와 자동 배지 계약

Intent: docs/intents/2026-09-08-ci-test-workflow.md

## Problem / Goal

README 세 언어의 테스트 개수가 수동 값이고 자동 CI가 없다. 이전 세션의 PR #34는 프로세스 시작 시각 파싱 로케일만 수정했으며, 모델 복구 evidence 해시 불일치와 supervisor 테스트 실패를 미완료로 남겼다. 최신 기본 브랜치 위에서 실패를 재현·복구하고 실제 Actions 상태를 배지에 연결한다.

## Requirements / Acceptance

1. 로컬 테스트는 서비스 관련 상속 환경을 제거하고 임시 설정과 모의 계정만 사용한다. 운영 서비스에 신호를 보내지 않는다.
2. `ps` 시작 시각은 POSIX 형식으로 파싱되며 한국어 경로도 프로세스 식별에 보존된다. 계정 변경 후 supervisor·worker PID 유지 및 변경 반영을 실제 CLI/API로 확인한다.
3. 모델 복구 evidence의 두 SHA-256과 대응 문서를 검토한 소스에 맞춰 갱신한다. 기존 테스트와 assertion을 삭제·약화하지 않는다.
4. GitHub Actions는 push, pull_request, 수동 실행에서 전체 Node 테스트를 직렬 실행한다. wrapper 테스트에 필요한 `/bin/zsh`와 한국어 UTF-8 로케일을 준비한다. 저장소 읽기 권한만 부여하며 시크릿·외부 AI 계정이 필요하지 않다.
5. 영어·한국어·중국어 README의 배지는 동일 workflow와 기본 브랜치를 가리키며 실패 색을 덮어쓰지 않는다. 원격 실행 결과를 관찰하고 통과/실패를 그대로 보고한다.

## Non-goals

npm 발행, 운영 런타임 재배포, 계정·인증정보 변경, 전체 테스트 구조 재설계, unrelated 코드 정리.

## Risks / Concerns

프로세스 식별과 외부 공개 변경으로 L급 검증을 적용한다. 사용자 진행·업로드 위임은 이전 세션의 실제 사용자 메시지로 확인했다. 머신 부하는 qgate 대기로 처리한다. 로컬 독립 검증 receipt와 추가 Claude CLI 의견은 구분한다. 재시도에도 검증이 불가능하면 통과를 주장하지 않는다.

## Decision / Rollout / Rollback

기존 PR #34 브랜치에서 최신 기본 브랜치를 통합한다. hash gate는 유지하며 evidence를 갱신한다. GitHub Actions 자체 배지로 정적 숫자를 교체한다. 소스 독립 검토와 실제 CLI/API QA를 거친 커밋을 기존 PR에 올려 Ubuntu CI를 검증한다. 로컬 전체 실행이 부하로 중단되면 재실행은 qgate에 유지한다. 이 단계의 push는 완료나 머지 승인이 아니다. 전체 테스트·공식 독립 검토 후 PR을 반영하고, 기본 브랜치의 Actions 결과와 배지를 관찰해야 완료한다. 되돌릴 때는 이 작업의 커밋만 revert하여 이전 배지와 CI 상태로 복구한다. 운영 서비스 변경은 없으므로 서비스 rollback은 불필요하다.

## Verification

진행 상태와 실행 근거는 docs/plans/2026-09-08-ci-test-workflow.md에 기록한다.
