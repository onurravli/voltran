#!/bin/sh
# Lets an agent in a Voltran pane hand work to another agent and wait for it. It authenticates with the
# pane's hook secret, which curl reads from a file so it never shows in ps.
[ -n "$VOLTRAN_PANE_ID" ] && [ -n "$VOLTRAN_HOOK_HEADER" ] && [ -n "$VOLTRAN_URL" ] || {
    echo 'voltran task: run this inside a Voltran agent pane' >&2
    exit 2
}
base="$VOLTRAN_URL/api/hooks/$VOLTRAN_PANE_ID"

usage() {
    cat >&2 <<'USAGE'
usage: "$VOLTRAN_TASK" delegate [--agent codex|opencode|claude | --to PANE] [--after TASK]... [--parent TASK|none]
                                [--handoff] [--title TEXT] PROMPT
       "$VOLTRAN_TASK" wait TASK [SECONDS]
       "$VOLTRAN_TASK" status TASK
       "$VOLTRAN_TASK" list
       "$VOLTRAN_TASK" cancel|retry|done TASK
       "$VOLTRAN_TASK" edit TASK [--title TEXT] [--prompt TEXT]
       "$VOLTRAN_TASK" link TASK [--after TASK]... [--no-after] [--parent TASK|none]
       "$VOLTRAN_TASK" move TASK --before TASK|--end
       "$VOLTRAN_TASK" remove TASK|finished
       "$VOLTRAN_TASK" spawn --agent codex|opencode|claude [--title TEXT]
       "$VOLTRAN_TASK" board
USAGE
    exit 2
}

get() {
    curl -s -f -m 10 -H @"$VOLTRAN_HOOK_HEADER" "$base/tasks$1"
}

one_line() {
    printf '%s' "$1" | tr '\r\n' '  '
}

# Sends stdin as the body to METHOD PATH with the remaining curl arguments, prints the answer and fails
# with Voltran's reason when it refuses.
send() {
    method=$1
    path=$2
    shift 2
    reply=$(curl -s -m 10 -X "$method" -H @"$VOLTRAN_HOOK_HEADER" -H 'Content-Type: text/plain' "$@" \
        --data-binary @- -w '\n%{http_code}' "$base$path")
    code=$(printf '%s' "$reply" | tail -n 1)
    body=$(printf '%s' "$reply" | sed '$d')
    case $code in
        2??) printf '%s\n' "$body" ;;
        *)
            printf 'voltran task: %s\n' "${body:-Voltran did not answer}" >&2
            exit 1
            ;;
    esac
}

command=$1
[ -n "$command" ] || usage
shift
case $command in
    delegate)
        agent=
        to=
        after=
        parent=
        handoff=0
        title=
        while [ $# -gt 0 ]; do
            case $1 in
                --agent) agent=$2; shift 2 ;;
                --to) to=$2; shift 2 ;;
                --after) after="${after:+$after,}$2"; shift 2 ;;
                --parent) parent=$2; shift 2 ;;
                --handoff) handoff=1; shift ;;
                --title) title=$2; shift 2 ;;
                --) shift; break ;;
                -*) usage ;;
                *) break ;;
            esac
        done
        if [ $# -gt 0 ]; then
            prompt=$*
        else
            prompt=$(cat)
        fi
        [ -n "$prompt" ] || usage
        printf '%s' "$prompt" | send POST /tasks \
            -H "X-Voltran-Agent: $(one_line "$agent")" \
            -H "X-Voltran-To: $(one_line "$to")" \
            -H "X-Voltran-After: $(one_line "$after")" \
            -H "X-Voltran-Parent: $(one_line "$parent")" \
            -H "X-Voltran-Handoff: $handoff" \
            -H "X-Voltran-Title: $(one_line "$title")"
        ;;
    status)
        [ -n "$1" ] || usage
        get "/$1"
        ;;
    wait)
        [ -n "$1" ] || usage
        limit=${2:-1800}
        waited=0
        while :; do
            if ! reply=$(get "/$1"); then
                echo 'voltran task: no such task, or Voltran did not answer' >&2
                exit 1
            fi
            case $(printf '%s' "$reply" | head -n 1) in
                done) printf '%s\n' "$reply"; exit 0 ;;
                failed|cancelled) printf '%s\n' "$reply"; exit 1 ;;
            esac
            if [ "$waited" -ge "$limit" ]; then
                printf '%s\n' "$reply"
                exit 3
            fi
            sleep 5
            waited=$((waited + 5))
        done
        ;;
    list)
        get ''
        ;;
    cancel|retry|done)
        [ -n "$1" ] || usage
        action=$command
        [ "$action" = "done" ] && action=complete
        send PATCH "/tasks/$1" -H "X-Voltran-Action: $action" < /dev/null
        ;;
    edit)
        task=$1
        [ -n "$task" ] || usage
        shift
        title=
        prompt=
        has_prompt=0
        while [ $# -gt 0 ]; do
            case $1 in
                --title) title=$2; shift 2 ;;
                --prompt) prompt=$2; has_prompt=1; shift 2 ;;
                *) usage ;;
            esac
        done
        printf '%s' "$prompt" | send PATCH "/tasks/$task" \
            -H "X-Voltran-Title: $(one_line "$title")" \
            -H "X-Voltran-Prompt: $has_prompt"
        ;;
    link)
        task=$1
        [ -n "$task" ] || usage
        shift
        after=
        parent=
        while [ $# -gt 0 ]; do
            case $1 in
                --after) after="${after:+$after,}$2"; shift 2 ;;
                --no-after) after=none; shift ;;
                --parent) parent=$2; shift 2 ;;
                *) usage ;;
            esac
        done
        [ -n "$after$parent" ] || usage
        send PATCH "/tasks/$task" \
            -H "X-Voltran-After: $(one_line "$after")" \
            -H "X-Voltran-Parent: $(one_line "$parent")" < /dev/null
        ;;
    move)
        task=$1
        [ -n "$task" ] || usage
        case $2 in
            --before) [ -n "$3" ] || usage; before=$3 ;;
            --end) before=end ;;
            *) usage ;;
        esac
        send PATCH "/tasks/$task" -H "X-Voltran-Before: $(one_line "$before")" < /dev/null
        ;;
    remove)
        [ -n "$1" ] || usage
        send DELETE "/tasks/$1" < /dev/null
        ;;
    spawn)
        agent=
        title=
        while [ $# -gt 0 ]; do
            case $1 in
                --agent) agent=$2; shift 2 ;;
                --title) title=$2; shift 2 ;;
                *) usage ;;
            esac
        done
        [ -n "$agent" ] && [ "$agent" != tasks ] || usage
        send POST /panes -H "X-Voltran-Agent: $(one_line "$agent")" -H "X-Voltran-Title: $(one_line "$title")" \
            < /dev/null
        ;;
    board)
        send POST /panes -H 'X-Voltran-Agent: tasks' < /dev/null
        ;;
    *) usage ;;
esac
