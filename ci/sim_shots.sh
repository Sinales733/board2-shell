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
# iPadOS 26 模拟器默认把 App 开在"窗口"里（缩小、带窗口按钮）。想办法切成全屏：关掉窗口化开关后重启模拟器。
# 改前改后的 SpringBoard 设置都存下来，做不到时能看出原因。
xcrun simctl spawn "$UDID" defaults read com.apple.springboard > "$OUT/springboard-before.txt" 2>&1 || true
# SBChamoisWindowingEnabled + SBMedusaMultitaskingEnabled 是"设置 → 多任务与手势 → 全屏 App"写的两个键
# （https://github.com/neonpixel-software/recipe-raccoon/pull/174 ：在设置里切换前后比对模拟器偏好得出）
for k in SBChamoisWindowingEnabled SBMedusaMultitaskingEnabled SBWindowingEnabled SBMultitaskingWindowedAppsEnabled; do
  xcrun simctl spawn "$UDID" defaults write com.apple.springboard "$k" -bool NO || true
done
xcrun simctl shutdown "$UDID" || true
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl spawn "$UDID" defaults read com.apple.springboard > "$OUT/springboard-after.txt" 2>&1 || true

python3 ci/stub_server.py 8409 ci/fixture > "$OUT/stub.log" 2>&1 &
STUB=$!
for i in $(seq 1 40); do curl -sf http://127.0.0.1:8409/data/index.json > /dev/null && break; sleep 0.25; done

set +e
# Release 配置：测的就是要装到 iPad 上的那种编法
COMMON=(-project Board2Shell.xcodeproj -scheme Board2Shell -configuration Release -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath build CODE_SIGNING_ALLOWED=NO B2_COMMIT="${GITHUB_SHA:-local}")
xcodebuild build-for-testing "${COMMON[@]}" > "$OUT/xcbuild.log" 2>&1
echo "build-for-testing exit: $?"

# 诊断轮：提交说明以"诊断"开头时只跑第一次换橡皮的诊断，跑完退出（不出包）
if git log -1 --format=%s | grep -q '^诊断'; then
  # 第二轮：每次都先重启模拟器（冷状态），不预热（nowarm）和启动时预热（warm）各 4 次
  for v in nowarm warm; do
    for i in 1 2 3 4; do
      xcrun simctl shutdown "$UDID" || true
      xcrun simctl boot "$UDID" || true
      xcrun simctl bootstatus "$UDID" -b
      TEST_RUNNER_B2_DIAG_VAR=$v xcodebuild test-without-building "${COMMON[@]}" -only-testing:Board2ShotsUITests/ShotsUITests/testEraserDiag > "$OUT/xctest-diag-$v-$i.log" 2>&1
      cp "$HOME/b2shots/inktest-portrait.ink.log" "$OUT/diag-$v-$i.ink.log" 2>/dev/null || true
    done
  done
  kill "$STUB" 2>/dev/null
  cp -R "$HOME/b2shots/." "$OUT/" 2>/dev/null || true
  echo "===== eraserdiag ====="; cat "$OUT/eraserdiag.jsonl" 2>/dev/null
  exit 1
fi

# 动效录像：跑 testMotion 的同时录屏（启动淡入、设置面板开关、离线标记收展）
xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$OUT/motion.mp4" > "$OUT/record.log" 2>&1 &
REC=$!
sleep 2
xcodebuild test-without-building "${COMMON[@]}" -only-testing:Board2ShotsUITests/ShotsUITests/testMotion > "$OUT/xctest-motion.log" 2>&1
RC_MOTION=$?
kill -INT "$REC" 2>/dev/null; wait "$REC" 2>/dev/null
# 按段切出几张连拍（有 ffmpeg 才切；没有就只留整段录像）
if command -v ffmpeg > /dev/null; then
  mkdir -p "$OUT/motion-frames"
  ffmpeg -loglevel error -i "$OUT/motion.mp4" -vf "fps=6,scale=900:-1" "$OUT/motion-frames/f%04d.jpg" || true
fi

# 主动造取消用：测试按住一个按钮不放时，App 在按下那一刻写 ~/b2shots/interrupt.req，这里马上把"设置" App 开到前台
( while true; do
    if [ -f "$HOME/b2shots/interrupt.req" ]; then
      rm -f "$HOME/b2shots/interrupt.req"
      xcrun simctl launch "$UDID" com.apple.Preferences > /dev/null 2>&1 && echo "interrupt: launched Settings at $(date -u +%H:%M:%S.%N)" >> "$OUT/interrupt.log"
    fi
    sleep 0.1
  done ) &
WATCH=$!

# 真实触摸写字（草稿纸）：手指拖动写字、橡皮、撤销、收起再开、换题、双指缩放
xcodebuild test-without-building "${COMMON[@]}" -only-testing:Board2ShotsUITests/ShotsUITests/testInk > "$OUT/xctest-ink.log" 2>&1
RC_INK=$?
xcodebuild test-without-building "${COMMON[@]}" -only-testing:Board2ShotsUITests/ShotsUITests/testShots -resultBundlePath "$OUT/result.xcresult" > "$OUT/xctest.log" 2>&1
RC=$?

# 系统日志里和手势、取消有关的（SpringBoard、backboardd、App 进程里 UIKit 的），对"触摸被系统收走"用：哪个系统手势认出来了
xcrun simctl spawn "$UDID" log show --last 120m --style compact --info --debug \
  --predicate '(process == "SpringBoard" OR process == "backboardd" OR process == "Board2Shell") AND (eventMessage CONTAINS[c] "gesture" OR eventMessage CONTAINS[c] "cancel")' \
  > "$OUT/system-gestures-full.log" 2>/dev/null || true

# 窗口模式整套：iPadOS 26 用户也能把 App 开成窗口。恢复 r18–r21 那种设置（只关 Chamois 等三个键、不写 Medusa——那几轮竖屏都是窗口），
# 重启，再跑一遍 testInk；测试里要是 App 还是全屏，会拖窗口右下角的缩放把手把它缩成窗口（试了什么都记在那一步的说明里）。
# 只删掉四个键（r24）不行：App 照样全屏。
xcrun simctl spawn "$UDID" defaults delete com.apple.springboard SBMedusaMultitaskingEnabled || true
for k in SBChamoisWindowingEnabled SBWindowingEnabled SBMultitaskingWindowedAppsEnabled; do
  xcrun simctl spawn "$UDID" defaults write com.apple.springboard "$k" -bool NO || true
done
xcrun simctl shutdown "$UDID" || true
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl spawn "$UDID" defaults read com.apple.springboard > "$OUT/springboard-windowed.txt" 2>&1 || true
TEST_RUNNER_B2_INK_WINDOWED=1 xcodebuild test-without-building "${COMMON[@]}" -only-testing:Board2ShotsUITests/ShotsUITests/testInk > "$OUT/xctest-ink-windowed.log" 2>&1
RC_INKW=$?
# 系统日志里和手势、取消有关的（SpringBoard、backboardd、App 进程里 UIKit 的），对"触摸被系统收走"用：哪个系统手势认出来了
xcrun simctl spawn "$UDID" log show --last 120m --style compact --info --debug \
  --predicate '(process == "SpringBoard" OR process == "backboardd" OR process == "Board2Shell") AND (eventMessage CONTAINS[c] "gesture" OR eventMessage CONTAINS[c] "cancel")' \
  > "$OUT/system-gestures-windowed.log" 2>/dev/null || true
set +e

kill "$STUB" 2>/dev/null
kill "$WATCH" 2>/dev/null
grep -E "error:" "$OUT/xcbuild.log" | head -n 30
grep -E "^SHOT |error:|Test Case .*(passed|failed)|\*\* TEST" "$OUT/xctest-motion.log" "$OUT/xctest.log" | head -n 200
grep -E "^INK " "$OUT/xctest-ink.log" | head -n 80
grep -E "^INK .*ok=false" "$OUT/xctest-ink-windowed.log" | head -n 40
cp Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png "$OUT/icon-1024.png" 2>/dev/null
cp -R "$HOME/b2shots/." "$OUT/" 2>/dev/null || echo "没有截图输出（~/b2shots 不在）"
xcrun simctl spawn "$UDID" log show --last 30m --predicate 'process == "Board2Shell" AND eventMessage CONTAINS "Board2Shell"' --style compact > "$OUT/app.log" 2>/dev/null || true
echo "===== selftest-online ====="; cat "$OUT/selftest-online.json" 2>/dev/null; echo
echo "===== selftest-offline ====="; cat "$OUT/selftest-offline.json" 2>/dev/null; echo
echo "===== posts after replay ====="; cat "$OUT/stub-posts-after-replay.json" 2>/dev/null; echo
echo "===== app log (JS errors) ====="; grep "Board2Shell JS" "$OUT/app.log" | head -n 40
ls -la "$OUT"
echo "xcodebuild test exit codes: shots=$RC ink=$RC_INK ink-windowed=$RC_INKW motion=$RC_MOTION"
# 自检有一条不对、或者有截图没等到就绪：让 CI 变红（截图仍然照常上传）
echo "===== 主线程卡顿归类 ====="; python3 ci/classify_stalls.py "$OUT" || true
python3 ci/check_selftest.py "$OUT"
CHECK=$?
if [ $RC -ne 0 ] || [ $RC_INK -ne 0 ] || [ $RC_INKW -ne 0 ] || [ $RC_MOTION -ne 0 ] || [ $CHECK -ne 0 ]; then exit 1; fi
exit 0
