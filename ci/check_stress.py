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


def _sysms(l):
    try:
        return int(datetime.datetime.strptime(l[:23], "%Y-%m-%d %H:%M:%S.%f").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
    except ValueError:
        return None


# 对钟：App 每秒写一行 "b2clock wall=<App 墙上毫秒>" 进系统日志；系统日志时间戳 − App 毫秒 的中位数就是钟差，
# 拿 App 的触摸时刻去系统日志里找行之前先加上它
_clk = sorted(s - int(m.group(1)) for l in sysl for m in [re.search(r"b2clock wall=(\d+)", l)] if m for s in [_sysms(l)] if s is not None)
clock_offset = _clk[len(_clk) // 2] if _clk else 0
clock_info = {"n": len(_clk), "offsetMs": clock_offset, "min": _clk[0] if _clk else None, "max": _clk[-1] if _clk else None,
              "spreadMs": (_clk[-1] - _clk[0]) if _clk else None}
# 按 App 时刻排好的 (App 毫秒, 钟差)
_clkt = sorted((int(m.group(1)), st - int(m.group(1))) for l in sysl for m in [re.search(r"b2clock wall=(\d+)", l)] if m for st in [_sysms(l)] if st is not None)
JUMP = 20   # 相邻两行钟差突变 >20ms 算跳变
jumps = [{"atApp": b[0], "at": datetime.datetime.fromtimestamp(b[0] / 1000, datetime.timezone.utc).strftime("%H:%M:%S.%f")[:12],
          "fromMs": a[1], "toMs": b[1], "deltaMs": b[1] - a[1]} for a, b in zip(_clkt, _clkt[1:]) if abs(b[1] - a[1]) > JUMP]
# 漂移速率：按跳变切段，每段（≥60 秒）首尾钟差之差 / 时长
_segs, _cur = [], []
for pt_ in _clkt:
    if _cur and abs(pt_[1] - _cur[-1][1]) > JUMP:
        _segs.append(_cur); _cur = []
    _cur.append(pt_)
if _cur:
    _segs.append(_cur)
drift = [{"from": datetime.datetime.fromtimestamp(g[0][0] / 1000, datetime.timezone.utc).strftime("%H:%M:%S"),
          "to": datetime.datetime.fromtimestamp(g[-1][0] / 1000, datetime.timezone.utc).strftime("%H:%M:%S"),
          "startMs": g[0][1], "endMs": g[-1][1],
          "msPerMin": round((g[-1][1] - g[0][1]) / ((g[-1][0] - g[0][0]) / 60000), 2) if g[-1][0] - g[0][0] >= 60000 else None} for g in _segs]
clock_info.update({"startMs": _clkt[0][1] if _clkt else None, "endMs": _clkt[-1][1] if _clkt else None, "jumps": jumps, "segments": drift})
print("对钟（系统日志 - App）：", clock_info)


def local_clock(t):
    """取消时刻 t（App 钟）前后的局部钟差：±3 秒内至少 5 行、前后两边都有；不够放宽到 ±10 秒；再不够 = 对不上。
    窗口内离散度 ≤50ms、且没有跳变（相邻两行突变 >20ms），才算对得上。"""
    for win in (3000, 10000):
        w_ = [x for x in _clkt if abs(x[0] - t) <= win]
        if len(w_) >= 5 and any(x[0] < t for x in w_) and any(x[0] > t for x in w_):
            offs = sorted(x[1] for x in w_)
            sp = offs[-1] - offs[0]
            jmp = [(a[1], b[1]) for a, b in zip(w_, w_[1:]) if abs(b[1] - a[1]) > JUMP]
            info = {"windowMs": win, "n": len(w_), "offsetMs": offs[len(offs) // 2], "spreadMs": sp, "jumps": jmp}
            info["ok"] = sp <= 50 and not jmp
            return info
    return {"ok": False, "why": "±10 秒内对钟行不到 5 行或只在一边"}

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
#    时刻按对钟扣掉钟差之后比；钟差离散度超过 50ms（或没对上钟）的轮次这一条不成立；
# 2) 取消前后 ±500ms 的系统日志里没有 "stealing the touches"、系统手势识别成功；App 自己的手势识别器（WK* / PK* / DiagRootView 上的）
#    没有在 began / changed / ended——UIKit 挂在窗口上的系统手势门不算（主会话裁定 B），但要排先后：
#    门变 ended 的时刻（KVO 被动看）必须在系统日志 "digitizer did disappear" 之后（= 后果）；门先变 = 另一回事，这一下算失败、单独报；
# 3) 每个配置最多 1 下；
# 4) 取消之后恢复：紧接着下一次点同一个地方（±10 点）一次生效、App 侧 ≤300ms；网页工具条没有残留的按下（web after cancel toolbar state 里 down、touchPending 都是 false）；
# 5) 逐条入账。
setup = set(sent.get("setupResizeDrag") or [])
clines = [l for l in rd(name + ".cancel.log").split("\n") if l.strip() and l not in setup]
SYS_GESTURE = r"stealing the touches|source: SystemGesture|SBFluidSwitcherGesture|LiveWindowResize|SystemGestureRecognized|gesture recognized"


def sys_hits(ms, win, pat, off=None):
    """系统日志里时刻在 App 时刻 ms ±win 内（扣掉钟差 off 后）、匹配 pat 的行：[(换算成 App 钟的毫秒, 行)]"""
    off = clock_offset if off is None else off
    out_ = []
    for l in sysl:
        if not re.search(pat, l):
            continue
        st = _sysms(l)
        if st is not None and abs(st - off - ms) <= win:
            out_.append((st - off, l[:600]))
    return out_


def sys_lines(ms, win, pat, off=None):
    off = clock_offset if off is None else off
    t = datetime.datetime.fromtimestamp((ms + off) / 1000, datetime.timezone.utc)   # App 的时刻换成系统日志的钟
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
    lc = local_clock(t_c)
    off = lc.get("offsetMs", clock_offset)
    digi = [h for h in sys_hits(t_c, 50, r"cancel -- digitizer did disappear", off) if "contacts: contacts: []" not in h[1]]
    # touchIdentifier：App 那行 ids=[touchIdentifier=N,…]（测试模式读的 UITouch 私有变量）跟设备消失那行 contacts 里的对
    mt_ = re.search(r"ids=\[[^\]]*touchIdentifier=(\d+)", l)
    app_tid = int(mt_.group(1)) if mt_ else None
    sys_tids = sorted({int(x_) for h in digi for x_ in re.findall(r"touchIdentifier: (\d+)", h[1])})
    tid_ok = app_tid is not None and app_tid in sys_tids
    digi_hits = [h[1] for h in digi]
    stolen = sys_lines(t_c, 500, SYS_GESTURE, off)
    gm = re.search(r"grs=\[(.*)\]", l)
    grs_ = [g.strip() for g in (gm.group(1).split(",") if gm else [])]
    busy = [g for g in grs_ if re.search(r":(began|changed|ended)$", g) and "SystemGestureGate" not in g]
    gate_in_grs = [g for g in grs_ if "SystemGestureGate" in g]
    # 门的状态变化（KVO，App 钟）：取消前后 2 秒内门变 ended 的时刻，跟设备消失（扣掉钟差后）排先后
    gate_kvo = [(int(mk.group(2)), mk.group(1)) for gl in log for mk in [re.search(r"gate kvo (\S+) -> ended wall=(\d+)", gl)] if mk and abs(int(mk.group(2)) - t_c) <= 2000]
    gate_order = "门没变 ended"
    gate_ok = True
    if any(g.endswith(":ended") for g in gate_in_grs) or gate_kvo:
        if not gate_kvo:
            gate_order, gate_ok = "门是 ended，但 KVO 没记到它几点变的（排不出先后）", False
        elif not digi:
            gate_order, gate_ok = "门变了 ended，但没有对得上的设备消失（排不出先后）", False
        else:
            d0 = min(h[0] for h in digi)
            g0 = min(gate_kvo, key=lambda g: abs(g[0] - t_c))[0]   # 离这次取消最近的那次门变 ended
            gate_order = f"门变 ended 在设备消失之后 {g0 - d0}ms（后果）" if g0 >= d0 else f"门变 ended 在设备消失之前 {d0 - g0}ms（另一回事，单独报）"
            gate_ok = g0 >= d0
    rec = recovery(t_c, x, y)
    ok = lc.get("ok") and bool(digi_hits) and tid_ok and not stolen and not busy and gate_ok and rec.get("ok")
    missing = [k_ for k_, v_ in (("局部对钟", lc.get("ok")), ("±50ms 内 contacts 不空的设备消失", bool(digi_hits)),
                                 ("touchIdentifier 对得上", tid_ok), ("±500ms 无 stealing / 系统手势", not stolen),
                                 ("App 手势闲着", not busy), ("门在设备消失之后才变", gate_ok), ("下一下一次生效无残留", rec.get("ok"))) if not v_]
    cx.append({"line": l[:600], "touchStamp": t_c, "at": [x, y], "localClock": lc, "appTouchIdentifier": app_tid, "sysTouchIdentifiers": sys_tids,
               "missing": missing, "digitizerDisappearedWithContacts": digi_hits[:3],
               "stolenOrSystemGesture±500ms": stolen[:3], "appGesturesNotIdle": busy, "systemGestureGate": gate_in_grs,
               "gateKvoEnded": gate_kvo[:3], "gateOrder": gate_order, "recovery": rec,
               "exempt": ok, "cause": "模拟器虚拟触摸设备在手指按着时被移除" if ok else "不满足不计入的条件"})
    if gate_kvo and digi and not gate_ok:
        bad.append(f"系统手势门先于设备消失变成 ended（单独报）：{gate_order}；{l[:200]}")
exempt = [c for c in cx if c["exempt"]]
n_touch = sum(1 for l in log if re.search(r"touch began (finger|pencil)", l))
cancel_rate = round(len(cx) / n_touch * 100, 3) if n_touch else None
# 裁定：每一下证据缺一样 = 硬失败；单配置 ≥4 下或取消率 >0.5% = 硬失败；≤1 下自动通过；2–3 下"超上限，待人工裁定"（不算通过）
cancel_verdict = "无"
if len(cx) - len(exempt):
    cancel_verdict = "硬失败（证据不齐）"
    bad.append(f"被收走的触摸 {len(cx) - len(exempt)} 下证据不齐（硬失败）：{[{'line': c['line'][:160], 'missing': c['missing']} for c in cx if not c['exempt']][:3]}")
elif len(cx) >= 4 or (cancel_rate is not None and cancel_rate > 0.5):
    cancel_verdict = f"硬失败（{len(cx)} 下，取消率 {cancel_rate}%）"
    bad.append(f"模拟器拔掉虚拟触摸设备造成的取消 {len(cx)} 下、取消率 {cancel_rate}%（单配置 ≥4 下或 >0.5% 硬失败）")
elif len(cx) > 1:
    cancel_verdict = f"超上限，待人工裁定（{len(cx)} 下，证据齐全）"
    bad.append(f"模拟器拔掉虚拟触摸设备造成的取消 {len(cx)} 下，超过每配置 1 下的自动通过线：超上限，待人工裁定（不算通过）")
elif cx:
    cancel_verdict = "1 下，证据齐全，单列不计入"
print("被收走的触摸：", cancel_verdict, f"（{len(cx)} 下 / 触摸 {n_touch} 下，取消率 {cancel_rate}%）")
cancels = clines

# ---- 系统手势门：每下触摸结束 / 取消时的状态分布（不判，只记；看 ended 有没有区分力）----
gate_dist = {}
for l in log:
    mg = re.search(r"touch end gate phase=(\w+) gate=(\w+)", l)
    if mg:
        dd = gate_dist.setdefault(mg.group(1), {})
        dd[mg.group(2)] = dd.get(mg.group(2), 0) + 1
print("系统手势门在触摸结束时的状态：", gate_dist)

# ---- 主线程卡顿（不判，只记）----
gaps = [int(m.group(1)) for l in log for m in [re.search(r"main thread blocked \d+\+(\d+)", l)] if m]

res = {"cfg": cfg, "pass": not bad, "bad": bad,
       "toolbar": {"sent": want, "acted": acts, "liftToAct": dl, "appSide": dapp, "appSideApplied": da, "toolChanges": want_apply},
       "cells": {"sent": nc, "liftToClick": dc, "appSide": dappc, "missing": missing},
       "late": late_list, "appFail": app_fail, "beats": len(beats), "clock": clock_info, "gateAtEnd": gate_dist, "cancelVerdict": cancel_verdict, "cancelRatePct": cancel_rate, "touches": n_touch, "cancels": cx, "setupResizeDrag": sorted(setup),
       "mainThread": {"count": len(gaps), "maxMs": max(gaps) if gaps else 0, "over1s": sum(g >= 1000 for g in gaps)},
       "window": sent.get("window")}
open(os.path.join(out, name + ".json"), "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=1))
print(json.dumps({k: res[k] for k in ("cfg", "pass", "bad", "toolbar", "cells", "late", "mainThread", "clock", "gateAtEnd", "cancelVerdict", "cancelRatePct")}, ensure_ascii=False))
for c in cx:
    print("CANCEL", c["line"][:300])
    print("   exempt:", c["exempt"], "recovery:", c["recovery"])
    for s_ in c["digitizerDisappearedWithContacts"] + c["stolenOrSystemGesture±500ms"]:
        print("   SYS", s_[:300])
sys.exit(0 if not bad else 1)
