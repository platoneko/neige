default:
    @just --list

build:
    cargo build --release -p neige-server

# Strips claude nesting markers so child claude sessions spawned by
# neige-session-daemon write their own transcripts instead of inheriting a
# CLAUDE_CODE_CHILD_SESSION flag from whichever claude first launched us.
[doc('Launch neige-server on 0.0.0.0:3131 with a claude-nesting-clean env')]
run *args:
    env -u CLAUDE_CODE_CHILD_SESSION \
        -u CLAUDE_CODE_SESSION_ID \
        -u CLAUDE_CODE_EXECPATH \
        -u CLAUDE_CODE_ENTRYPOINT \
        -u CLAUDECODE \
      ./target/release/neige-server \
        --port 3131 \
        --listen 0.0.0.0 \
        --allowed-origin http://10.8.0.2:3131 \
        --allowed-cidr 100.64.0.0/10 \
        {{args}}

[doc('Report neige-session-daemon health (healthy/orphan/broken + orphan socks)')]
diagnose:
    @bash scripts/diagnose-daemons.sh

[doc('Dry-run reap of orphan daemons + sock files; pass --go to execute')]
clean-orphans *args:
    @bash scripts/clean-orphan-daemons.sh {{args}}
