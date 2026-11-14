#!/bin/sh
# Claude Code hooks for a pane's notes (scope "pane") or its project's (scope "project"), one hook
# per scope so each has the whole output budget. They must never block Claude, so every path exits 0.
mode=$1
scope=$2
guide=$3
[ -n "$VOLTRAN_NOTES" ] && [ -n "$VOLTRAN_PANE_ID" ] || exit 0
# The marks that a note changed live next to the pane's notes folder, one per scope, because every
# pane of a project has to see a change to the project's notes.
pane_folder=$(dirname "$VOLTRAN_NOTES")
case $scope in
    pane)
        notes=$VOLTRAN_NOTES
        changed="$pane_folder.changed"
        route=notes
        label='Notes file'
        news='The user changed the pane notes since you last saw them.'
        editing='The user is editing these notes in Voltran right now.'
        ;;
    project)
        notes=$VOLTRAN_PROJECT_NOTES
        changed="$pane_folder.project.changed"
        route=project-notes
        label='Project notes file'
        news='The project notes changed since you last saw them.'
        editing='The user is editing the project notes in Voltran right now.'
        ;;
    *) exit 0 ;;
esac
[ -n "$notes" ] || exit 0
folder=$(dirname "$notes")
limit=8000

# The notes folder is the agent's, and a shell cannot open a file there without following a link the
# agent planted, so the daemon reads the notes and the hook asks it for them.
show() {
    [ -r "$guide" ] && [ ! -L "$guide" ] && cat "$guide"
    printf '\n%s: %s\n\n' "$label" "$notes"
    if ! body=$(curl -s -f -m 2 -H @"$VOLTRAN_HOOK_HEADER" "$VOLTRAN_URL/api/hooks/$VOLTRAN_PANE_ID/$route"); then
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
            printf '%s\n\n' "$news"
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
            printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s Try again after they finish, and do not change the permissions of the file or its folder."}}\n' "$editing"
        fi
        ;;
esac
exit 0
