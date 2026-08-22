---
name: A package will not install / 이 패키지가 안 깔립니다
about: One specific package from the registry fails, prunes wrong, or does not resolve in Studio
title: ''
labels: bug, package
assignees: ''
---

<!--
  한국어로 적으셔도 됩니다. / Korean is fine.

  이 템플릿이 따로 있는 이유: 패키지 하나가 문제인 것과 Rarn 이 문제인 것은 고치는
  방법이 다릅니다. 레지스트리에는 자기 프로젝트 파일이 특이하거나, 자기 테스트를 같이
  배포하거나, Roblox 밖에서만 도는 코드를 담은 패키지들이 실제로 있습니다.

  Kept separate because "this package is unusual" and "Rarn is wrong" have different
  fixes, and the registry genuinely contains both.
-->

## 어느 패키지 / Which package

<!-- `@scope/name@version` — 버전까지 적어 주세요. 레지스트리 패키지는 불변이라 버전이 곧 내용입니다. -->

## 무엇이 잘못됐나 / What goes wrong

<!-- 해당하는 것에 x 를 넣어 주세요. -->

- [ ] 설치가 실패한다 / the install fails
- [ ] 설치는 되는데 Studio 에서 `require` 가 `nil` 이나 에러다 / installs, but `require` fails in Studio
- [ ] 파일이 너무 많이 또는 너무 적게 깔린다 / the wrong files are installed
- [ ] 타입이 안 넘어온다 / the package's types do not come through the shim
- [ ] 그 외 / other

## 출력 / Output

```

```

## 이게 제일 큰 단서입니다 / The most useful single fact

**같은 패키지를 `wally install` 로는 설치할 수 있나요?**

Can Wally install the same package?

- [ ] Wally 로는 된다 / yes — Wally handles it
- [ ] Wally 로도 안 된다 / no — Wally fails too
- [ ] 안 해봤다 / have not tried

<!--
  Wally 로는 되는데 Rarn 이 안 되면 그건 우리 결함입니다. 둘 다 안 되면 패키지 쪽
  문제일 가능성이 큽니다. 이 한 줄이 조사 범위를 절반으로 줍니다.

  If Wally can and Rarn cannot, it is ours. If neither can, it is probably the package.
  This one line halves the search.
-->

## 환경 / Environment

- `rarn --version`:
- OS:
