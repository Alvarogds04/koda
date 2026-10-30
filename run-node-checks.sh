#!/bin/bash
# Bounded runner for test-node/*-check.cjs: each check gets a hard wall-clock cap, a V8 heap cap and a virtual-memory cap, in its OWN
# process group that is killed whole on timeout (a plain `timeout` over a pipe left an orphaned node growing to 77 GB).
# Usage: run-node-checks.sh [check.cjs ...]   (default: every *-check.cjs except producer-check.cjs, which is not a test)
cd "$(dirname "$0")/apps/desktop-tauri" || exit 2
files=("$@"); [ ${#files[@]} -eq 0 ] && mapfile -t files < <(ls test-node/*-check.cjs | grep -v producer-check.cjs)
fail=0
for f in "${files[@]}"; do
  # a browser reserves a huge virtual address space, so the geometry check gets no -v cap (timeout + V8 heap cap + group kill still apply)
  # checks that launch a browser reserve a huge virtual address space: no -v cap for them (timeout + V8 heap cap + group kill still apply)
  if grep -q "chromium\|playwright" "$f" 2>/dev/null; then vcap=unlimited; cap=${GEO_CAP_SECONDS:-420}; else vcap=6291456; cap=${CAP_SECONDS:-120}; fi
  out=$(ulimit -v $vcap; setsid timeout --kill-after=5 "$cap" node --max-old-space-size=2048 "$f" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then fail=$((fail+1)); echo "FAIL($rc) $f"; echo "$out" | grep -m3 "FAIL\|Error\|FATAL" | cut -c1-200; fi
done
echo "node-checks: ${#files[@]} run, $fail failed"; exit $fail
