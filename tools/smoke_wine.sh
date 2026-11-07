#!/usr/bin/env bash
# End-to-end UI smoke test of ClearMD.exe under Wine + Xvfb (Linux). Drives the real window with xdotool.
#
#   tools/smoke_wine.sh path/to/ClearMD.exe [output-dir]
#
# Needs: wine64 (apt: wine64), xvfb, xdotool, imagemagick (for `import` screenshots), python3 + the packages
# tools/test_formats.py needs to generate samples.
#
# What it checks
#   1. window title is "ClearMD v1.0"
#   2. add files (incl. a .txt that has no embedded-metadata support) through the real file dialog
#   3. "clear all metadata" -> warning dialog -> Cancel            => no file changed
#   4. -> Proceed -> Cancel during the 3-second countdown          => no file changed
#   5. -> Proceed -> let the countdown finish                      => supported files changed, .txt untouched
#   6. window resize does not crash the app
# Screenshots of every stage are written to the output dir.
#
# FRAGILE BY DESIGN - coordinates assume: no window manager (plain Xvfb), default 820x620 window opened at its
# default position, English UI. If you change the layout (button positions, dialog size) update the numbers below.
# Wine does NOT emulate NTFS alternate data streams, so stream removal cannot be tested here.
set -u
EXE=$(readlink -f "${1:?usage: smoke_wine.sh path/to/ClearMD.exe [outdir]}")
OUT=${2:-/tmp/clearmd_smoke}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$OUT/files ; ORIG=$OUT/orig
rm -rf "$OUT"; mkdir -p "$WORK" "$ORIG" "$OUT/shots"

python3 "$HERE/test_formats.py" --export-samples "$OUT/samples" >/dev/null || { echo "could not generate samples"; exit 2; }
FILES="a.docx a.pdf a.mp3 a.mp4 a.heic a.gif a.mkv a.jpg"
for f in $FILES; do [ -f "$OUT/samples/$f" ] && cp "$OUT/samples/$f" "$WORK/" ; done
echo "this is just a text file" > "$WORK/notes.txt"
FILES="$(cd "$WORK" && ls | tr '\n' ' ')"
cp "$WORK"/* "$ORIG"/

cat > "$OUT/driver.sh" <<DRV
#!/usr/bin/env bash
export WINEPREFIX=\${WINEPREFIX:-/tmp/clearmd_wineprefix} WINEDEBUG=-all
export PATH=\$PATH:/usr/lib/wine
WINE=\$(command -v wine64 || command -v wine)
shot() { import -window root "$OUT/shots/\$1.png"; }
"\$WINE" "$EXE" >"$OUT/wine.log" 2>&1 &
for i in \$(seq 1 40); do sleep 2; W=\$(xdotool search --name "^ClearMD v1\\.0\$" | head -1); [ -n "\$W" ] && break; done
[ -z "\$W" ] && { echo "FAIL window not found"; exit 1; }
echo "title: \$(xdotool getwindowname \$W)"
sleep 2
for f in $FILES; do            # add file button -> type the Wine path -> Enter
  xdotool mousemove 410 60 click 1; sleep 4
  xdotool type --delay 30 "Z:\$(echo "$WORK" | tr '/' '\\\\')\\\\\$f"; sleep 1; xdotool key Return; sleep 3
done
shot 1_list
xdotool mousemove 410 556 click 1; sleep 3                      # clear all metadata -> warning dialog
D=\$(xdotool search --name "Confirm" | head -1); shot 2_warning
xdotool mousemove --window \$D 398 189 click 1; sleep 2         # Cancel
echo "dialog open after Cancel: \$(xdotool search --name Confirm | wc -l)"
xdotool mousemove 410 556 click 1; sleep 3                      # again -> Proceed -> Cancel in the countdown
D=\$(xdotool search --name "Confirm" | head -1)
xdotool mousemove --window \$D 288 189 click 1; sleep 1.2; shot 3_countdown
xdotool mousemove --window \$D 398 189 click 1; sleep 2
echo "dialog open after countdown-cancel: \$(xdotool search --name Confirm | wc -l)"
touch "$OUT/phase1_done"                                        # checked by the outer script
sleep 3
xdotool mousemove 410 556 click 1; sleep 3                      # third time: let it run
D=\$(xdotool search --name "Confirm" | head -1)
xdotool mousemove --window \$D 288 189 click 1; sleep 6
shot 4_done_dialog; xdotool key Return; sleep 2; shot 5_done_list
for s in "900 650" "760 560" "1000 700" "720 520"; do xdotool windowsize \$W \$s; sleep 1; done
shot 6_resized
echo "alive after resize: \$(xdotool search --name '^ClearMD v1\\.0\$' | wc -l)"
DRV
chmod +x "$OUT/driver.sh"

# phase 1 snapshot is compared while the app still runs: run the driver in the background and poll
( xvfb-run -a -s "-screen 0 1100x800x24" "$OUT/driver.sh" > "$OUT/driver.log" 2>&1 ) &
DRVPID=$!
for i in $(seq 1 300); do [ -f "$OUT/phase1_done" ] && break; sleep 1; done
fail=0
chk() { if [ "$2" = ok ]; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }
same=ok; for f in $FILES; do cmp -s "$WORK/$f" "$ORIG/$f" || same="changed:$f"; done
chk "Cancel at the warning and Cancel during the countdown leave every file untouched" "$([ "$same" = ok ] && echo ok || echo bad)"
wait $DRVPID
grep -q "title: ClearMD v1.0" "$OUT/driver.log" && chk "window title is 'ClearMD v1.0'" ok || chk "window title is 'ClearMD v1.0'" bad
grep -q "dialog open after Cancel: 0" "$OUT/driver.log" && grep -q "dialog open after countdown-cancel: 0" "$OUT/driver.log" && chk "warning dialog closes on Cancel" ok || chk "warning dialog closes on Cancel" bad
for f in $FILES; do
  if [ "$f" = notes.txt ]; then
    cmp -s "$WORK/$f" "$ORIG/$f" && chk "$f (no embedded-metadata support) left untouched" ok || chk "$f left untouched" bad
  else
    cmp -s "$WORK/$f" "$ORIG/$f" && chk "$f cleaned after Proceed + full countdown" bad || chk "$f cleaned after Proceed + full countdown" ok
  fi
done
ls "$WORK" | grep -q clearmd_tmp && chk "no leftover .clearmd_tmp files" bad || chk "no leftover .clearmd_tmp files" ok
grep -q "alive after resize: 1" "$OUT/driver.log" && chk "app survives window resizing" ok || chk "app survives window resizing" bad
echo "screenshots: $OUT/shots"
[ $fail = 0 ] && echo "SMOKE TEST PASSED" || echo "SMOKE TEST FAILED"
exit $fail
