# 알려진 문제

> 이 문서는 **재현된 것만** 적는다. 의심은 여기 오지 않는다.
>
> 수명 규칙: 항목이 고쳐지면 상세는 지우고 맨 아래 "해결됨" 절에 한 줄만 남긴다
> ("RN-1 — 0.1.1 에서 해결"). 번호는 절대 재사용하지 않는다 — codes.ts 의 Retired 규칙과 같다.
> 수정 상세는 CHANGELOG 가 맡는다.

---

## 🟠 RN-3 · 한 DataModel 안의 호환 중복을 아무도 보지 않는다

**상태:** 미수정. **직접 재현함** (2026-08-22, 캐시된 패키지 + Rojo 7.7.0).

```
alpha/rarn.json   "@evaera/promise": ">=3.1.0 <=3.2.0"   ->  _Index/evaera_promise@3.2.0
beta/rarn.json    "@evaera/promise": ">=3.2.0 <4.0.0"    ->  _Index/evaera_promise@3.2.1

rarn dedupe (alpha):  no duplicates — every package is installed at exactly one version
rarn dedupe (beta):   no duplicates — every package is installed at exactly one version

rojo sourcemap, 둘 다 한 place 에 마운트:
  ws.ReplicatedStorage.Alpha._Index.evaera_promise@3.2.0.promise
  ws.ReplicatedStorage.Beta._Index.evaera_promise@3.2.1.promise      <- 한 DataModel, 2개
```

**재현이 이 항목의 성격을 바꾸었다.** 원래 기록은 이것을 `dedupe` 의 논리 결함으로 적었고
RN-5 를 근본 원인으로 지목했다. 둘 다 아니다:

- **`dedupe` 는 자기가 받은 질문에 옳게 답한다.** alpha 트리에는 promise 가 정말로 한
  버전만 있다. 거짓은 논리가 아니라 **주장의 범위**에 있다 — "every package" 는 세계에
  대한 무조건적 문장인데 실제로는 이 프로젝트에 대한 문장이다.
- **RN-5 가 근본 원인이 아니다.** 범위쌍 324개 무차별 탐색에서 `selectVersions` 가 같은
  major 두 개를 내는 경우는 RN-5 수정 **전에도 0건**이다. 한 매니페스트 안에서는 이 중복이
  만들어지지 않는다.

남는 진짜 내용은 **Rarn 에 "place" 라는 범위가 없다**는 것이다. 제약 1 의 경계는 리포도
매니페스트도 아니고 DataModel 인데, 단일 프로젝트만 보는 도구는 그 경계를 볼 수 없다.
R2 §3.1 의 중심 발견이고, R2 §6.4 의 **5번 — 크로스 트리 중복 진단** 이 이것을 가시화하는
항목이다 (스키마 변경 0). R2 는 이것을 워크스페이스를 지을지 판정할 **계측기**로 본다.

고칠 때: 진단을 새로 짓는 일이지 `dedupe` 를 고치는 일이 아니다. RN-4 가 넓힌 프로젝트
파일 스캔 위에 선다 — 어떤 트리들이 한 DataModel 에 들어가는지는 그 스캔만이 안다.

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

- **RN-5** — 해석이 호환 버전으로 갈라져 만족하지 않는 버전을 설치하던 것.
  같은 major 그룹을 합칠 때 살아남는 버전이 흡수한 제약을 전부 다시 검사하고,
  만족하지 못하는 것은 `RN0200` 충돌로 보고한다. 상세는 CHANGELOG.
