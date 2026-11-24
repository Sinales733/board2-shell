"""App 主线程 ≥250ms 卡顿逐条归类。用法：python3 ci/classify_stalls.py <输出目录>

每条 "main thread blocked <起点墙上毫秒>+<时长>(after <名字>)"：
- after 后面有名字：卡在 App 自己量着的那段活里（msg-state 处理网页状态、setDrawing 换画布、probe-write 写测试状态文件……）；
- 没有名字（after -）：看那段时间是否落在测试动作（<名字>.testmarks.log 里每个 XCUITest 动作的起止）里——
  XCUITest 点按 / 拖动前要查元素、等 App 空闲，这些查询在 App 主线程上跑；落在里面算"测试环境：XCUITest 动作期间"；
- 都不是：未归类。
另外把同一时段里 App 记的 slow <活>@起点+时长 一起列出。输出每类次数、最长，写 <输出目录>/stalls.json。
"""
import glob
import json
import os
import re
import sys

out = sys.argv[1]
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
    slows = [(int(m.group(2)), int(m.group(3)), m.group(1)) for l in lines for m in [re.search(r"slow (\S+)@(\d+)\+(\d+)", l)] if m]
    cats = {}
    for l in lines:
        m = re.search(r"main thread blocked (\d+)\+(\d+)\(after ([^)]*)\)", l)
        if not m:
            continue
        s, d, a = int(m.group(1)), int(m.group(2)), m.group(3)
        e = s + d
        if a != "-":
            c = "App: " + a
        else:
            sl = [x for x in slows if x[0] < e and x[0] + x[1] > s]
            if sl:
                c = "App: " + max(sl, key=lambda x: x[1])[2]
            elif any(ms < e and me > s for ms, me, _ in marks):
                c = "测试环境: XCUITest 动作期间"
            elif not marks:
                c = "未归类（这份日志没有测试动作记录）"
            else:
                c = "未归类"
        x = cats.setdefault(c, {"count": 0, "maxMs": 0, "sumMs": 0})
        x["count"] += 1; x["maxMs"] = max(x["maxMs"], d); x["sumMs"] += d
    if cats:
        res[name] = cats
open(os.path.join(out, "stalls.json"), "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=1))
for n, cats in res.items():
    print(n)
    for c, x in sorted(cats.items(), key=lambda kv: -kv[1]["count"]):
        print(f"   {c}: {x['count']} 次，最长 {x['maxMs']} ms，共 {x['sumMs']} ms")
