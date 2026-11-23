import XCTest

/// 云端 iPad 模拟器截图（只在 GitHub Actions 里跑）。
/// 用 UI 测试来跑是因为只有它能真的把模拟器转成横屏（XCUIDevice.orientation）；
/// iPadOS 26 的"窗口化 App"模式下 App 自己请求转屏只会把窗口变小。
/// 每张：带启动参数打开 App → 等 App 写出 <名字>.ready（App 能直接写 Mac 上的文件）→ 截全屏 → 写到 Mac 上的 ~/b2shots/。
/// 不碰 App 的界面元素：页面一直在动，UI 测试读元素会一直等它空闲。
/// 假服务（ci/stub_server.py）的 /_offline、/_online 用来模拟"电脑关了 / 又开了"。
final class ShotsUITests: XCTestCase {

    private let server = "http://127.0.0.1:8409/"
    private lazy var outDir: URL = {
        let host = ProcessInfo.processInfo.environment["SIMULATOR_HOST_HOME"] ?? NSTemporaryDirectory()
        let url = URL(fileURLWithPath: host).appendingPathComponent("b2shots", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    override func setUp() {
        continueAfterFailure = true
    }

    private func http(_ path: String) -> String {
        let sem = DispatchSemaphore(value: 0)
        var out = ""
        var r = URLRequest(url: URL(string: server + path)!)
        r.timeoutInterval = 5
        URLSession.shared.dataTask(with: r) { d, _, e in
            out = d.flatMap { String(data: $0, encoding: .utf8) } ?? "ERR \(String(describing: e))"
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 8)
        return out
    }

    private func write(_ name: String, _ text: String) {
        try? text.write(to: outDir.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }

    /// 打开 App 摆好一个画面并截图。返回 App 报告的值（自检结果）。
    @discardableResult
    private func shot(_ name: String, scene: String, orient: UIDeviceOrientation, theme: String,
                      extra: [String] = [], screenshot: Bool = true, wait: TimeInterval = 45) -> String {
        XCUIDevice.shared.orientation = orient
        let app = XCUIApplication()
        let readyURL = outDir.appendingPathComponent(name + ".ready")
        let valueURL = outDir.appendingPathComponent(name + ".value.json")
        try? FileManager.default.removeItem(at: readyURL)
        app.launchEnvironment = ["B2_OUT": outDir.path, "B2_NAME": name]
        app.launchArguments = ["-b2shot", scene, "-b2theme", theme, "-b2q", "2009-01", "-b2at", "3"]
            + (extra.contains("-b2server") ? [] : ["-b2server", server]) + extra
        app.launch()
        XCUIDevice.shared.orientation = orient
        var ready = false
        let deadline = Date().addingTimeInterval(wait)
        while Date() < deadline {
            if FileManager.default.fileExists(atPath: readyURL.path) { ready = true; break }
            Thread.sleep(forTimeInterval: 0.3)
        }
        Thread.sleep(forTimeInterval: 0.5)
        if screenshot {
            let png = XCUIScreen.main.screenshot().pngRepresentation
            try? png.write(to: outDir.appendingPathComponent(name + ".png"))
        }
        let value = (try? String(contentsOf: valueURL, encoding: .utf8)) ?? ""
        let log = (try? String(contentsOf: outDir.appendingPathComponent(name + ".log"), encoding: .utf8)) ?? ""
        write(name + ".txt", "ready=\(ready)\nvalue=\(value)\nlog:\n\(log)\n")
        print("SHOT \(name) ready=\(ready) value=\(value)")
        if !log.isEmpty { print("SHOT \(name) log:\n\(log)") }
        app.terminate()
        return value
    }

    private let orients: [(String, UIDeviceOrientation)] = [("landscape", .landscapeLeft), ("portrait", .portrait)]
    private let themes = ["night", "day"]

    /// 动效录像用（CI 在跑这个测试的时候用 simctl 录屏）：启动淡入 + 设置面板开关两次；再断开电脑：离线标记出现、收起、展开、收起。
    func testMotion() {
        _ = http("_online")
        for t in themes {
            shot("motion-settings-\(t)", scene: "motion", orient: .landscapeLeft, theme: t, screenshot: false, wait: 80)   // 模拟器刚开机时第一次启动偶尔很慢
        }
        _ = http("_offline")
        for t in themes {
            shot("motion-offline-\(t)", scene: "motion-offline", orient: .landscapeLeft, theme: t, screenshot: false, wait: 40)
        }
        _ = http("_online")
        XCUIDevice.shared.orientation = .portrait
    }

    // MARK: - 真实触摸测草稿纸（1.8：PencilKit 画布 + 网页工具条）

    /// 全走真实触摸、每个点击只点一次。模拟器造不出 Apple Pencil：要写字时用命令让画布"手指也写"（finger on），
    /// 其余时候手指按真机规则（工具条手指书写关 = 只认笔，手指只挪纸缩放）。每一步都读 App 写出的状态核对；结果写 inktest.json。
    /// 坐标以网页视图（铺满屏幕）为基准按比例换算：之前按 App 左上角加偏移算，和实际落点差约 1.107 倍。
    func testInk() {
        _ = http("_online")
        var steps: [[String: Any]] = []
        for (o, ori) in [("portrait", UIDeviceOrientation.portrait), ("landscape", .landscapeLeft)] {
            steps += inkRun(o, ori)
        }
        let pass = !steps.isEmpty && steps.allSatisfy { ($0["ok"] as? Bool) == true }
        let obj: [String: Any] = ["pass": pass, "steps": steps]
        if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) {
            try? d.write(to: outDir.appendingPathComponent("inktest.json"))
        }
        XCUIDevice.shared.orientation = .portrait
    }

    private func inkRun(_ o: String, _ ori: UIDeviceOrientation) -> [[String: Any]] {
        let name = "inktest-\(o)"
        XCUIDevice.shared.orientation = ori
        let app = XCUIApplication()
        let readyURL = outDir.appendingPathComponent(name + ".ready")
        let stateURL = outDir.appendingPathComponent(name + ".state.json")
        let cmdURL = outDir.appendingPathComponent(name + ".cmd")
        var steps: [[String: Any]] = []
        func step(_ n: String, _ ok: Bool, _ note: String) {
            steps.append(["name": "\(o): \(n)", "ok": ok, "note": note])
            print("INK \(o): \(n) ok=\(ok) \(note)")
        }
        // 不带 -b2at：页面不进"安静模式"，顶上那组按钮（含网页的草稿纸按钮）和正式页一样显示
        func launch() {
            for u in [readyURL, stateURL, cmdURL] { try? FileManager.default.removeItem(at: u) }
            app.launchEnvironment = ["B2_OUT": outDir.path, "B2_NAME": name]
            app.launchArguments = ["-b2shot", "inktest", "-b2theme", "night", "-b2q", "2009-01", "-b2server", server]
            app.launch()
            XCUIDevice.shared.orientation = ori
            let deadline = Date().addingTimeInterval(45)
            while Date() < deadline && !FileManager.default.fileExists(atPath: readyURL.path) { Thread.sleep(forTimeInterval: 0.3) }
            Thread.sleep(forTimeInterval: 1.5)
        }
        for u in [outDir.appendingPathComponent(name + ".ink.log")] { try? FileManager.default.removeItem(at: u) }
        launch()

        func state() -> [String: Any] {
            guard let d = try? Data(contentsOf: stateURL), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
            return o
        }
        func native() -> [String: Any] { state()["native"] as? [String: Any] ?? [:] }
        func web() -> [String: Any] { state()["web"] as? [String: Any] ?? [:] }
        func count() -> Int { native()["count"] as? Int ?? -1 }
        func prints() -> [String] { native()["prints"] as? [String] ?? [] }
        func nview() -> [Double] { native()["view"] as? [Double] ?? [] }
        func tool() -> String { native()["tool"] as? String ?? "?" }
        func wbtn(_ k: String) -> [Double]? { (web()["btn"] as? [String: Any])?[k] as? [Double] }
        func waitCount(_ want: Int, _ t: TimeInterval = 4) -> Int {
            let end = Date().addingTimeInterval(t); var c = count()
            while Date() < end {
                c = count()
                if c == want { Thread.sleep(forTimeInterval: 0.8); return count() }
                Thread.sleep(forTimeInterval: 0.2)
            }
            return c
        }
        func cmd(_ c: String) { try? c.write(to: cmdURL, atomically: true, encoding: .utf8); Thread.sleep(forTimeInterval: 1.0) }
        func wh() -> (Double, Double) { ((web()["W"] as? Double) ?? 820, (web()["H"] as? Double) ?? 1180) }
        // 以网页视图（铺满屏幕）为基准，按比例换算坐标
        let base = app.webViews.firstMatch
        _ = base.waitForExistence(timeout: 10)
        func at(_ x: Double, _ y: Double) -> XCUICoordinate {
            let (W, H) = wh()
            return base.coordinate(withNormalizedOffset: CGVector(dx: x / W, dy: y / H))
        }
        func drag(_ a: (Double, Double), _ b: (Double, Double), velocity: CGFloat = 250, press: TimeInterval = 0.3, hold: TimeInterval = 0.3) {
            at(a.0, a.1).press(forDuration: press, thenDragTo: at(b.0, b.1), withVelocity: XCUIGestureVelocity(velocity), thenHoldForDuration: hold)
            Thread.sleep(forTimeInterval: 0.6)
        }
        func tapRect(_ r: [Double]?) -> Bool {
            guard let r = r, r.count == 4, r[2] > 0 else { return false }
            at(r[0] + r[2] / 2, r[1] + r[3] / 2).tap()
            Thread.sleep(forTimeInterval: 1.0)
            return true
        }
        /// 工具条还在、可点：网页说它显示着，App 画布也把那块让出来了（点它不会留笔画，由后面每次点工具条时核对笔画数）
        func toolbarOK() -> Bool { (web()["dtoolShown"] as? Bool) == true && (web()["dtool"] as? [Double]).map { $0[2] > 0 } == true }
        /// 落点：笔画起点、终点和要求的拖动起止点比。阈值 6 点：画画手势结束时系统报的抬手位置和笔画最后一点差 ≤1 点（上一轮 13 笔实测），
        /// 再给按下前的 0.3 秒停顿、PencilKit 的点平滑留几点余量；比笔画粗细（2.4）的两倍多一点。
        func strokeErr(_ a: (Double, Double), _ b: (Double, Double)) -> (Double, Double) {
            guard let ss = native()["strokes"] as? [[Double]], let s = ss.last, s.count == 4 else { return (9999, 9999) }
            return (hypot(s[0] - a.0, s[1] - a.1), hypot(s[2] - b.0, s[3] - b.1))
        }
        /// 这个点现在有没有被网页的某一层（面板、提示条……）盖着、让给了网页
        func passed(_ x: Double, _ y: Double) -> Bool {
            let rs = native()["passRects"] as? [[Double]] ?? []
            return rs.contains { $0.count == 4 && x >= $0[0] && x <= $0[0] + $0[2] && y >= $0[1] && y <= $0[1] + $0[3] }
        }
        func write(_ label: String, _ a: (Double, Double), _ b: (Double, Double)) {
            // 网页偶尔会短暂弹出一层（提示条之类）盖住纸：等它收掉再写（最多 5 秒），并记下当时开着的是哪层
            var waited = "", t0 = Date()
            while passed(a.0, a.1) && Date().timeIntervalSince(t0) < 5 { waited = " (waited for layer \(web()["aboveOn"] ?? "?"))"; Thread.sleep(forTimeInterval: 0.3) }
            let before = count()
            drag(a, b)
            let after = waitCount(before + 1)
            let (es, ee) = strokeErr(a, b)
            step(label, after == before + 1 && es < 6 && ee < 6 && toolbarOK(),
                 "count \(before)->\(after) start err \(String(format: "%.1f", es)) end err \(String(format: "%.1f", ee)) toolbar=\(toolbarOK())"
                 + waited + (after == before + 1 ? "" : " passRects=\(native()["passRects"] ?? "nil") aboveOn=\(web()["aboveOn"] ?? "nil") policy=\(native()["policy"] ?? "nil")"))
        }
        func viewsMatch() -> (Bool, String) {
            let n = nview(), w = web()["V"] as? [Double] ?? []
            guard n.count == 3, w.count == 3 else { return (false, "n=\(n) w=\(w)") }
            let ok = abs(n[0] - w[0]) < 1.5 && abs(n[1] - w[1]) < 1.5 && abs(n[2] - w[2]) < 0.002
            return (ok, "native \(n.map { Int($0 * 100) }) web \(w.map { Int($0 * 100) })")
        }
        /// 点工具条上的一个按钮（只点一次），点完笔画数不能变（点工具条不能在纸上留笔画）
        func tapTool(_ k: String) -> (Bool, Int, Int) {
            let c0 = count()
            let ok = tapRect(wbtn(k))
            return (ok, c0, count())
        }
        func zone() -> (x0: Double, x1: Double, ys: [Double]) {
            // 写字区：横向在屏幕左边 12%–48%（工具条默认贴右边），纵向中间一段，避开顶上一排按钮
            let (W, H) = wh()
            return (W * 0.12, W * 0.48, (0..<5).map { H * 0.25 + Double($0) * H * 0.08 })
        }

        // ---- a. 打开：真点草稿纸按钮（App 的按钮盖在网页按钮原来的位置） ----
        let ready = FileManager.default.fileExists(atPath: readyURL.path)
        let tg0 = native()["toggle"] as? [Double] ?? [], wb = web()["draftBtn"] as? [Double] ?? []
        var centerDiff = 9999.0
        if tg0.count == 4, wb.count == 4, wb[2] > 0 { centerDiff = hypot((tg0[0] + tg0[2] / 2) - (wb[0] + wb[2] / 2), (tg0[1] + tg0[3] / 2) - (wb[1] + wb[3] / 2)) }
        step("ready, closed, native button over web button", ready && (web()["open"] as? Bool) == false && (native()["toggleHidden"] as? Bool) == false && centerDiff < 1.5,
             "ready=\(ready) toggle=\(tg0) webBtn=\(wb) center diff \(String(format: "%.2f", centerDiff))")
        let tgEl = app.buttons.matching(identifier: "b2draftToggle").firstMatch
        func tapToggle() -> Bool {
            guard tgEl.waitForExistence(timeout: 3), tgEl.isHittable else { return false }
            tgEl.tap(); Thread.sleep(forTimeInterval: 1.2); return true
        }
        let t1 = tapToggle()
        step("open by tapping draft button (one tap)", t1 && (web()["open"] as? Bool) == true && (native()["open"] as? Bool) == true && toolbarOK(),
             "tapped=\(t1) web=\(web()["open"] ?? "nil") canvas=\(native()["open"] ?? "nil") toolbar=\(toolbarOK())")

        // ---- 写 5 笔（命令让手指也写；先把这道题的新笔迹清零，横屏那一轮不受竖屏留下的笔画影响） ----
        cmd("reset")
        cmd("finger on")
        var z = zone()
        for i in 0..<5 { write("stroke \(i + 1)", (z.x0, z.ys[i]), (z.x1, z.ys[i] + 20)) }

        // ---- 工具条：橡皮 → 沿第 5 笔擦，第 1–4 笔逐点不变 ----
        let five = prints()
        var (ok, c0, c1) = tapTool("eraser")
        Thread.sleep(forTimeInterval: 0.6)
        step("toolbar eraser (one tap)", ok && tool().hasPrefix("eraser") && (web()["tool"] as? String) == "eraser" && c1 == c0, "tool=\(tool()) count \(c0)->\(c1)")
        drag((z.x0 - 20, z.ys[4] - 1), (z.x1 + 20, z.ys[4] + 21), velocity: 200)
        Thread.sleep(forTimeInterval: 1.0)
        let afterErase = prints()
        let kept4 = five.count >= 5 && Array(five.dropLast()).allSatisfy { afterErase.contains($0) }
        step("erase leaves other strokes untouched", kept4 && !afterErase.contains(five.last ?? "-") && toolbarOK(),
             "before \(five.count) after \(afterErase.count) untouched=\(kept4)")
        // 撤销（工具条）：擦掉的那笔回来，5 笔逐点和擦之前一样
        (ok, c0, c1) = tapTool("undo")
        step("toolbar undo restores erased stroke", ok && waitCount(five.count) == five.count && prints() == five, "count \(c0)->\(count())")
        (ok, c0, c1) = tapTool("pen")
        step("toolbar pen (one tap)", ok && tool().hasPrefix("ink") && c1 == c0, "tool=\(tool())")
        // 颜色：点颜色 → 点红 → 下一笔是红的
        _ = tapTool("color")
        let pal = (web()["pal"] as? Bool) == true
        (ok, c0, c1) = tapTool("red")
        step("toolbar color red", pal && ok && (native()["color"] as? String) == "red" && c1 == c0, "palette=\(pal) native color=\(native()["color"] ?? "nil")")
        write("red stroke", (z.x0, z.ys[0] + 40), (z.x1, z.ys[0] + 50))
        step("new stroke is red", (native()["lastColor"] as? String) == "red", "lastColor=\(native()["lastColor"] ?? "nil")")
        // 撤销：少一笔
        let c5 = count()
        (ok, c0, c1) = tapTool("undo")
        step("toolbar undo removes last stroke", ok && waitCount(c5 - 1) == c5 - 1, "count \(c5)->\(count())")
        _ = tapTool("pen")

        // ---- 只认笔（真机规则）：手指点工具条、点纸、挪纸、缩放 ----
        cmd("finger auto")
        step("pencilOnly by default", (native()["policy"] as? String) == "pencilOnly", "policy=\(native()["policy"] ?? "nil")")
        let kept = count()
        (ok, c0, c1) = tapTool("eraser")
        step("finger tap on toolbar works under pencilOnly", ok && tool().hasPrefix("eraser") && c1 == c0, "tool=\(tool())")
        _ = tapTool("pen")
        _ = tapRect([z.x0 + 50, z.ys[2] + 30, 20, 20])
        step("finger tap on paper: no stroke, toolbar still there", count() == kept && toolbarOK(), "count \(kept)->\(count())")
        let v0 = nview()
        drag((z.x0 + 40, z.ys[2]), (z.x0 + 140, z.ys[2] + 90), velocity: 200, press: 0.05, hold: 0.8)
        Thread.sleep(forTimeInterval: 1.0)
        let v1 = nview()
        let moved = v0.count == 3 && v1.count == 3 && abs((v1[0] - v0[0]) - 100) < 25 && abs((v1[1] - v0[1]) - 90) < 25
        step("one finger pans paper, toolbar still there", moved && count() == kept && toolbarOK(), "view \(v0.map { Int($0) }) -> \(v1.map { Int($0) }) count=\(count())")
        let (vm, vnote) = viewsMatch()
        step("old draft follows canvas", vm, vnote)
        let zz0 = nview().last ?? 1
        base.pinch(withScale: 0.6, velocity: -1.0)   // 捏合（两指从远处往中间收）：起点两指隔得开，滚动视图稳定认成缩放
        Thread.sleep(forTimeInterval: 1.5)
        let zz1 = nview().last ?? 1
        step("pinch zoom: no stroke, toolbar still there", count() == kept && abs(zz1 - zz0) > 0.15 && toolbarOK(), "count \(kept)->\(count()) z \(zz0)->\(zz1)")
        let (vm2, vnote2) = viewsMatch()
        step("old draft follows zoom", vm2, vnote2)
        // 手指书写开关：更多 → 开关，规则跟着变；再关回去
        _ = tapTool("more")
        (ok, c0, c1) = tapTool("finger")
        let pOn = native()["policy"] as? String ?? "?"
        step("finger switch on -> anyInput", ok && (web()["finger"] as? Bool) == true && pOn == "anyInput" && c1 == c0, "web finger=\(web()["finger"] ?? "nil") policy=\(pOn)")
        (ok, c0, c1) = tapTool("finger")
        let pOff = native()["policy"] as? String ?? "?"
        step("finger switch off -> pencilOnly", ok && (web()["finger"] as? Bool) == false && pOff == "pencilOnly" && c1 == c0, "web finger=\(web()["finger"] ?? "nil") policy=\(pOff)")
        _ = tapRect([z.x0 + 60, z.ys[3], 10, 10])   // 点纸收起“更多”
        // 拖手柄：往下拖 150 点，工具条跟着往下挪（松手贴回同一边），纸上不多笔画
        if let g = wbtn("grip"), g.count == 4, let d0 = web()["dtool"] as? [Double], d0.count == 4 {
            let c = count()
            drag((g[0] + g[2] / 2, g[1] + g[3] / 2), (g[0] + g[2] / 2 - 30, g[1] + g[3] / 2 + 150), velocity: 300, press: 0.2, hold: 0.2)
            Thread.sleep(forTimeInterval: 1.0)
            let d1 = web()["dtool"] as? [Double] ?? d0
            step("drag grip moves toolbar, no stroke", d1[1] - d0[1] > 60 && count() == c && toolbarOK(), "toolbar top \(Int(d0[1]))->\(Int(d1[1])) count \(c)->\(count())")
            if let g2 = wbtn("grip") { drag((g2[0] + g2[2] / 2, g2[1] + g2[3] / 2), (g2[0] + g2[2] / 2, g2[1] + g2[3] / 2 - 150), velocity: 300, press: 0.2, hold: 0.2) }
            Thread.sleep(forTimeInterval: 1.0)
        } else { step("drag grip moves toolbar, no stroke", false, "no grip rect") }

        // ---- 缩放以后写字：落点对得上 ----
        cmd("finger on")
        z = zone()
        write("stroke after zoom", (z.x0 + 20, z.ys[1] + 30), (z.x1 - 20, z.ys[1] + 45))
        _ = tapTool("undo")

        // ---- 清空：点一次 → 确认态；等超时 → 恢复；点两次 → 新旧笔迹都清；撤销 → 新笔迹回来（旧的也回来） ----
        let n0 = count(), v2a = web()["v2"] as? Int ?? -1
        (ok, c0, c1) = tapTool("clear")
        step("clear first tap: confirm state, nothing cleared", ok && (web()["clearSure"] as? Bool) == true && (web()["sureShown"] as? Bool) == true && count() == n0,
             "sure=\(web()["clearSure"] ?? "nil") bubble=\(web()["sureShown"] ?? "nil") count \(n0)->\(count()) v2=\(v2a)")
        Thread.sleep(forTimeInterval: 4.0)
        step("clear confirm times out", (web()["clearSure"] as? Bool) == false && count() == n0, "sure=\(web()["clearSure"] ?? "nil") count=\(count())")
        _ = tapTool("clear")
        (ok, c0, c1) = tapTool("clear")
        let n1 = waitCount(0)
        step("clear twice: native and old draft both 0", n1 == 0 && (web()["v2"] as? Int) == 0, "native \(n0)->\(n1) v2 \(v2a)->\(web()["v2"] ?? "nil")")
        (ok, c0, c1) = tapTool("undo")
        let n2 = waitCount(n0)
        Thread.sleep(forTimeInterval: 0.5)
        step("undo after clear restores", n2 == n0 && (web()["v2"] as? Int) == v2a, "native ->\(n2) (want \(n0)) v2 ->\(web()["v2"] ?? "nil") (want \(v2a))")
        let keptPrints = prints()

        // ---- 只认笔时开着点页面：页面收不到；原生按钮收起（一次）；收起后第一下到页面；再点按钮打开（一次），笔画还在 ----
        cmd("finger auto")
        // 点页面：点题干正文（点了不触发任何操作，不会弹出面板盖住草稿纸按钮）
        let (W0, H0) = wh()
        let stem = web()["stem"] as? [Double] ?? []
        let pageR: [Double] = stem.count == 4 && stem[2] > 40 ? [stem[0] + stem[2] / 2 - 10, stem[1] + min(stem[3], 60) / 2 - 10, 20, 20] : [W0 * 0.3, H0 * 0.75, 40, 40]
        let p0 = web()["clicks"] as? Int ?? -1
        _ = tapRect(pageR)
        let p1 = web()["clicks"] as? Int ?? -1
        step("open: tap on page is blocked", p1 == p0 && count() == n0, "page pointerdowns \(p0)->\(p1)")
        let t2 = tapToggle()
        step("close by native button (one tap)", t2 && (web()["open"] as? Bool) == false && (native()["open"] as? Bool) == false, "web=\(web()["open"] ?? "nil") canvas=\(native()["open"] ?? "nil")")
        _ = tapRect(pageR)
        let p2 = web()["clicks"] as? Int ?? -1
        step("closed: first tap on page works", p2 > p1, "page pointerdowns \(p1)->\(p2)")
        // 点到的那一下如果让网页弹出了面板、盖住了草稿纸按钮，App 的按钮会跟着藏（设计如此）：换一下题把面板收掉再点按钮
        var covered = ""
        if (native()["toggleHidden"] as? Bool) == true {
            covered = " (page tap opened \(web()["aboveOn"] ?? "?") over the button; closed it)"
            cmd("closeall"); Thread.sleep(forTimeInterval: 1.5)
        }
        let t3 = tapToggle()
        let diag = " toggleHidden=\(native()["toggleHidden"] ?? "nil") webBtn=\(native()["webBtn"] ?? "nil") covered=\(native()["covered"] ?? "nil")"
        step("reopen by button (one tap), strokes kept", t3 && (web()["open"] as? Bool) == true && waitCount(n0) == n0 && prints() == keptPrints && toolbarOK(), "count ->\(count())" + covered + diag)

        // ---- 换题再换回来：比指纹 ----
        cmd("finger on")
        cmd("goto 2009-02"); Thread.sleep(forTimeInterval: 1.5)
        let other0 = prints()
        step("switch question", (web()["id"] as? String) == "2009-02" && (native()["id"] as? String) == "2009-02", "id=\(web()["id"] ?? "nil") count=\(other0.count)")
        z = zone()
        write("stroke on 2009-02", (z.x0, z.ys[1] + 40), (z.x1, z.ys[1] + 60))
        let other1 = prints()
        cmd("goto 2009-01"); Thread.sleep(forTimeInterval: 1.5)
        _ = waitCount(keptPrints.count)
        step("switch back: same strokes point by point", (web()["id"] as? String) == "2009-01" && prints() == keptPrints, "count \(count()) prints equal=\(prints() == keptPrints)")
        cmd("goto 2009-02"); Thread.sleep(forTimeInterval: 1.5)
        _ = waitCount(other1.count)
        step("other question kept its strokes point by point", prints() == other1, "count \(count())")
        cmd("goto 2009-01"); Thread.sleep(forTimeInterval: 1.5)
        _ = waitCount(keptPrints.count)

        // ---- 撤销后杀掉重启：笔画数是撤销后的数；清空的结果也一致 ----
        z = zone()
        write("stroke before restart", (z.x0, z.ys[3] + 30), (z.x1, z.ys[3] + 40))
        _ = tapTool("undo")
        let afterUndo = waitCount(keptPrints.count)
        Thread.sleep(forTimeInterval: 2.5)   // 存盘防抖 1.2 秒
        let v2b = web()["v2"] as? Int ?? -1
        app.terminate()
        launch()
        _ = tapToggle()
        let r1 = waitCount(afterUndo, 6)
        step("after undo + kill + relaunch: same strokes", r1 == afterUndo && prints() == keptPrints && (web()["v2"] as? Int) == v2b,
             "count \(afterUndo)->\(r1) v2 \(v2b)->\(web()["v2"] ?? "nil")")

        // ---- d. 开着转屏：笔画数不变，按新坐标写一笔落点对得上，工具条、收起按钮都在屏幕里 ----
        cmd("finger on")
        let nr = count()
        XCUIDevice.shared.orientation = o == "portrait" ? .landscapeLeft : .portrait
        Thread.sleep(forTimeInterval: 2.5)
        let (Wr, Hr) = wh()
        let tg = native()["toggle"] as? [Double] ?? []
        let tgIn = tg.count == 4 && tg[0] >= 0 && tg[1] >= 0 && tg[0] + tg[2] <= Wr && tg[1] + tg[3] <= Hr && (native()["toggleHidden"] as? Bool) == false
        let dt = web()["dtool"] as? [Double] ?? []
        let dtIn = dt.count == 4 && dt[0] >= 0 && dt[1] >= 0 && dt[0] + dt[2] <= Wr + 0.5 && dt[1] + dt[3] <= Hr + 0.5
        step("rotate while open: strokes kept, button and toolbar on screen", count() == nr && tgIn && dtIn, "count \(nr)->\(count()) W=\(Wr) H=\(Hr) toggle=\(tg) toolbar=\(dt)")
        z = zone()
        write("stroke after rotate", (z.x0, z.ys[2] + 30), (z.x1, z.ys[2] + 40))
        XCUIDevice.shared.orientation = ori
        Thread.sleep(forTimeInterval: 2.0)
        app.terminate()
        return steps
    }

    func testShots() {
        _ = http("_online")
        write("selftest-first.json", shot("selftest-first", scene: "selftest", orient: .landscapeLeft, theme: "night"))

        for theme in themes {
            for (o, ori) in orients {
                shot("launch-\(o)-\(theme)", scene: "launch", orient: ori, theme: theme)
                shot("main-\(o)-\(theme)", scene: "main", orient: ori, theme: theme)
                shot("settings-off-\(o)-\(theme)", scene: "settings", orient: ori, theme: theme)
                shot("settings-on-\(o)-\(theme)", scene: "settings", orient: ori, theme: theme, extra: ["-reminderEnabled", "YES"])
                shot("drawer-\(o)-\(theme)", scene: "drawer", orient: ori, theme: theme)
                shot("settings-time-\(o)-\(theme)", scene: "settings", orient: ori, theme: theme, extra: ["-reminderEnabled", "YES", "-b2wheel", "YES"])
                shot("settings-clear-\(o)-\(theme)", scene: "settings", orient: ori, theme: theme, extra: ["-b2clear", "YES"])
                shot("draft-100-\(o)-\(theme)", scene: "draft", orient: ori, theme: theme)
                shot("draft-50-\(o)-\(theme)", scene: "draft", orient: ori, theme: theme, extra: ["-b2alpha", "0.5"])
                if o == "portrait" && theme == "night" {
                    shot("draft-clearsure-\(o)-\(theme)", scene: "draft", orient: ori, theme: theme, extra: ["-b2sure", "YES"])
                }
            }
        }
        write("selftest-online.json", shot("selftest-online", scene: "selftest", orient: .landscapeLeft, theme: "night"))
        write("stub-posts.json", http("_posts"))

        // 电脑"关了"：从 iPad 上存的内容打开；离线标记收起（等它自己收）/ 展开各一张
        _ = http("_offline")
        for theme in themes {
            for (o, ori) in orients {
                shot("offline-mark-\(o)-\(theme)", scene: "offline", orient: ori, theme: theme)
                shot("offline-open-\(o)-\(theme)", scene: "offline", orient: ori, theme: theme, extra: ["-b2mark", "expanded"])
            }
        }
        write("selftest-offline.json", shot("selftest-offline", scene: "selftest", orient: .landscapeLeft, theme: "night"))

        // 连不上、iPad 上也没存：连不上页，详细信息收起 / 展开各一张
        for theme in themes {
            for (o, ori) in orients {
                shot("noconn-\(o)-\(theme)", scene: "main", orient: ori, theme: theme,
                     extra: ["-b2nocache", "YES", "-b2server", "http://127.0.0.1:9/"])
                shot("noconn-details-\(o)-\(theme)", scene: "main", orient: ori, theme: theme,
                     extra: ["-b2nocache", "YES", "-b2server", "http://127.0.0.1:9/", "-b2details", "YES"])
            }
        }

        // 电脑"又开了"：排队的记录有没有补发过去
        _ = http("_online")
        shot("replay", scene: "main", orient: .landscapeLeft, theme: "night")
        Thread.sleep(forTimeInterval: 3)
        write("stub-posts-after-replay.json", http("_posts"))
        XCUIDevice.shared.orientation = .portrait
    }
}
