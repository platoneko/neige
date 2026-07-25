default:
    @just --list

build:
    cargo build --release -p neige-server

# Strips claude nesting markers so child claude sessions spawned by
# neige-session-daemon write their own transcripts. Also sets
# NEIGE_TIE_TO_PARENT=1 so daemons die with the server (production
# lifecycle); for dev use `NEIGE_TIE_TO_PARENT= just run`.
[doc('Launch neige-server on 0.0.0.0:3131 in production mode (daemons tied to server)')]
run *args:
    env -u CLAUDE_CODE_CHILD_SESSION \
        -u CLAUDE_CODE_SESSION_ID \
        -u CLAUDE_CODE_EXECPATH \
        -u CLAUDE_CODE_ENTRYPOINT \
        -u CLAUDECODE \
      NEIGE_TIE_TO_PARENT="${NEIGE_TIE_TO_PARENT:-1}" \
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
