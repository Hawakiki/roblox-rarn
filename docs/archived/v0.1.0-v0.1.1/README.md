# v0.1.0 – v0.1.1 시대의 마일스톤

**닫힘: 2026-08-22.** 이 폴더의 기록은 **동결**이다 — 링크 수정 말고는 편집하지 않는다.

여기 담긴 M0 ~ M17 은 아무것도 없는 상태에서 0.1.1 까지를 만든 작업이다. 1.0.0 으로 가는
계획은 M1 부터 다시 번호를 매기고 [`docs/milestones/v1/`](../../milestones/v1/) 에 쌓인다.
**같은 번호가 두 시대에 존재하므로 경로로 구분한다** — 이 폴더의 M1 은 매니페스트,
`v1/` 의 M1 은 다른 것이다.

| | | |
|---|---|---|
| M0 | [툴체인](m00-toolchain.md) | Bun·biome·eslint·husky 골격 |
| M1 | [매니페스트](m01-manifest.md) | `rarn.json` 스키마·검증·정규화 |
| M2 | [레지스트리](m02-registry.md) | Wally HTTP 클라이언트, 426·ZIP 매직바이트 |
| R1 | [PnP 연구](r1-pnp-research.md) | **기각** — 전문 [research/r1](../../research/r1-pnp-feasibility.md) |
| M3 | [리졸버](m03-resolver.md) | 순서 무관 교집합 해석 |
| M4 | [캐시](m04-cache.md) | 전역 캐시, temp+rename, sha256 |
| M5 | [가지치기](m05-prune.md) | `default.project.json` 해석, `$path` 프루닝 |
| M6 | [링커](m06-linker.md) | `_Index` + shim, Lune 하니스 |
| M7 | [락파일](m07-lockfile.md) | 재사용, 신선도 비대칭 |
| M8 | [CLI 명령](m08-commands.md) | 10개 추가, `doctor` 포함 |
| M9 | [마감](m09-polish.md) | README·ora·에러 렌더링 |
| M10 | [발행](m10-publish.md) | `pack`/`login`/`publish` — 라이브 발행은 미검증 |
| M11 | [CI](m11-ci.md) | 잡별 매트릭스 축, 크로스컴파일 세그폴트 발견 |
| M12 | [원자성](m12-atomic-offline.md) | `.rarn-tmp` 스왑, `--offline` |
| M13 | [import](m13-import.md) | `wally.toml` 이주, 맨 버전 = 캐럿 |
| M14 | [place](m14-place.md) | Rojo 파생, sourcemap 대조 |
| R2 | [워크스페이스 연구](r2-workspaces-research.md) | **REDUCE_SCOPE** — 전문 [research/r2](../../research/r2-workspaces.md) |
| M15 | [워크스페이스](m15-workspaces.md) | ⏸ R2 로 재정의. 실사용자 신호 후 조건부 |
| M16 | [0.1.0 배포](m16-release-0.1.0.md) | ↩️ 나갔다가 **RN-1 로 당일 철회** |
| M17 | [0.1.1 재배포](m17-release-0.1.1.md) | RN-1 ~ RN-6 수정, 재배포. **사후에 쓴 기록** |

## 이 시대가 남긴 것

**결함은 테스트가 아니라 현실에서 나왔다.** 데이터 손실(RN-1)은 R2 가 문서화된 워크플로를
끝까지 돌려서, 512 KiB 언팩 불가(RN-6)와 무제한 동시성은 벤치마크가 실제 패키지 506개를
밟아서 나왔다. 셋 다 463개 테스트가 못 잡았다. 1.0 계획이 "실사용" 을 게이트로 두는 근거가
여기 있다.

**M15 와 M16 은 완료가 아니다.** M15 는 R2 가 짓지 말라고 했고(⏸), M16 은 나갔다가 철회됐다
(↩️). 계획이 항상 앞으로만 가지는 않는다는 기록으로 남긴다.
