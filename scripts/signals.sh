#!/usr/bin/env bash
#
# Prints the signals the 1.0 gate is waiting on.
#
# The gate asks whether projects that are not ours install Rarn and get on with it
# (PLAN.md §3). That question has no single number behind it, and the numbers that
# do exist are mostly noise — so this collects them in one place, ranked by what
# each one actually tells you, rather than leaving it to be re-derived every time
# somebody asks.
#
#   bash scripts/signals.sh
#
# Needs `gh`, authenticated. Nothing about building or testing Rarn needs it, so
# an absent `gh` skips loudly rather than failing.

set -uo pipefail

REPO="${RARN_REPO:-Hawakiki/roblox-rarn}"
OWNER="${REPO%%/*}"
# README 가 "쓰고 있으면 여기 적어 달라" 고 가리키는 이슈. 이 스크립트가 세는 것 중
# 유일하게 사람이 직접 남기는 신호다.
GUESTBOOK="${RARN_GUESTBOOK:-47}"

if ! command -v gh > /dev/null 2>&1; then
  echo "gh 가 없어 신호를 읽지 못한다. https://cli.github.com" >&2
  exit 0
fi

count() { gh api -X GET search/code -f q="$1" -q '.total_count' 2>/dev/null || echo '?'; }
repo() { gh api "repos/$REPO" -q "$1" 2>/dev/null || echo '?'; }

echo
echo "1.0 게이트 신호 — $REPO"
echo

# 남이 자기 프로젝트에 핀을 박았다는 것. 게이트가 묻는 질문에 가장 가까운 답이다.
# 공개 저장소만 색인되므로 언제나 실제보다 적게 잡힌다 — Roblox 게임은 비공개가 많다.
pins=$(count "roblox-rarn filename:rokit.toml")
echo "  rokit 핀        ${pins}          <- 직접 답. 3~5 필요 (공개 저장소만 세므로 과소집계)"

# 방명록에 남이 남긴 댓글. 핀과 같은 무게의 직접 답이고, 비공개 저장소도 잡힌다.
guests=$(gh api -X GET "repos/$REPO/issues/$GUESTBOOK/comments" -f per_page=100 \
  -q "[.[] | select(.user.login != \"$OWNER\")] | length" 2>/dev/null || echo '?')
echo "  방명록 댓글     ${guests}          <- 직접 답. #${GUESTBOOK} 에 남이 적은 것만 센다"

# 넣었고, 돌렸고, 뭔가 겪었다는 것. 핀 하나보다 무겁다.
#
# 우리가 연 것은 뺀다. `open_issues_count` 는 작성자를 가리지 않아서, 방명록 이슈 하나가
# 열려 있는 것만으로 이 줄이 1 이 되고 게이트가 "신호가 있다" 고 말했다 — 신호가 우리
# 자신이면 0 보다 나쁘다. 닫힌 것도 센다: 남이 열었다 닫힌 이슈는 여전히 돌려봤다는 뜻이다.
issues=$(gh api -X GET search/issues -f q="repo:$REPO -author:$OWNER" -q '.total_count' 2>/dev/null || echo '?')
echo "  이슈·PR         ${issues}          <- 제일 강한 신호. 돌려봤다는 뜻이다 (우리 것 제외)"

# 고치거나 벤더링할 의도. 별보다 강하다.
forks=$(repo '.forks_count')
echo "  포크            ${forks}          <- 사용의 대리 지표"

# 도달 범위. 위의 셋이 여기서 나오므로 선행 지표로 읽는다.
stars=$(repo '.stargazers_count')
echo "  별              ${stars}          <- 선행 지표. 0 이면 나머지도 0 일 수밖에 없다"

echo
echo "  참고 — 아래는 신호로 쓰지 않는다"

# CI 가 잡마다 clone 한다. 우리 것이 압도적이라 남의 것이 묻힌다.
clones=$(gh api "repos/$REPO/traffic/clones" -q '"\(.count) (unique \(.uniques))"' 2>/dev/null || echo '?')
echo "    clone         ${clones}   CI 가 대부분이다"

# rokit 도 CI 도 구경꾼도 같은 카운터를 올린다. 구분할 방법이 없다.
downloads=$(gh api "repos/$REPO/releases" -q '[.[].assets[].download_count] | add' 2>/dev/null || echo '?')
echo "    릴리스 다운로드 ${downloads}       rokit·CI·구경꾼이 섞여 구분되지 않는다"

echo
if [ "$pins" = "0" ] && [ "$guests" = "0" ] && [ "$issues" = "0" ] && [ "$forks" = "0" ]; then
  echo "  게이트: 닫힘. 아직 우리뿐이다."
else
  echo "  게이트: 신호가 있다. PLAN.md §3 을 읽고 판단할 것."
fi
echo
