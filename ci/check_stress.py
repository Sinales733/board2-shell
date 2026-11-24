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
state, want_apply, pend, n_tap = ("pen", "ink"), 0, None, 0   # 画布上的工具状态：(笔 / 橡皮, 颜色)；压力测试开头点过"墨"
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
        new = ("pen", state[1]) if a == "pen" else ("eraser", state[1]) if a == "eraser" else ("pen", a[2:]) if a.startswith("c-") else state
        if new != state:   # 这一下让画布换工具 / 换颜色：要配一行 tool applied
            want_apply += 1
            state = new
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
    bad.append(f"笔 / 橡皮 / 色块：换了 {want_apply} 次工具或颜色，画布换工具只记到 {da.get('n', 0)} 次")

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

# ---- 被收走的触摸（主会话裁定：模拟器拔掉虚拟触摸设备的那种可以不计入，条件全满足才行） ----
# 1) 取消时刻 ±50ms 内有 backboardd "cancel -- digitizer did disappear" 且 contacts 不空（App 拿不到 touchIdentifier，只能按时刻对）；
# 2) 取消前后 ±500ms 的系统日志里没有 "stealing the touches"、系统手势识别成功；App 那行 grs=[…] 里没有手势在 began / changed / ended；
# 3) 每个配置最多 1 下；
# 4) 取消之后恢复：紧接着下一次点同一个地方（±10 点）一次生效、App 侧 ≤300ms；网页工具条没有残留的按下（web after cancel toolbar state 里 down、touchPending 都是 false）；
# 5) 逐条入账。
setup = set(sent.get("setupResizeDrag") or [])
clines = [l for l in rd(name + ".cancel.log").split("\n") if l.strip() and l not in setup]
SYS_GESTURE = r"stealing the touches|source: SystemGesture|SBFluidSwitcherGesture|LiveWindowResize|SystemGestureRecognized|gesture recognized"


def sys_lines(ms, win, pat):
    t = datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc)
    lo, hi = t - datetime.timedelta(milliseconds=win), t + datetime.timedelta(milliseconds=win)
    hits = []
    for l in sysl:
        if not re.search(pat, l):
            continue
        try:
            lt = datetime.datetime.strptime(l[:23], "%Y-%m-%d %H:%M:%S.%f").replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            continue
        if lo <= lt <= hi:
            hits.append(l[:400])
    return hits


def recovery(t_cancel, x, y):
    """取消之后，下一次落在同一个地方（±10 点）的触摸：一次生效、App 侧 ≤300ms"""
    k0 = next((k for k, l in enumerate(log) if f"native touch cancelled" in l and f"t={t_cancel}" in l), None)
    if k0 is None:
        return {"ok": False, "why": "日志里找不到这次取消"}
    state_line = next((l for l in log[k0:k0 + 40] if "web after cancel toolbar state" in l), None)
    st_ok = True
    if state_line is not None:
        st_ok = '"down":false' in state_line and '"touchPending":false' in state_line
    for k in range(k0 + 1, len(log)):
        m = re.search(r"touch began finger t=(\d+) recv=(\d+) at (\d+),(\d+)", log[k])
        if not m or abs(int(m.group(3)) - x) > 10 or abs(int(m.group(4)) - y) > 10:
            continue
        acts_, end_recv = [], None
        for l in log[k + 1:k + 80]:
            if re.search(r"touch began finger", l):
                break
            me = re.search(r"touch ended finger t=\d+ recv=(\d+)", l)
            if me:
                end_recv = int(me.group(1))
            mt = re.search(r"toolbar tap \S+ .* app=(-?\d+)", l)
            if mt:
                acts_.append(int(mt.group(1)))
            mc = re.search(r"web click .* t=(\d+)", l)
            if mc and end_recv:
                acts_.append(int(mc.group(1)) - end_recv)
        ok = len(acts_) == 1 and 0 <= acts_[0] <= 300 and st_ok
        return {"ok": ok, "nextTouch": int(m.group(1)), "acted": len(acts_), "appSideMs": acts_[0] if acts_ else None,
                "toolbarStateAfterCancel": state_line[13:] if state_line else "（网页没收到取消 / 不是工具条）"}
    return {"ok": False, "why": "取消之后没有再点同一个地方"}


cx = []
for l in clines:
    if not l.startswith("native touch cancelled"):
        continue   # 网页那两行（pointercancel / touchcancel）跟着这一下，一起算
    m = re.search(r"t=(\d+) .*?at (\d+),(\d+)", l)
    t_c, x, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    digi_hits = [h for h in sys_lines(t_c, 50, r"cancel -- digitizer did disappear") if "contacts: contacts: []" not in h]
    stolen = sys_lines(t_c, 500, SYS_GESTURE)
    gm = re.search(r"grs=\[(.*)\]", l)
    busy = [g for g in (gm.group(1).split(",") if gm else []) if re.search(r":(began|changed|ended)$", g.strip())]
    rec = recovery(t_c, x, y)
    ok = bool(digi_hits) and not stolen and not busy and rec.get("ok")
    cx.append({"line": l[:600], "touchStamp": t_c, "at": [x, y], "digitizerDisappearedWithContacts": digi_hits[:3],
               "stolenOrSystemGesture±500ms": stolen[:3], "appGesturesNotIdle": busy, "recovery": rec,
               "exempt": ok, "cause": "模拟器虚拟触摸设备在手指按着时被移除" if ok else "不满足不计入的条件"})
exempt = [c for c in cx if c["exempt"]]
if len(cx) - len(exempt):
    bad.append(f"被收走的触摸 {len(cx) - len(exempt)} 下不满足不计入的条件：{[c for c in cx if not c['exempt']][:2]}")
if len(exempt) > 1:
    bad.append(f"模拟器拔掉虚拟触摸设备造成的取消 {len(exempt)} 下，超过每个配置 1 下的上限")
cancels = clines

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
    print("CANCEL", c["line"][:300])
    print("   exempt:", c["exempt"], "recovery:", c["recovery"])
    for s_ in c["digitizerDisappearedWithContacts"] + c["stolenOrSystemGesture±500ms"]:
        print("   SYS", s_[:300])
sys.exit(0 if not bad else 1)
