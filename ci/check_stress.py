"""边缘压力测试的判定（ci/sim_stress.sh 跑完 testStress 后调）。用法：python3 ci/check_stress.py <输出目录> <配置名>

全从 App 自己记的时刻算（墙上毫秒），不看 XCUITest 什么时候返回：
- 工具条：每个按钮网页执行的次数 = 点的次数（一下都不能丢）；每一下 抬手→网页执行 ≤300ms；
  笔 / 橡皮每一下 抬手→画布换上（tool applied 的 wall）≤300ms。
- 题格：每一下触摸抬起后，下一下按下之前，网页要收到 click，抬手→click ≤300ms。
- 被系统 / 手势收走的触摸（App 记的 native touch cancelled、网页的 pointercancel / touchcancel）：除了窗口模式开头测试自己拖缩放把手那一下，必须 0。
  有的话，按时刻前后 50ms 在系统日志里找 "stealing the touches"、"digitizer did disappear" 等行一起写进结果。
- 主线程 ≥250ms 卡顿：次数、最长，写进结果（不判）。
结果写 <输出目录>/stress-<配置名>.json，不通过时退出 1。
"""
import datetime
import json
import os
import re
import sys

out, cfg = sys.argv[1], sys.argv[2]
name = "stress-" + cfg
bad = []


def rd(fn):
    try:
        return open(os.path.join(out, fn), encoding="utf-8", errors="replace").read()
    except OSError:
        return ""


log = rd(name + ".ink.log").split("\n")
try:
    sent = json.loads(rd(name + ".sent.json") or "{}")
except ValueError:
    sent = {}


def section(a, b):
    i = next((k for k, l in enumerate(log) if "test cmd mark " + a in l), None)
    j = next((k for k, l in enumerate(log) if "test cmd mark " + b in l), None)
    return log[i:j] if i is not None and j is not None else []


def dist(v):
    if not v:
        return {"n": 0}
    v = sorted(v)
    n = len(v)
    return {"n": n, "min": v[0], "p50": v[n // 2], "p90": v[int(n * 0.9)], "p99": v[min(n - 1, int(n * 0.99))], "max": v[-1],
            "over300": sum(x > 300 for x in v)}


sysl = (rd("system-gestures-stress.log") or "").split("\n")

# 主线程存活看门狗：主线程每次执行看门狗丢过去的任务的时刻（墙上毫秒，约每 50 毫秒一次）
beats = sorted(int(x) for x in rd(name + ".beats.log").split() if x.strip().isdigit())


def max_beat_gap(a, b):
    """[a, b] 这段时间里主线程心跳的最大间隔（含两头到最近心跳的距离）；这段里一下心跳都没有就返回 None"""
    import bisect
    lo, hi = bisect.bisect_left(beats, a), bisect.bisect_right(beats, b)
    inside = beats[lo:hi]
    if not inside:
        return None
    pts = [a] + inside + [b]
    return max(pts[k + 1] - pts[k] for k in range(len(pts) - 1))


# 主会话裁定（B + 5 条）：
# 1) 晚到（触摸时间戳→sendEvent 收到）>250ms 的那一下：[时间戳, 收到] 里主线程心跳相邻间隔最大值 ≤100ms 才算 App 无责，否则算 App 失败；
# 2) App 侧（收到→生效；换工具量到 tool applied，其余量到网页执行）每一下 ≤300ms，不豁免；
# 3) 每个配置晚到 >250ms 的不超过 3 下；
# 4) 每一下晚到的逐条记：按钮、第几下、时间戳、收到时刻、晚到、窗口内最大心跳间隔、App 侧；
# 5) 晚到 / App 侧也写进正式包的日志（App 那边 toolbar tap 行的 late= app=）。
late_list, app_fail = [], []


def judge_late(kind, idx, stamp, recv, app_ms):
    late = recv - stamp
    if late <= 250:
        return
    gap = max_beat_gap(stamp, recv)
    rec = {"what": kind, "nth": idx, "touchStamp": stamp, "sendEventRecv": recv, "lateMs": late,
           "maxMainBeatGapMs": gap, "appSideMs": app_ms, "appBlameless": gap is not None and gap <= 100}
    late_list.append(rec)


# ---- 工具条 ----
tb = section("stress-toolbar-start", "stress-toolbar-end")
acts, lta, app_tb, applied = {}, [], [], []
cur_tool, want_apply, pend, n_tap = "pen", 0, None, 0
for l in tb:
    m = re.search(r"toolbar tap (\S+) down=(\d+) lift=(\d+) act=(\d+) lift_to_act=(-?\d+) late=(-?\d+) app=(-?\d+) lift_recv=(\d+)", l)
    if m:
        a, lift, act, v, late, app, lrecv = m.group(1), int(m.group(3)), int(m.group(4)), int(m.group(5)), int(m.group(6)), int(m.group(7)), int(m.group(8))
        n_tap += 1
        acts[a] = acts.get(a, 0) + 1
        lta.append(v)
        app_tb.append(app)
        if app < 0 or app > 300:
            app_fail.append({"what": "toolbar " + a, "nth": n_tap, "appSideMs": app, "liftToAct": v})
        judge_late("toolbar " + a, n_tap, lift, lrecv, app)
        if a in ("pen", "eraser") and a != cur_tool:
            want_apply += 1
            cur_tool = a
            pend = (lift, lrecv, a, n_tap)
        else:
            pend = None
        continue
    m = re.search(r"tool applied .* wall=(\d+)", l)
    if m and pend is not None:
        w = int(m.group(1))
        applied.append(w - pend[1])   # App 侧：sendEvent 收到 → 画布换上
        if w - pend[1] > 300:
            app_fail.append({"what": "tool applied " + pend[2], "nth": pend[3], "appSideMs": w - pend[1], "liftToApplied": w - pend[0]})
        pend = None
want = sent.get("sentToolbar") or {}
for k, n in want.items():
    if k == "reopen":
        continue
    if acts.get(k, 0) != n:
        bad.append(f"工具条 {k}：点了 {n} 下，网页执行了 {acts.get(k, 0)} 下")
if not want:
    bad.append("工具条：没点（没找到按钮？）" + str(sent.get("btnFound")))
dl, dapp, da = dist(lta), dist(app_tb), dist(applied)
if want_apply and da.get("n", 0) < want_apply:
    bad.append(f"笔 / 橡皮：换了 {want_apply} 次工具，画布换工具只记到 {da.get('n', 0)} 次")

# ---- 题格 ----
cl = section("stress-cells-start", "stress-cells-end")
clicks, app_cl, missing, cur_end, got, n_cell = [], [], 0, None, True, 0
for l in cl:
    m = re.search(r"touch (ended|began) finger t=(\d+) recv=(\d+)", l)
    if m:
        if m.group(1) == "began":
            if cur_end is not None and not got:
                missing += 1
            cur_end, got = None, True
        else:
            cur_end, got = (int(m.group(2)), int(m.group(3))), False
        continue
    m = re.search(r"web click .* t=(\d+)", l)
    if m and cur_end is not None and not got:
        n_cell += 1
        t = int(m.group(1))
        clicks.append(t - cur_end[0])
        app = t - cur_end[1]
        app_cl.append(app)
        if app > 300:
            app_fail.append({"what": "click (tag / cell)", "nth": n_cell, "appSideMs": app, "liftToClick": t - cur_end[0]})
        judge_late("click (tag / cell)", n_cell, cur_end[0], cur_end[1], app)
        got = True
if cur_end is not None and not got:
    missing += 1
dc, dappc = dist(clicks), dist(app_cl)
nc = sent.get("sentCells", 0)
if not nc:
    bad.append("题格：没点（没找到题号或题格）")
if missing:
    bad.append(f"题格 / 题号：{missing} 下触摸之后网页没收到 click")

# ---- 判定 ----
if not beats:
    bad.append("没有主线程心跳数据（<名字>.beats.log）：晚到的一律算 App 的失败")
if app_fail:
    bad.append(f"App 侧（收到→生效）超过 300ms 的 {len(app_fail)} 下：{app_fail[:4]}")
blamed = [x for x in late_list if not x["appBlameless"]]
if blamed:
    bad.append(f"晚到 >250ms 且那段时间主线程心跳有 >100ms 空洞（或没数据）的 {len(blamed)} 下，算 App 的：{blamed[:4]}")
if len(late_list) > 3:
    bad.append(f"晚到 >250ms 的 {len(late_list)} 下，超过每个配置 3 下的上限")

# ---- 被收走的触摸 ----
setup = set(sent.get("setupResizeDrag") or [])
cancels = [l for l in rd(name + ".cancel.log").split("\n") if l.strip() and l not in setup]
def near(ms):
    t = datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc)
    lo, hi = t - datetime.timedelta(milliseconds=50), t + datetime.timedelta(milliseconds=50)
    hits = []
    for l in sysl:
        if not re.search(r"stealing the touches|digitizer did disappear|cancel", l):
            continue
        try:
            lt = datetime.datetime.strptime(l[:23], "%Y-%m-%d %H:%M:%S.%f").replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            continue
        if lo <= lt <= hi:
            hits.append(l[:300])
    return hits[:8]


cx = []
for l in cancels:
    m = re.search(r"t=(\d+)", l)
    cx.append({"line": l[:400], "system": near(int(m.group(1))) if m else []})
if cancels:
    bad.append(f"被收走的触摸 {len(cancels)} 次（不含测试拖缩放把手那 {len(setup)} 条）")

# ---- 主线程卡顿（不判，只记）----
gaps = [int(m.group(1)) for l in log for m in [re.search(r"main thread blocked \d+\+(\d+)", l)] if m]

res = {"cfg": cfg, "pass": not bad, "bad": bad,
       "toolbar": {"sent": want, "acted": acts, "liftToAct": dl, "appSide": dapp, "appSideApplied": da, "toolChanges": want_apply},
       "cells": {"sent": nc, "liftToClick": dc, "appSide": dappc, "missing": missing},
       "late": late_list, "appFail": app_fail, "beats": len(beats), "cancels": cx, "setupResizeDrag": sorted(setup),
       "mainThread": {"count": len(gaps), "maxMs": max(gaps) if gaps else 0, "over1s": sum(g >= 1000 for g in gaps)},
       "window": sent.get("window")}
open(os.path.join(out, name + ".json"), "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=1))
print(json.dumps({k: res[k] for k in ("cfg", "pass", "bad", "toolbar", "cells", "late", "mainThread")}, ensure_ascii=False))
for c in cx:
    print("CANCEL", c["line"])
    for s in c["system"]:
        print("   SYS", s)
sys.exit(0 if not bad else 1)
