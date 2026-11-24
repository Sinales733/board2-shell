#!/bin/bash
# 边缘压力测试（UITests/StressUITests.swift）：一个配置一个任务（full-portrait / full-landscape / windowed-portrait / windowed-landscape）。
# 用法：ci/sim_stress.sh <输出目录> <配置名>   只在 GitHub Actions 的 Mac 上跑。判定见 ci/check_stress.py。
set -uo pipefail
OUT="$1"; CFG="$2"
mkdir -p "$OUT"
rm -rf "$HOME/b2shots"

LINE=$(xcrun simctl list devices available -j | python3 -c '
import json, sys
d = json.load(sys.stdin)["devices"]
devs = [x for rt, xs in d.items() if "iOS" in rt for x in xs]
for want in ("iPad Air 11", "iPad (A16)", "iPad (10th", "iPad Air", "iPad"):
    for x in devs:
        if x["name"].startswith(want):
            print(x["udid"], x["name"], sep="\t"); sys.exit(0)
sys.exit(1)') || { echo "没有可用的 iPad 模拟器"; exit 1; }
UDID=$(echo "$LINE" | cut -f1)
echo "simulator: $LINE cfg: $CFG" | tee "$OUT/device.txt"
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b
# 全屏：设置里"全屏 App"写的两个键（见 ci/sim_shots.sh）；窗口：测试里拖缩放把手缩成窗口，这里用 r18–r21 那种设置
if [[ "$CFG" == full-* ]]; then
  for k in SBChamoisWindowingEnabled SBMedusaMultitaskingEnabled SBWindowingEnabled SBMultitaskingWindowedAppsEnabled; do
    xcrun simctl spawn "$UDID" defaults write com.apple.springboard "$k" -bool NO || true
  done
else
  xcrun simctl spawn "$UDID" defaults delete com.apple.springboard SBMedusaMultitaskingEnabled || true
  for k in SBChamoisWindowingEnabled SBWindowingEnabled SBMultitaskingWindowedAppsEnabled; do
    xcrun simctl spawn "$UDID" defaults write com.apple.springboard "$k" -bool NO || true
  done
fi
xcrun simctl shutdown "$UDID" || true
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b

python3 ci/stub_server.py 8409 ci/fixture > "$OUT/stub.log" 2>&1 &
STUB=$!
for i in $(seq 1 40); do curl -sf http://127.0.0.1:8409/data/index.json > /dev/null && break; sleep 0.25; done

set +e
COMMON=(-project Board2Shell.xcodeproj -scheme Board2Shell -configuration Release -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath build CODE_SIGNING_ALLOWED=NO B2_COMMIT="${GITHUB_SHA:-local}")
xcodebuild build-for-testing "${COMMON[@]}" > "$OUT/xcbuild.log" 2>&1
echo "build-for-testing exit: $?"
TEST_RUNNER_B2_STRESS="$CFG" xcodebuild test-without-building "${COMMON[@]}" -only-testing:Board2ShotsUITests/StressUITests/testStress > "$OUT/xctest-stress.log" 2>&1
RC=$?
kill "$STUB" 2>/dev/null
cp -R "$HOME/b2shots/." "$OUT/" 2>/dev/null || echo "没有输出（~/b2shots 不在）"
xcrun simctl spawn "$UDID" log show --last 150m --style compact --info --debug \
  --predicate '(process == "SpringBoard" OR process == "backboardd" OR process == "Board2Shell") AND (eventMessage CONTAINS[c] "gesture" OR eventMessage CONTAINS[c] "cancel" OR eventMessage CONTAINS[c] "digitizer")' \
  > "$OUT/system-gestures-stress.log" 2>/dev/null || true
echo "xcodebuild test exit: $RC"
echo "===== 主线程卡顿归类 ====="; python3 ci/classify_stalls.py "$OUT" || true
python3 ci/check_stress.py "$OUT" "$CFG"
CHECK=$?
if [ $RC -ne 0 ] || [ $CHECK -ne 0 ]; then exit 1; fi
exit 0
