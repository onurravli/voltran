#!/bin/sh
# Claude Code's status line in a Voltran pane. Its input carries the account's usage limits, which go to
# the daemon; what it prints is the user's own status line, which Voltran's --settings would otherwise hide.
input=$(cat)
case "$input" in
    *'"rate_limits"'*)
        [ -n "$VOLTRAN_PANE_ID" ] && printf '%s' "$input" | curl -s -m 2 -o /dev/null -X POST \
            -H @"$VOLTRAN_HOOK_HEADER" -H 'Content-Type: application/json' \
            --data-binary @- "$VOLTRAN_URL/api/hooks/$VOLTRAN_PANE_ID/StatusLine" > /dev/null 2>&1 &
        ;;
esac
[ -n "$VOLTRAN_STATUSLINE" ] || exit 0
printf '%s' "$input" | sh -c "$VOLTRAN_STATUSLINE"
