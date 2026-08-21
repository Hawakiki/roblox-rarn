> PLAN.md §2 에서 2026-08-21 에 이관한 기록이다. 완료 시점의 실측을 보존한다.
> 문서 경로 참조만 이관 시점 구조에 맞게 고쳤고, 내용은 편집하지 않는다.

# M2 — 레지스트리 클라이언트 ✅

- [x] `registry/types.ts` — 와이어 타입과 파싱된 타입 분리
- [x] `registry/parse.ts` — kebab-case, `null`, **Cargo 범위**를 여기서 전부 차단
- [x] `registry/client.ts` — 3개 엔드포인트, 재시도, 캐시, API URL 해석
- [x] 인덱스 `config.json` 해석 (기본 인덱스는 요청 0회)
- [x] in-flight 프로미스 캐시 — 동시 호출도 요청 1회
- [x] 지수 백오프 (네트워크·5xx·429 한정, 4xx 즉시 실패)

M2 상태: **145 tests pass / eslint clean / tsc clean / biome clean.**

**실측으로 발견한 API 특이점:** 없는 패키지가 **404가 아니라 500**을 반환한다.

```
$ curl -o /dev/null -w "%{http_code}" .../package-metadata/nobody/does-not-exist-xyz
500
{"message":"could not open package nobody/does-not-exist-xyz from index ..."}
```

500을 곧이곧대로 서버 오류로 보면 오타 하나에 백오프를 전부 돌고 나서 엉뚱한 원인을
보고한다. 본문을 보고 "없는 패키지"로 판정해 **재시도 없이 즉시** 실패시킨다.
브리틀한 판정이지만 대안이 더 나쁘다.

**API URL 해석은 기본 인덱스에서 네트워크를 쓰지 않는다.** `config.json` 이 레지스트리
수명 내내 `api.wally.run` 을 가리켜 왔고, 상수를 재발견하려고 매 실행 라운드트립을
쓸 이유가 없다. 커스텀 인덱스만 GitHub raw 로 읽는다.

**완료 기준 달성 — 실서버 확인:**

```
getMetadata: 29 versions in 441ms
sleitnick/knit@1.7.0  realm=shared
  Comm       -> sleitnick/comm  >=1.0.0 <2.0.0
  Promise    -> evaera/promise  >=4.0.0 <5.0.0
getContents: 7793 bytes, magic=50 4b 03 04 (zip)
RN0110: nobody/does-not-exist-xyz does not exist in the registry.
```

> 테스트는 녹화된 픽스처만 쓴다 (`tests/fixtures/registry/`). 네트워크 없이 돈다.
