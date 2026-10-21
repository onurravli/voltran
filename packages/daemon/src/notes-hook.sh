#!/bin/sh
# Claude Code hooks for a pane's notes. They must never block Claude, so every path exits 0.
mode=$1
guide=$2
notes=$VOLTRAN_NOTES
[ -n "$notes" ] || exit 0
folder=$(dirname "$notes")
changed="$folder.changed"
limit=8000

show() {
    [ -r "$guide" ] && [ ! -L "$guide" ] && cat "$guide"
    printf '\nNotes file: %s\n\n' "$notes"
    if [ -L "$notes" ] || [ -L "$folder" ]; then
        printf '(not shown: the notes file or its folder is a link, which Voltran never makes)\n'
    elif [ -f "$notes" ] && [ -s "$notes" ]; then
        head -c "$limit" "$notes"
        size=$(wc -c < "$notes" | tr -d ' ')
        if [ "$size" -gt "$limit" ]; then
            printf '\n[Cut at %s of %s bytes. Read the file for the rest.]\n' "$limit" "$size"
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
