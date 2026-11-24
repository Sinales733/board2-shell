"""App 主线程 ≥250ms 卡顿逐条归类。用法：python3 ci/classify_stalls.py <输出目录>

每条 "main thread blocked <起点墙上毫秒>+<时长>(after <名字>)" 按下面的顺序归类：
1. 有同一起点的 "stall stack <起点>: …"（测试模式下抓的调用栈）：按栈里的帧归类——
   XCUITest 的 App 内代理（XCTAutomationSupport / XCTest）或无障碍查询（Accessibility、AXRuntime）→ 测试环境；
   PencilKit、WebKit、键盘（UIKeyboard / TextInput）、编辑菜单（UIEditMenu）、剪贴板（Pasteboard）→ 各记各的；
   栈里第一帧是 App 自己的函数 → "App: 函数名"；抓到时主线程已经空闲（mach_msg 等）→ 没抓到现场。
2. 没有栈：after 后面有名字 → "App: 名字"；落在测试动作（<名字>.testmarks.log）时段里 → "测试环境: XCUITest 动作期间"；否则未归类。
输出每类次数、最长，写 <输出目录>/stalls.json。
"""
import glob
import json
import os
import re
import sys

out = sys.argv[1]


def by_stack(frames):
    fr = frames[2:]   # 去掉抓栈自己的信号处理那两帧
    if not fr:
        return None
    for f in fr:
        if any(k in f for k in ("XCTAutomationSupport", "XCTest", "Accessibility", "AXRuntime", "AXCoreUtilities")):
            return "测试环境: XCUITest（App 内代理 / 无障碍查询）"
    top = fr[0]
    if any(k in top for k in ("mach_msg", "CFRunLoopServiceMachPort")):
        return "没抓到现场（抓到时主线程已空闲）"
    for f in fr:
        if "PencilKit" in f:
            return "PencilKit: " + f.split(":", 1)[-1][:50]
        if "UIEditMenu" in f:
            return "系统编辑菜单"
        if "Pasteboard" in f or "PBServerConnection" in f:
            return "剪贴板"
        if "Keyboard" in f or "TextInputUI" in f:
            return "键盘那一套"
        if f.startswith("WebKit:"):
            return "WebKit: " + f.split(":", 1)[-1][:50]
        if f.startswith("Board2Shell:") and "StallSampler" not in f and "MainWatch" not in f:
            return "App: " + f.split(":", 1)[-1][:70]
    return "其他: " + top.split(":", 1)[-1][:50]


res = {}
for f in sorted(glob.glob(os.path.join(out, "*.ink.log"))):
    name = os.path.basename(f)[:-len(".ink.log")]
    marks = []
    mf = os.path.join(out, name + ".testmarks.log")
    if os.path.exists(mf):
        for l in open(mf, encoding="utf-8", errors="replace"):
            p = l.split(" ", 2)
            if len(p) >= 3 and p[0].isdigit() and p[1].isdigit():
                marks.append((int(p[0]), int(p[1]), p[2].strip()))
    lines = open(f, encoding="utf-8", errors="replace").read().split("\n")
    stacks = {}
    for l in lines:
        m = re.search(r"stall stack (\d+): (.*)$", l)
        if m:
            stacks[int(m.group(1))] = m.group(2).split(" | ")
    slows = [(int(m.group(2)), int(m.group(3)), m.group(1)) for l in lines for m in [re.search(r"slow (\S+)@(\d+)\+(\d+)", l)] if m]
    cats = {}
    for l in lines:
        m = re.search(r"main thread blocked (\d+)\+(\d+)\(after ([^)]*)\)", l)
        if not m:
            continue
        s, d, a = int(m.group(1)), int(m.group(2)), m.group(3)
        e = s + d
        c = None
        st = stacks.get(s) or next((v for k, v in stacks.items() if abs(k - s) <= 300), None)
        if st:
            c = by_stack(st)
        if not c:
            if a != "-":
                c = "App: " + a
            else:
                sl = [x for x in slows if x[0] < e and x[0] + x[1] > s]
                if sl:
                    c = "App: " + max(sl, key=lambda x: x[1])[2]
                elif any(ms < e and me > s for ms, me, _ in marks):
                    c = "测试环境: XCUITest 动作期间（没抓到栈）"
                else:
                    c = "未归类（没抓到栈）"
        x = cats.setdefault(c, {"count": 0, "maxMs": 0, "sumMs": 0})
        x["count"] += 1
        x["maxMs"] = max(x["maxMs"], d)
        x["sumMs"] += d
    if cats:
        res[name] = cats
open(os.path.join(out, "stalls.json"), "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=1))
for n, cats in res.items():
    print(n)
    for c, x in sorted(cats.items(), key=lambda kv: -kv[1]["count"]):
        print(f"   {c}: {x['count']} 次，最长 {x['maxMs']} ms，共 {x['sumMs']} ms")
