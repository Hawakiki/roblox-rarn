---
name: Something is broken / 뭔가 안 됩니다
about: An install fails, produces the wrong tree, or Studio cannot require it
title: ''
labels: bug
assignees: ''
---

<!--
  한국어로 적으셔도 됩니다. 영어로 쓰느라 안 올리는 것보다 훨씬 낫습니다.
  Korean is fine. A report in Korean beats a report you did not send.
-->

## What happened / 무슨 일이 있었나

<!-- 한 줄이면 충분합니다. -->

## The command, and everything it printed / 명령과 출력 전부

```

```

<!--
  **에러 코드(RN0000 같은 것)를 꼭 남겨 주세요.** 문구는 바뀌어도 번호는 안 바뀌어서,
  그 번호 하나로 어느 계층인지 바로 좁혀집니다. 잘라내지 말고 통째로 붙여 주세요 —
  마지막 줄이 원인이 아닌 경우가 자주 있습니다.

  Include the RN code. The wording changes between releases; the number never does.
  Paste the whole thing rather than the last line — the last line is often not the cause.
-->

## `rarn.json`

```jsonc

```

<!-- 비공개 프로젝트면 의존성 이름만 지우고 나머지 구조는 남겨 주세요. 구조가 단서입니다. -->

## 환경 / Environment

- `rarn --version`:
- OS:
- 설치 방법 / installed via: <!-- rokit, 릴리스 zip, 소스 빌드 -->

## 이미 해보신 것 / Already tried

<!--
  아래 중 해보신 게 있으면 결과를 적어 주세요. 없으면 비워 두셔도 됩니다.
  Optional, but each of these narrows it down a lot.

  - `rarn install --offline` 이 되나요, 안 되나요
  - `rarn.lock` 을 지우고 다시 해보면?
  - 특정 패키지 하나만 문제라면 그 패키지 이름과 버전
  - 같은 패키지가 `wally install` 로는 되나요? <- 이게 제일 강력한 단서입니다
-->
