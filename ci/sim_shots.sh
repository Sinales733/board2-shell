#!/bin/bash
# 云端 iPad 模拟器截图：起假服务（ci/stub_server.py + ci/fixture），用 UI 测试（UITests/ShotsUITests.swift）
# 打开 App 摆出各个画面截图、横竖屏都拍、连得上 / 连不上各自检一次。结果放进 <输出目录>。
# 用法：ci/sim_shots.sh <输出目录>   只在 GitHub Actions 的 Mac 上跑。
set -uo pipefail
OUT="$1"
mkdir -p "$OUT"
rm -rf "$HOME/b2shots"

# 1180×820（横屏）的 iPad：优先 iPad Air 11 英寸
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
echo "simulator: $LINE" | tee "$OUT/device.txt"
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b

python3 ci/stub_server.py 8409 ci/fixture > "$OUT/stub.log" 2>&1 &
STUB=$!
for i in $(seq 1 40); do curl -sf http://127.0.0.1:8409/data/index.json > /dev/null && break; sleep 0.25; done

set +e
COMMON=(-project Board2Shell.xcodeproj -scheme Board2Shell -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath build CODE_SIGNING_ALLOWED=NO)
xcodebuild build-for-testing "${COMMON[@]}" > "$OUT/xcbuild.log" 2>&1
echo "build-for-testing exit: $?"

# 动效录像：跑 testMotion 的同时录屏（启动淡入、设置面板开关、离线标记收展）
xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$OUT/motion.mp4" > "$OUT/record.log" 2>&1 &
REC=$!
sleep 2
xcodebuild test-without-building "${COMMON[@]}" -only-testing:Board2ShotsUITests/ShotsUITests/testMotion > "$OUT/xctest-motion.log" 2>&1
kill -INT "$REC" 2>/dev/null; wait "$REC" 2>/dev/null
# 按段切出几张连拍（有 ffmpeg 才切；没有就只留整段录像）
if command -v ffmpeg > /dev/null; then
  mkdir -p "$OUT/motion-frames"
  ffmpeg -loglevel error -i "$OUT/motion.mp4" -vf "fps=6,scale=900:-1" "$OUT/motion-frames/f%04d.jpg" || true
fi

# 真实触摸写字（草稿纸）：手指拖动写字、橡皮、撤销、收起再开、换题、双指缩放
xcodebuild test-without-building "${COMMON[@]}" -only-testing:Board2ShotsUITests/ShotsUITests/testInk > "$OUT/xctest-ink.log" 2>&1
xcodebuild test-without-building "${COMMON[@]}" -only-testing:Board2ShotsUITests/ShotsUITests/testShots -resultBundlePath "$OUT/result.xcresult" > "$OUT/xctest.log" 2>&1
RC=$?
set +e

kill "$STUB" 2>/dev/null
grep -E "error:" "$OUT/xcbuild.log" | head -n 30
grep -E "^SHOT |error:|Test Case .*(passed|failed)|\*\* TEST" "$OUT/xctest-motion.log" "$OUT/xctest.log" | head -n 200
grep -E "^INK " "$OUT/xctest-ink.log" | head -n 80
cp Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png "$OUT/icon-1024.png" 2>/dev/null
cp -R "$HOME/b2shots/." "$OUT/" 2>/dev/null || echo "没有截图输出（~/b2shots 不在）"
xcrun simctl spawn "$UDID" log show --last 30m --predicate 'process == "Board2Shell" AND eventMessage CONTAINS "Board2Shell"' --style compact > "$OUT/app.log" 2>/dev/null || true
echo "===== selftest-online ====="; cat "$OUT/selftest-online.json" 2>/dev/null; echo
echo "===== selftest-offline ====="; cat "$OUT/selftest-offline.json" 2>/dev/null; echo
echo "===== posts after replay ====="; cat "$OUT/stub-posts-after-replay.json" 2>/dev/null; echo
echo "===== app log (JS errors) ====="; grep "Board2Shell JS" "$OUT/app.log" | head -n 40
ls -la "$OUT"
echo "xcodebuild test exit code: $RC"
# 自检有一条不对、或者有截图没等到就绪：让 CI 变红（截图仍然照常上传）
python3 ci/check_selftest.py "$OUT"
CHECK=$?
if [ $RC -ne 0 ] || [ $CHECK -ne 0 ]; then exit 1; fi
exit 0
