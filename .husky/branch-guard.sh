# 브랜치 이름이 규약에 맞는지 본다.
#
# 문서만 있는 규칙은 지켜지다가 어느 날 안 지켜지고, 그 사실을 아무도 모른다.
# 이 프로젝트에서 실제로 두 번 샜다 — 0.1.0 을 낸 뒤 develop 없이 master 로
# 바로 간 적이 있고, 스택 PR 을 순서 없이 머지해 커밋이 develop 에 닿지
# 못한 적이 있다. 이름 검사로 둘 다 막지는 못하지만, 첫 번째는 막는다.
#
# 막지 못하는 것을 분명히 해 둔다: 이건 이름만 본다. 어느 브랜치에서 땄는지,
# 어디로 머지되는지는 모른다.

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

# 머지 해결 중이면 통과시킨다. release/* 와 hotfix/* 는 master 로 들어가는 것이
# 규약이고, 충돌이 나면 그 머지 커밋은 master 위에서 손으로 만들어진다.
# 여기서 막으면 규약대로 한 사람이 막힌다.
if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  exit 0
fi

# rebase·cherry-pick·bisect 중에는 HEAD 가 분리돼 있다. 브랜치 이름이 없으니
# 판단할 근거도 없고, 여기서 멈추면 되돌리기만 어려워진다.
if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
  exit 0
fi

case "$branch" in
  develop)
    ;;
  feat/*|hotfix/*|release/*)
    ;;
  master|main)
    cat >&2 <<'EOF'
✗ master 에는 직접 커밋하지 않는다.

  평소 작업      develop 에서 feat/* 를 딴다
  나간 버전 수리  master 에서 hotfix/* 를 딴다
  버전 올리기    develop 에서 release/<version> 을 딴다

  master 에 커밋이 생기는 경우는 release/* 나 hotfix/* 를 머지할 때뿐이고,
  그건 머지 커밋이라 이 검사를 타지 않는다.
EOF
    exit 1
    ;;
  *)
    prefix=${branch%%/*}
    cat >&2 <<EOF
✗ 브랜치 '$branch' 는 규약의 접두어가 아니다.

  feat/*     기능·수정·리팩터·연구 — 평소 작업은 전부 여기
  hotfix/*   이미 나간 버전이 사용자에게 해를 끼치고 있을 때만
  release/*  버전을 확정할 때

  fix/ 나 chore/ 는 두지 않는다 — 무엇을 고쳤는지는 커밋 메시지가 말하고,
  브랜치 접두어가 말할 일은 '이 작업이 어디로 가는가' 하나다.
  ('$prefix/' 대신 feat/ 를 쓰면 된다.)
EOF
    exit 1
    ;;
esac
