# test/roblox — 실제 동작 검증장

자동화 테스트는 **파일 트리가 맞는지**까지만 본다. `require` 가 런타임에 정말 해결되는지,
dedupe 된 패키지가 정말 같은 인스턴스인지는 Roblox 안에서만 확인할 수 있다.

**Rojo는 이 폴더에서만 쓴다.** Rarn 자체는 Rojo에 의존하지 않으며 — 오히려 Rojo 없이
동작하는 게 목표다 — 여기서는 산출물을 Studio로 옮기는 운반 수단으로만 쓴다.

M6(링커) 완료 시 채운다. 시나리오와 절차는 [../../PLAN.md](../../PLAN.md) 5절 참고.

```
rarn install          # RARN_MODULE/ 생성
rojo serve            # Studio 연결
                      # Studio에서 실행 -> verify.server.luau 출력 확인
```
