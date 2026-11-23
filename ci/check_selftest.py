"""云端模拟器跑完以后检查自检结果，有一条不对就让 CI 变红（exit 1）。用法：python3 ci/check_selftest.py <输出目录>"""
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

out = sys.argv[1]
bad = []


def load(name):
    try:
        return json.load(open(os.path.join(out, name), encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        bad.append(f"{name}: 读不到（{e}）")
        return {}


def check(cond, msg):
    if not cond:
        bad.append(msg)


# 每一张都要等到 App 说"可以拍了"
for log in ("xctest.log", "xctest-motion.log"):
    p = os.path.join(out, log)
    if os.path.exists(p):
        for line in open(p, encoding="utf-8", errors="replace"):
            m = re.match(r"^SHOT (\S+) ready=(\w+)", line)
            if m and m.group(2) != "true":
                bad.append(f"{m.group(1)} 没等到就绪")
    else:
        bad.append(f"{log} 不在")

on = load("selftest-online.json")
check(on.get("ready") is True, "在线：页面没就绪")
check(on.get("steps", 0) > 0 and on.get("reached") == on.get("steps", 0) - 1, f"在线：没走到最后一步 {on.get('reached')}/{on.get('steps')}")
check(on.get("svgNodes", 0) > 0, "在线：画面是空的")
check(on.get("postRoundTrip") is True, "在线：POST /draft 往返失败")
check(len(on.get("sse") or []) == 2, f"在线：问答流式没收全 {on.get('sse')}")
check(on.get("reqPost") == 200 and on.get("reqRoundTrip") is True, "在线：用 Request 对象发 POST 不对（第 26 条）")
check(on.get("abort") == "AbortError", f"在线：AbortController 没生效 {on.get('abort')}（第 26 条）")
check(on.get("evilStatus") == 400, f"在线：消息桥接受了别的主机 {on.get('evilStatus')}（第 19 条）")
check(on.get("badPathRejected") is True, "在线：站外路径没拒绝（第 19 条）")
check(on.get("stillB2") is True and on.get("externalOpened") is True, "在线：站外链接把主页面换掉了（第 6 条）")
check(on.get("oldVersionEvicted") is True, "在线：同一路径的旧 v= 没删（第 18 条）")
check(on.get("clearPersisted") is True, "在线：清空没存盘（第 1 条）")
check(on.get("undoPersisted") is True, "在线：撤销没存盘（第 1 条）")
check(on.get("serverMatchesLocal") is True, f"在线：电脑上留的不是最新那份 {on.get('serverT')} vs {on.get('localT')}（第 3、23 条）")
check(on.get("tIsInteger") is True, "在线：时间不是整数毫秒（第 24 条）")
check(on.get("idleTimerDisabled") is True, "在线：屏幕常亮没打开（第 13 条）")

off = load("selftest-offline.json")
check(off.get("ready") is True, "离线：页面没就绪")
check(off.get("steps", 0) > 0 and off.get("reached") == off.get("steps", 0) - 1, f"离线：没走到最后一步 {off.get('reached')}/{off.get('steps')}")
check(off.get("answerQueued") is True, "离线：答题记录没排队")

before = load("stub-posts.json")
after = load("stub-posts-after-replay.json")
n0 = sum(1 for x in before if isinstance(x, dict) and x.get("path") == "/answer")
n1 = sum(1 for x in after if isinstance(x, dict) and x.get("path") == "/answer")
check(n1 > n0, f"重新连上后排队的记录没补发（/answer {n0} → {n1}）")

for t in ("night", "day"):
    for o in ("landscape", "portrait"):
        v = load(f"noconn-{o}-{t}.value.json") if os.path.exists(os.path.join(out, f"noconn-{o}-{t}.value.json")) else {}
        check(v.get("reason") == "refused", f"连不上页 {o}-{t}：原因 {v.get('reason')}，应为 refused（第 7 条）")

for t in ("night", "day"):
    for o in ("landscape", "portrait"):
        v = load(f"drawer-{o}-{t}.value.json")
        check(v.get("ready") is True and v.get("icons", 0) >= 3, f"抽屉 {o}-{t}：没摆好 {v}")
        check(not v.get("overlap"), f"抽屉 {o}-{t}：图标和字压在一起 {v.get('overlap')}")
        check(v.get("cut") == 0, f"抽屉 {o}-{t}：数字被截断 {v.get('cut')}")
        check(v.get("smallIcons") == 0, f"抽屉 {o}-{t}：图标点击区小于 42")
        check("1234" in (v.get("sum") or "") and "888" in (v.get("sum") or ""), f"抽屉 {o}-{t}：没用大数字测 {v.get('sum')}")

ink = load("inktest.json")
steps = ink.get("steps") or []
check(len(steps) >= 20, f"真实触摸写字：步骤不全（{len(steps)} 步）")
for st in steps:
    check(st.get("ok") is True, f"真实触摸写字 {st.get('name')}：{st.get('note')}")

print("===== 自检结果 =====")
if bad:
    for b in bad:
        print("✗", b)
    sys.exit(1)
print("全部通过")
