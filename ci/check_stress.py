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


# 系统日志里模拟器虚拟触摸设备（digitizer）断开 / 接上的时刻（UTC 墙上毫秒）
sysl = (rd("system-gestures-stress.log") or "").split("\n")


def sys_ms(l):
    try:
        return int(datetime.datetime.strptime(l[:23], "%Y-%m-%d %H:%M:%S.%f").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
    except ValueError:
        return None


digi = [(sys_ms(l), l[:240]) for l in sysl if re.search(r"digitizer (detached|attached)|digitizer did disappear", l)]
digi = [d for d in digi if d[0]]


def tod_ms(l):
    h, m_, s_ = l[:12].split(":")
    return int((int(h) * 3600 + int(m_) * 60 + float(s_)) * 1000)


# ---- 工具条 ----
tb = section("stress-toolbar-start", "stress-toolbar-end")
acts, lta, applied, env_slow, real_slow = {}, [], [], [], []
cur_tool, want_apply, pend = "pen", 0, None
arrival = {}   # 触摸自己的时间戳（墙上毫秒）→ App 收到它的时刻（日志行时刻，当天毫秒）
for l in tb:
    m = re.search(r"touch (began|ended) finger t=(\d+)", l)
    if m:
        arrival[int(m.group(2))] = tod_ms(l)
        continue
    m = re.search(r"toolbar tap (\S+) down=(\d+) lift=(\d+) act=(\d+) lift_to_act=(-?\d+)", l)
    if m:
        a, down, lift, act, v = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5))
        acts[a] = acts.get(a, 0) + 1
        lta.append(v)
        if v > 300:
            # 抬手→执行超了：这一下触摸是不是很晚才送到 App，同时模拟器的虚拟触摸设备断开 / 重接过
            arr = arrival.get(lift)
            lag = (arr - lift % 86400000) if arr is not None else None
            app_side = (act % 86400000) - arr if arr is not None else None
            near_d = [d[1] for d in digi if down - 2000 <= d[0] <= lift + (lag or 0)]
            rec = {"tap": a, "liftToAct": v, "arrivalLagMs": lag, "arrivalToActMs": app_side, "digitizer": near_d[:4]}
            # 只记下来帮助查原因（触摸晚送到 App / App 自己慢），不豁免：每一下都要 ≤300ms。
            # 注：模拟器每一下合成触摸都会新接一个虚拟 digitizer、用完断开（r29 压力测试 3000 下各 3000 次），所以"附近有 digitizer 断开 / 接上"说明不了什么
            real_slow.append(rec)
        if a in ("pen", "eraser") and a != cur_tool:
            want_apply += 1
            cur_tool = a
            pend = lift
        else:
            pend = None
        continue
    m = re.search(r"tool applied .* wall=(\d+)", l)
    if m and pend is not None:
        applied.append(int(m.group(1)) - pend)
        pend = None
want = sent.get("sentToolbar") or {}
for k, n in want.items():
    if k == "reopen":
        continue
    if acts.get(k, 0) != n:
        bad.append(f"工具条 {k}：点了 {n} 下，网页执行了 {acts.get(k, 0)} 下")
if not want:
    bad.append("工具条：没点（没找到按钮？）" + str(sent.get("btnFound")))
dl, da = dist(lta), dist(applied)
if real_slow:
    bad.append(f"工具条：抬手→执行 超过 300ms 的 {len(real_slow)} 下：{real_slow[:3]}")
if any(x < 0 for x in lta):
    bad.append(f"工具条：有 {sum(x < 0 for x in lta)} 下 App 没量到抬手时刻")
if da.get("over300"):
    bad.append(f"笔 / 橡皮：抬手→画布换上 超过 300ms 的 {da['over300']} 下，最长 {da['max']}ms")
if want_apply and da.get("n", 0) < want_apply:
    bad.append(f"笔 / 橡皮：换了 {want_apply} 次工具，画布换工具只记到 {da.get('n', 0)} 次")

# ---- 题格 ----
cl = section("stress-cells-start", "stress-cells-end")
clicks, missing, cur_end, got = [], 0, None, True
for l in cl:
    m = re.search(r"touch (ended|began) finger t=(\d+)", l)
    if m:
        if m.group(1) == "began":
            if cur_end is not None and not got:
                missing += 1
            cur_end, got = None, True
        else:
            cur_end, got = int(m.group(2)), False
        continue
    m = re.search(r"web click .* t=(\d+)", l)
    if m and cur_end is not None and not got:
        clicks.append(int(m.group(1)) - cur_end)
        got = True
if cur_end is not None and not got:
    missing += 1
dc = dist(clicks)
nc = sent.get("sentCells", 0)
if not nc:
    bad.append("题格：没点（没找到题号或题格）")
if missing:
    bad.append(f"题格 / 题号：{missing} 下触摸之后网页没收到 click")
if dc.get("over300"):
    bad.append(f"题格 / 题号：抬手→click 超过 300ms 的 {dc['over300']} 下，最长 {dc['max']}ms")

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

res = {"cfg": cfg, "pass": not bad, "bad": bad, "toolbar": {"sent": want, "acted": acts, "liftToAct": dl, "liftToApplied": da, "toolChanges": want_apply,
                  "slow": real_slow},
       "cells": {"sent": nc, "liftToClick": dc, "missing": missing}, "cancels": cx, "setupResizeDrag": sorted(setup),
       "mainThread": {"count": len(gaps), "maxMs": max(gaps) if gaps else 0, "over1s": sum(g >= 1000 for g in gaps)},
       "window": sent.get("window")}
open(os.path.join(out, name + ".json"), "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=1))
print(json.dumps({k: res[k] for k in ("cfg", "pass", "bad", "toolbar", "cells", "mainThread")}, ensure_ascii=False))
for c in cx:
    print("CANCEL", c["line"])
    for s in c["system"]:
        print("   SYS", s)
sys.exit(0 if not bad else 1)
