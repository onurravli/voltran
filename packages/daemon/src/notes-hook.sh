#!/bin/sh
# Claude Code hooks for a pane's notes. They must never block Claude, so every path exits 0.
mode=$1
guide=$2
notes=$VOLTRAN_NOTES
[ -n "$notes" ] && [ -n "$VOLTRAN_PANE_ID" ] || exit 0
folder=$(dirname "$notes")
changed="$folder.changed"
limit=8000

# The notes folder is the agent's, and a shell cannot open a file there without following a link the
# agent planted, so the daemon reads the notes and the hook asks it for them.
show() {
    [ -r "$guide" ] && [ ! -L "$guide" ] && cat "$guide"
    printf '\nNotes file: %s\n\n' "$notes"
    if ! body=$(curl -s -f -m 2 -H @"$VOLTRAN_HOOK_HEADER" "$VOLTRAN_URL/api/hooks/$VOLTRAN_PANE_ID/notes"); then
        printf '(not shown: Voltran did not answer. Read the file instead.)\n'
    elif [ -n "$body" ]; then
        printf '%s' "$body" | head -c "$limit"
        size=$(printf '%s' "$body" | wc -c | tr -d ' ')
        if [ "$size" -gt "$limit" ]; then
            printf '\n[Cut at %s of %s bytes. Read the file for the rest.]\n' "$limit" "$size"
        else
            printf '\n'
        fi
    else
        printf '(empty)\n'
    fi
}

case $mode in
    session-start)
        cat > /dev/null
        rm -f "$changed"
        show
        ;;
    prompt)
        cat > /dev/null
        claim="$changed.$$"
        if mv "$changed" "$claim" 2> /dev/null; then
            rm -f "$claim"
            printf 'The user changed the pane notes since you last saw them.\n\n'
            show
        fi
        ;;
    pre-tool-use)
        input=$(cat)
        case $input in
            *"\"$notes\""*) ;;
            *) exit 0 ;;
        esac
        if [ -d "$folder" ] && [ ! -w "$folder" ]; then
            printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The user is editing these notes in Voltran right now. Try again after they finish, and do not change the permissions of the file or its folder."}}'
        fi
        ;;
esac
exit 0
