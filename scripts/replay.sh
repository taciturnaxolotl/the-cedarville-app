#!/bin/bash
# Replays the cURL on the clipboard, unmodified except for output flags, and
# reports the status.
#
# Copy a GET, not a POST. A POST is rejected by antiforgery validation before
# the session is ever consulted, so it tells you nothing about whether you are
# still signed in. In devtools, sort by Method and pick a GET whose path
# starts with /Student/.
set -uo pipefail

# Chrome breaks the command across lines with trailing backslashes; flatten it
# so the added flags land on curl rather than on this script.
CMD="$(pbpaste | sed 's/[[:space:]]*\\$//' | tr '\n' ' ')"
case "$CMD" in
  curl*) ;;
  *) echo "clipboard does not start with 'curl' — copy as cURL first"; exit 1 ;;
esac
if printf '%s' "$CMD" | grep -qiE "(--data|-X +POST)"; then
  echo "note: that is a POST; antiforgery will reject the replay. Copy a GET instead."
fi

eval "$CMD -s -o /tmp/cedarville-body.txt -w 'status %{http_code}   redirect: %{redirect_url}\n'"
echo "--- first 200 bytes of body ---"
head -c 200 /tmp/cedarville-body.txt 2>/dev/null; echo
rm -f /tmp/cedarville-body.txt
