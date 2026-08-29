| 직접 의존 | rarn (콜드) | rarn (웜) | wally | rarn 파일 | wally 파일 | rarn 디스크 | wally 디스크 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 3.00 s <sub>3.00 s–3.00 s n=1</sub> | **259 ms <sub>252 ms–278 ms n=5</sub>** | 1.52 s <sub>1.48 s–1.54 s n=3</sub> | 174 | 938 | 0.6 MB | 2.3 MB |
| 50 | 12.23 s <sub>12.23 s–12.23 s n=1</sub> | **569 ms <sub>559 ms–585 ms n=5</sub>** | 2.32 s <sub>2.22 s–2.44 s n=3</sub> | 813 | 2046 | 3.6 MB | 9.7 MB |
| 150 | 21.19 s <sub>21.19 s–21.19 s n=1</sub> | **1.73 s <sub>1.72 s–1.76 s n=5</sub>** | 4.71 s <sub>4.69 s–4.98 s n=3</sub> | 3115 | 6953 | 13.3 MB | 46.3 MB |
| 506 | 38.03 s <sub>38.03 s–38.03 s n=1</sub> | **4.04 s <sub>3.96 s–4.05 s n=5</sub>** | 10.01 s <sub>9.68 s–10.59 s n=3</sub> | 7050 | 12961 | 43.6 MB | 107.9 MB |

> win32 10.0.26200 x64 · AMD Ryzen 7 5800X3D 8-Core Processor            · Bun 1.3.14 · Wally wally 0.3.2
> Rarn: binary 0.2.0 · commit `ba0ae2df` · 2026-08-23
> 중앙값, 아래첨자는 min–max 와 n. 첫 샘플 1개는 버린다. 기계 드리프트 -3.6%.
