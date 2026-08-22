# 알려진 문제

> 이 문서는 **재현된 것만** 적는다. 의심은 여기 오지 않는다.
>
> 수명 규칙: 항목이 고쳐지면 상세는 지우고 맨 아래 "해결됨" 절에 한 줄만 남긴다
> ("RN-1 — 0.1.1 에서 해결"). 번호는 절대 재사용하지 않는다 — codes.ts 의 Retired 규칙과 같다.
> 수정 상세는 CHANGELOG 가 맡는다.

---

## 🟠 RN-5 · 해석이 호환 버전으로 갈라진다 (`mergeCompatible` 위젠)

**상태:** 미수정. R2 종합이 실제 `selectVersions` 호출로 재현했다고 보고. 직접 재현하지 않았다.

RN-3 의 근본 원인으로 보이는 것. 상세는 `docs/research/r2-workspaces.md` §3.5.

---

## 해결됨

- **RN-1** — `install` 이 자기가 만들지 않은 디렉터리를 지우던 것. 이제 realm 디렉터리가
  `_Index/` 를 갖거나 전부 Rarn 이 생성한 shim 일 때만 교체하고, 아니면 `RN0421` 로 거부한다.
  대소문자 충돌이면 그 사실을 따로 짚는다. `import` 도 같은 충돌을 미리 경고한다. 상세는 CHANGELOG.
- **RN-2** — 하니스가 올바른 교차 realm shim 을 실패로 보던 것. `--mount` 로 형제 realm 을
  등록하면 실제로 검증되고, 마운트가 없으면 실패가 아니라 "not verified" 로 보고한다.
  하니스 테스트가 두 경우를 모두 돌리므로 CI 가 본다. 상세는 CHANGELOG.
- **RN-4** — `place` 파생이 루트 `default.project.json` 하나만 읽던 것과, 라이브러리형
  프로젝트 파일에서 unmounted-realm 경고가 침묵하던 것. 이제 `*.project.json` 을 3단계까지
  읽고 `$path` 를 파일 기준으로 풀며, 파일을 읽은 것과 거기서 무언가를 찾은 것을 구분한다.
  상세는 CHANGELOG.
- **RN-3** — 한 DataModel 안의 호환 중복을 아무도 보지 않던 것. `dedupe` 의 논리 결함이
  아니라 Rarn 에 place 라는 범위가 없던 것이었다. `src/doctor/places.ts` 가 프로젝트 파일을
  읽어 같은 DataModel 에 들어가는 트리들을 비교하고, `dedupe` 가 보고하고 `install` 이
  호환 중복을 경고한다 (`RN0213`). 상세는 CHANGELOG.
