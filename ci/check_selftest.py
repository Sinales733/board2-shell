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
check(on.get("mergeRoundTrip") is True, f"在线：存盘读回再合并，笔画变多了（creationDate 全精度相等={on.get('creationDateExactAfterRoundTrip')}）")
check(on.get("legacySource") == "fixture", f"在线：旧笔迹样本不是示例页里那份（{on.get('legacySource')}）")
check(on.get("legacyReadSame") is True, f"在线：旧笔迹样本读出来不一样（来源 {on.get('legacySource')}，读到 {on.get('legacyStrokes')} 笔）")

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
names = [n.strip() for n in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ink_steps.txt"), encoding="utf-8") if n.strip()]
check(len(names) == len(set(names)), f"步骤名单里有重名：{sorted({n for n in names if names.count(n) > 1})}")


def stepmap(doc, label):
    """步骤名 → 步骤；同一个名字出现两次就报错（后一个会把前一个盖掉，失败会被藏起来）"""
    out, dup = {}, []
    for st in (doc.get("steps") or []):
        n = st.get("name")
        if n in out:
            dup.append(n)
        out[n] = st
    check(not dup, f"{label}：步骤重名 {sorted(set(dup))}")
    return out


def cancel_check(doc, label):
    """被取消的触摸：直接看计数，不靠那一步自己的 ok；主线程卡顿：打印次数、最长"""
    for o in ("portrait", "landscape"):
        cs = (doc.get("cancels") or {}).get(o)
        check(isinstance(cs, dict), f"{label} 被取消的触摸 {o}：没有统计")
        if isinstance(cs, dict):
            n = (cs.get("nativeTouchCancelled") or 0) + (cs.get("webPointerCancel") or 0) + (cs.get("webTouchCancel") or 0)
            setup = cs.get("setupResizeDrag") or []
            print(f"{label} 被取消的触摸 {o}：原生 {cs.get('nativeTouchCancelled')}、网页 pointercancel {cs.get('webPointerCancel')}、touchcancel {cs.get('webTouchCancel')}"
                  + (f"（另有测试拖窗口缩放把手时被系统收走的 {len(setup)} 条，不计入）" if setup else ""))
            check(n == 0, f"{label} {o}：有被取消的触摸 {n} 次：{(cs.get('lines') or [])[:4]}")
        ms = (doc.get("mainThread") or {}).get(o)
        if isinstance(ms, dict):
            print(f"{label} 主线程 ≥250ms 卡顿 {o}：{ms.get('count')} 次，最长 {ms.get('maxMs')} ms，≥1 秒 {ms.get('over1s')} 次")


steps = stepmap(ink, "全屏")
for o in ("portrait", "landscape"):
    for n in names:
        if o == "landscape" and n.startswith("eraser: pixels"):   # 逐像素比画面只在竖屏做
            continue
        st = steps.get(f"{o}: {n}")
        if st is None:
            bad.append(f"真实触摸写字 {o}: 少了一步「{n}」")
        elif st.get("ok") is not True:
            if o == "portrait" and n == "app runs full screen" and st.get("env") is True \
                    and (steps.get("landscape: app runs full screen") or {}).get("ok") is True:
                print(f"（环境限制，不计入）竖屏全屏：{st.get('note')}")
                continue
            bad.append(f"真实触摸写字 {o}: {n}：{st.get('note')}")
cancel_check(ink, "全屏")
extra = [k for k in steps if k.split(": ", 1)[-1] not in names]
check(not extra, f"真实触摸写字：名单外的步骤 {extra}")

# 窗口模式那一遍（iPadOS 26 用户可以把 App 开成窗口）：整套同样必须全过，坐标按窗口框换算
inkw = load("inktest-windowed.json")
stw = stepmap(inkw, "窗口模式")
WN = "app runs in a window (windowed pass)"
for o in ("portrait", "landscape"):
    for n in names:
        if o == "landscape" and n.startswith("eraser: pixels"):
            continue
        n2 = WN if n == "app runs full screen" else n
        st = stw.get(f"{o}: {n2}")
        if st is None:
            bad.append(f"窗口模式 {o}: 少了一步「{n2}」")
        elif st.get("ok") is not True:
            if o == "landscape" and n2 == WN and st.get("env") is True:
                print(f"（记录）窗口模式横屏：{st.get('note')}")
                continue
            bad.append(f"窗口模式 {o}: {n2}：{st.get('note')}")
cancel_check(inkw, "窗口模式")
extraw = [k for k in stw if k.split(": ", 1)[-1] not in names + [WN]]
check(not extraw, f"窗口模式：名单外的步骤 {extraw}")

print("===== 自检结果 =====")
if bad:
    for b in bad:
        print("✗", b)
    sys.exit(1)
print("全部通过")
