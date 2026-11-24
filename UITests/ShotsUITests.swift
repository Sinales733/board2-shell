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
    /// 其余时候手指按真机规则（工具条手指书写关 = 只认笔，手指只挪纸缩放）。横竖屏各从干净状态跑一整套。
    /// 每一步失败都 XCTFail；结果写 inktest.json，ci/check_selftest.py 按步骤名单核对。
    /// 坐标以网页视图为基准按比例换算（XCUITest 报的元素框和 App 自己的坐标差约 1.107 倍，按比例换算就对得上）。
    /// 每个方向：被系统取消的触摸、网页的 pointercancel / touchcancel 各几次、原始记录（写进 inktest.json 的 cancels）
    private var cancelStats: [String: Any] = [:]
    /// 每个方向：App 主线程 ≥250ms 卡顿的次数、最长（毫秒），写进 inktest.json 的 mainThread
    private var mainStats: [String: Any] = [:]
    /// 窗口模式那一遍（CI 把模拟器切回"窗口化 App"后再跑一遍 testInk，环境变量 B2_INK_WINDOWED=1）：
    /// 结果写 inktest-windowed.json，各文件名带 -windowed / inktestw-，"全屏"那一步换成"确实在窗口里"
    private let windowedPass = ProcessInfo.processInfo.environment["B2_INK_WINDOWED"] == "1"
    /// 第一次换橡皮慢的诊断：变体名（App 用 -b2var 读），空 = 不是诊断
    private let diagVar = ProcessInfo.processInfo.environment["B2_DIAG_VAR"] ?? ""

    /// 诊断：只跑到第一次点橡皮（写 5 笔后），量 抬手→画布换上橡皮；结果追加到 eraserdiag.jsonl
    func testEraserDiag() {
        guard !diagVar.isEmpty else { return }
        _ = http("_online")
        _ = inkRun("portrait", .portrait)
    }

    func testInk() {
        _ = http("_online")
        var steps: [[String: Any]] = []
        for (o, ori) in [("portrait", UIDeviceOrientation.portrait), ("landscape", .landscapeLeft)] {
            steps += inkRun(o, ori)
        }
        // "环境限制"的那一步（竖屏全屏在模拟器里造不出来）不计入通过与否，单独留记录
        let pass = !steps.isEmpty && steps.allSatisfy { ($0["ok"] as? Bool) == true || ($0["env"] as? Bool) == true }
        let obj: [String: Any] = ["pass": pass, "steps": steps, "cancels": cancelStats, "mainThread": mainStats]
        if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) {
            try? d.write(to: outDir.appendingPathComponent(windowedPass ? "inktest-windowed.json" : "inktest.json"))
        }
        XCUIDevice.shared.orientation = .portrait
    }

    // swiftlint:disable:next function_body_length
    private func inkRun(_ o: String, _ ori: UIDeviceOrientation) -> [[String: Any]] {
        let name = (windowedPass ? "inktestw-" : "inktest-") + o
        let fo = windowedPass ? "\(o)-windowed" : o   // 截图、差异图文件名里用
        let app = XCUIApplication()
        let readyURL = outDir.appendingPathComponent(name + ".ready")
        let stateURL = outDir.appendingPathComponent(name + ".state.json")
        let cmdURL = outDir.appendingPathComponent(name + ".cmd")
        var steps: [[String: Any]] = []
        func step(_ n: String, _ ok: Bool, _ note: String) {
            steps.append(["name": "\(o): \(n)", "ok": ok, "note": note])
            print("INK \(o): \(n) ok=\(ok) \(note)")
            if !ok { XCTFail("\(o): \(n) — \(note)") }
        }
        /// 环境限制：记下来、打印出来，但不让测试失败（只用于"竖屏全屏"这一步，条件见调用处）
        func envStep(_ n: String, _ ok: Bool, _ note: String) {
            steps.append(["name": "\(o): \(n)", "ok": ok, "note": note, "env": true])
            print("INK \(o): \(n) ok=\(ok) (environment limit, not counted) \(note)")
        }
        let cancelURL = outDir.appendingPathComponent(name + ".cancel.log")
        try? FileManager.default.removeItem(at: cancelURL)
        func cancelLines() -> [String] {
            ((try? String(contentsOf: cancelURL, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        }
        /// 测试自己拖窗口缩放把手时系统收走的那一下触摸（窗口模式那一遍的准备动作）：单独记，不算进"不许有被取消的触摸"
        var setupCancels: [String] = []
        // 不带 -b2at：页面不进"安静模式"，顶上一排按钮（含网页的草稿纸按钮）、题号、选项都和正式页一样
        func launch() {
            XCUIDevice.shared.orientation = ori
            for u in [readyURL, stateURL, cmdURL] { try? FileManager.default.removeItem(at: u) }
            app.launchEnvironment = ["B2_OUT": outDir.path, "B2_NAME": name]
            app.launchArguments = ["-b2shot", "inktest", "-b2theme", "night", "-b2q", "2009-01", "-b2server", server] + (diagVar.isEmpty ? [] : ["-b2var", diagVar])
            app.launch()
            XCUIDevice.shared.orientation = ori
            let deadline = Date().addingTimeInterval(45)
            while Date() < deadline && !FileManager.default.fileExists(atPath: readyURL.path) { Thread.sleep(forTimeInterval: 0.3) }
            Thread.sleep(forTimeInterval: 1.5)
        }
        func state() -> [String: Any] {
            guard let d = try? Data(contentsOf: stateURL), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
            return o
        }
        func native() -> [String: Any] { state()["native"] as? [String: Any] ?? [:] }
        /// 状态文件写出到现在过了多久（毫秒）
        func stateAge() -> Int { Int(Date().timeIntervalSince1970 * 1000) - (state()["ts"] as? Int ?? 0) }
        func web() -> [String: Any] { state()["web"] as? [String: Any] ?? [:] }
        func count() -> Int { native()["count"] as? Int ?? -1 }
        func prints() -> [String] { native()["prints"] as? [String] ?? [] }
        func nview() -> [Double] { native()["view"] as? [Double] ?? [] }
        func tool() -> String { native()["tool"] as? String ?? "?" }
        func v2() -> Int { web()["v2"] as? Int ?? -1 }
        func wbtn(_ k: String) -> [Double]? { (web()["btn"] as? [String: Any])?[k] as? [Double] }
        let markURL = outDir.appendingPathComponent(name + ".testmarks.log")
        /// 一个 XCUITest 动作的起止时刻（墙上毫秒）写进 <名字>.testmarks.log
        func mark(_ what: String, _ f: () -> Void) {
            let t0 = Int64(Date().timeIntervalSince1970 * 1000)
            f()
            let line = "\(t0) \(Int64(Date().timeIntervalSince1970 * 1000)) \(what)\n"
            if let h = try? FileHandle(forWritingTo: markURL) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
            else { try? line.write(to: markURL, atomically: true, encoding: .utf8) }
        }
        func isOpen() -> Bool {
            (web()["open"] as? Bool) == true && (native()["open"] as? Bool) == true
        }
        func settle(_ t: TimeInterval = 0.5) { Thread.sleep(forTimeInterval: t) }
        func cmd(_ c: String) { try? c.write(to: cmdURL, atomically: true, encoding: .utf8); Thread.sleep(forTimeInterval: 1.0) }
        func wh() -> (Double, Double) { ((web()["W"] as? Double) ?? 820, (web()["H"] as? Double) ?? 1180) }
        /// 恢复到"草稿纸开着、工具条在右边"：前一步失败了也不连累后面（失败那一步照样记失败）
        func restore() {
            if (web()["side"] as? String) != "r" { cmd("toolright"); settle(1.0) }
            if !isOpen() { cmd("open"); settle(1.5); print("INK \(o): (restored: draft reopened)") }
        }
        let webEl = app.webViews.firstMatch
        // 点的坐标按 App 根元素（窗口）算：网页视图铺满窗口，位置一样；不用网页视图元素，省掉每一下之前查整棵网页无障碍树
        let base: XCUIElement = app.windows.firstMatch
        func at(_ x: Double, _ y: Double) -> XCUICoordinate {
            let (W, H) = wh()
            return base.coordinate(withNormalizedOffset: CGVector(dx: x / W, dy: y / H))
        }
        func drag(_ a: (Double, Double), _ b: (Double, Double), velocity: CGFloat = 250, press: TimeInterval = 0.3, hold: TimeInterval = 0.3) {
            mark("drag") { at(a.0, a.1).press(forDuration: press, thenDragTo: at(b.0, b.1), withVelocity: XCUIGestureVelocity(velocity), thenHoldForDuration: hold) }
        }
        func center(_ r: [Double]?) -> (Double, Double)? { guard let r = r, r.count == 4, r[2] > 0 else { return nil }; return (r[0] + r[2] / 2, r[1] + r[3] / 2) }
        func tapRect(_ r: [Double]?) -> Bool { guard let c = center(r) else { return false }; mark("tap") { at(c.0, c.1).tap() }; return true }
        func lastTap() -> [String: Any] { native()["lastTap"] as? [String: Any] ?? [:] }
        /// 点工具条上一个按钮（只点一次），0.5 秒后看结果；断言这一下 抬手→执行 ≤300 毫秒、纸上没多笔画
        /// applies：这一下要给画布换工具——抬手到画布真的换上（App 自己记的时刻）≤300ms。
        /// rects：这一下会让出区个数变（弹层开合、确认气泡）——抬手到 App 收到新的让出区 ≤300ms。
        /// a：网页报的动作名（色块是 c-颜色），默认就是 k。
        func tool1(_ k: String, _ label: String, keepsCount: Bool = true, applies: Bool = false, rects: Bool = false, a: String? = nil, expect: () -> Bool) {
            let c0 = count(), before = lastTap()["act"] as? Int ?? 0
            let ok = tapRect(wbtn(k))
            settle()
            let t = lastTap(), act = t["act"] as? Int ?? 0, lta = t["liftToAct"] as? Int ?? -1, lift = t["lift"] as? Int ?? 0
            let fresh = act != before && (t["a"] as? String) == (a ?? k)
            var extra = "", good = true
            if applies {
                let ta = native()["toolApply"] as? [String: Any] ?? [:], w = ta["wall"] as? Int ?? 0
                let d = w - lift
                good = good && w >= lift && d <= 300
                extra += " lift→applied=\(d)ms (assign \(ta["assignMs"] ?? "?")ms)"
            }
            if rects {
                let lr = native()["lastRects"] as? [String: Any] ?? [:], rv = lr["recv"] as? Int ?? 0, sn = lr["sent"] as? Int ?? 0
                good = good && rv >= lift && rv - lift <= 300
                extra += " lift→rects at App=\(rv - lift)ms (page sent +\(sn - lift)ms)"
            }
            step(label, ok && fresh && good && lta >= 0 && lta <= 300 && expect() && (!keepsCount || count() == c0),
                 "tapped=\(ok) fresh=\(fresh) lift→act=\(lta)ms" + extra + " count \(c0)->\(count())" + (fresh ? "" : " (state file age \(stateAge())ms, lastTap a=\(t["a"] ?? "nil") act=\(act))"))
        }
        let tgEl = app.buttons.matching(identifier: "b2draftToggle").firstMatch
        func tapToggle() -> Bool {
            var ok = false
            mark("toggle") { if tgEl.waitForExistence(timeout: 3) && tgEl.isHittable { tgEl.tap(); ok = true } }
            if ok { return true }
            return tapRect(native()["toggle"] as? [Double])
        }
        func waitCount(_ want: Int, _ t: TimeInterval = 2) -> Int {
            let end = Date().addingTimeInterval(t); var c = count()
            while Date() < end { c = count(); if c == want { return c }; Thread.sleep(forTimeInterval: 0.1) }
            return c
        }
        /// 清空两下：第一下进确认态（确认气泡 ≤300ms 报到 App），第二下清空。不重试：两下隔超了 4 秒，第二下只会重新进确认态，这一步就红
        func clearTwice(_ l1: String, _ l2: String, expect: () -> Bool) {
            tool1("clear", l1, rects: true) { (web()["clearSure"] as? Bool) == true }
            let a1 = lastTap()["act"] as? Int ?? 0
            tool1("clear", l2, keepsCount: false) {
                let a2 = lastTap()["act"] as? Int ?? 0
                if a2 - a1 >= 4000 { print("INK \(o): \(l2): two clear taps \(a2 - a1)ms apart") }
                return a2 - a1 < 4000 && expect()
            }
        }
        func zone() -> (x0: Double, x1: Double, ys: [Double]) {
            let (W, H) = wh()
            return (W * 0.12, W * 0.48, (0..<5).map { H * 0.25 + Double($0) * H * 0.08 })
        }
        func strokeErr(_ a: (Double, Double), _ b: (Double, Double)) -> (Double, Double) {
            guard let ss = native()["strokes"] as? [[Double]], let s = ss.last, s.count == 4 else { return (9999, 9999) }
            return (hypot(s[0] - a.0, s[1] - a.1), hypot(s[2] - b.0, s[3] - b.1))
        }
        /// 写一笔：笔画起点、终点离要求的拖动起止点都 < 6 点（依据见汇报）
        func write(_ label: String, _ a: (Double, Double), _ b: (Double, Double)) {
            let before = count()
            drag(a, b)
            let after = waitCount(before + 1)
            let (es, ee) = strokeErr(a, b)
            step(label, after == before + 1 && es < 6 && ee < 6, "count \(before)->\(after) start err \(String(format: "%.1f", es)) end err \(String(format: "%.1f", ee))")
        }
        func viewsMatch() -> (Bool, String) {
            let n = nview(), w = web()["V"] as? [Double] ?? []
            guard n.count == 3, w.count == 3 else { return (false, "n=\(n) w=\(w)") }
            let ok = abs(n[0] - w[0]) < 1.5 && abs(n[1] - w[1]) < 1.5 && abs(n[2] - w[2]) < 0.002
            return (ok, "native \(n.map { Int($0 * 100) }) web \(w.map { Int($0 * 100) })")
        }
        /// 换题：收起草稿纸 → 真点题号 → 真点抽屉里的那道题 → 再打开草稿纸
        func switchTo(_ cell: String, _ id: String) -> String {
            var log: [String] = []
            if isOpen() { log.append("close=\(tapToggle())"); settle(1.2) }
            if (web()["drawer"] as? Bool) != true { log.append("tag=\(tapRect(web()["tag"] as? [Double]))"); settle(1.5) } else { log.append("drawer already open") }
            let cr = (web()["cells"] as? [String: Any])?[cell] as? [Double]
            log.append("cell=\(tapRect(cr))"); settle(2.0)
            if (web()["drawer"] as? Bool) == true { log.append("drawer still open cellRect=\(cr ?? []) clicks=\(web()["lastClicks"] ?? "nil")"); cmd("closeall") }
            log.append("open=\(tapToggle())"); settle(1.5)
            log.append("id=\(web()["id"] ?? "nil")")
            return log.joined(separator: " ") + ((web()["id"] as? String) == id ? "" : " WRONG")
        }

        // ---- 从干净状态开始：两道题的新笔迹、旧稿、颜色、工具条位置、取景窗都回默认 ----
        _ = http("_online"); _ = http("_resetdrafts")
        launch()
        cmd("resetall")
        app.terminate()
        launch()
        _ = webEl.waitForExistence(timeout: 10)

        // ---- 全屏、按钮位置 ----
        var (W0, H0) = wh()
        let scr = native()["uiscreen"] as? [Double] ?? []
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        func isWindowed() -> (Bool, String) {
            let w = app.windows.firstMatch.frame, s = sb.frame
            let full = abs(max(w.width, w.height) - max(s.width, s.height)) <= 1 && abs(min(w.width, w.height) - min(s.width, s.height)) <= 1 && w.minX <= 1 && w.minY <= 1
            return (!full, "window=\(w) screen=\(s)")
        }
        var (windowed, wnote) = isWindowed()
        var tried: [String] = []
        if windowed && !windowedPass {   // 试一：转一下屏再转回来
            XCUIDevice.shared.orientation = o == "portrait" ? .landscapeLeft : .portrait; Thread.sleep(forTimeInterval: 1.5)
            XCUIDevice.shared.orientation = ori; Thread.sleep(forTimeInterval: 1.5)
            (windowed, wnote) = isWindowed(); tried.append("rotate→\(windowed ? "still windowed" : "full")")
        }
        if windowed && !windowedPass {   // 试二：系统窗口按钮（左上三个点）里的"全屏 / 填满"
            sb.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 91, dy: 75)).tap(); Thread.sleep(forTimeInterval: 1.0)
            let menu = sb.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'full' OR label CONTAINS[c] 'fill' OR label CONTAINS '全屏' OR label CONTAINS '填满'")).firstMatch
            if menu.waitForExistence(timeout: 2) { tried.append("menu '\(menu.label)'"); menu.tap(); Thread.sleep(forTimeInterval: 1.5) } else { tried.append("no full-screen item") }
            (windowed, wnote) = isWindowed(); tried.append(windowed ? "still windowed" : "full")
        }
        let fsNote = wnote + " tried=\(tried) app-reported screen=\(scr) web=\(W0)x\(H0)"
        for _ in 0..<2 where windowedPass && !windowed {
            // 窗口模式那一遍但 App 是全屏：拖窗口右下角的缩放把手往里收，让它变成窗口（窗口化 App 模式下全屏的 App 也画着这个把手）
            let wc = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 1))
            let before = cancelLines().count
            wc.withOffset(CGVector(dx: -6, dy: -6)).press(forDuration: 0.6, thenDragTo: wc.withOffset(CGVector(dx: -110, dy: -130)))
            Thread.sleep(forTimeInterval: 2.0)
            setupCancels = Array(cancelLines().dropFirst(before))
            (windowed, wnote) = isWindowed(); tried.append("drag resize corner→\(windowed ? "windowed" : "still full")")
            (W0, H0) = wh()   // 窗口变了，网页的宽高跟着变
        }
        if windowedPass {
            let fsNote = wnote + " tried=\(tried) app-reported screen=\(scr) web=\(W0)x\(H0)"
            // 窗口模式那一遍：竖屏必须真的在窗口里（不然这一遍白跑）；横屏系统可能照样给全屏，记下来不算错
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: outDir.appendingPathComponent("window-\(fo).png"))
            if o == "portrait" { step("app runs in a window (windowed pass)", windowed, fsNote + " (screenshot window-\(fo).png)") }
            else { envStep("app runs in a window (windowed pass)", windowed, fsNote + " (screenshot window-\(fo).png)") }
        } else if windowed && o == "portrait" {
            // 竖屏全屏在这台模拟器上造不出来：存一张窗口状态的截图，记成"环境限制"；后面整套触摸测试照样在窗口里跑（坐标按窗口框换算），必须全过
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: outDir.appendingPathComponent("fullscreen-\(o)-windowed.png"))
            envStep("app runs full screen", false, fsNote + " (screenshot fullscreen-\(o)-windowed.png)")
        } else {
            step("app runs full screen", !windowed, fsNote)
        }
        let tg0 = native()["toggle"] as? [Double] ?? [], wb = web()["draftBtn"] as? [Double] ?? []
        var cd = 9999.0
        if let a = center(tg0), let b = center(wb) { cd = hypot(a.0 - b.0, a.1 - b.1) }
        step("closed, native button over web button", (web()["open"] as? Bool) == false && (native()["toggleHidden"] as? Bool) == false && cd < 1.5,
             "toggle=\(tg0) webBtn=\(wb) center diff \(String(format: "%.2f", cd))")
        let t1 = tapToggle(); settle(1.2)
        step("open by tapping draft button (one tap)", t1 && isOpen() && (web()["dtoolShown"] as? Bool) == true, "open=\(isOpen())")
        step("v2 old draft present", v2() == 2, "v2=\(v2())")

        // ---- 写 5 笔（命令让手指也写） ----
        cmd("finger on")
        var z = zone()
        let ex = min(W0 * 0.3, 250)   // 橡皮竖着擦的位置：在旧稿两条横线（纸面 x 60–300）的范围里
        for i in 0..<5 {
            let x1 = (i == 0 || i == 4) ? ex - 50 : z.x1   // 第 1、5 笔只写到橡皮左边，橡皮碰不到
            write("stroke \(i + 1)", (z.x0, z.ys[i]), (x1, z.ys[i] + 20))
        }

        // ---- 橡皮：竖着擦过第 2、3、4 笔和垫底的两条旧稿；第 1、5 笔逐点不变；竖屏再比画面 ----
        let pre = prints()
        tool1("eraser", "toolbar eraser", applies: true) { tool().hasPrefix("eraser") }
        if !diagVar.isEmpty {
            var rec: [String: Any] = ["variant": diagVar]
            func sample(_ k: String) -> [String: Any] {
                let lt = lastTap(), ta = native()["toolApply"] as? [String: Any] ?? [:]
                let lift = lt["lift"] as? Int ?? 0, wall = ta["wall"] as? Int ?? 0
                return ["tap": k, "liftToApplied": wall - lift, "assignMs": ta["assignMs"] ?? -1, "liftToAct": lt["liftToAct"] ?? -1]
            }
            var ss = [sample("eraser")]
            _ = tapRect(wbtn("pen")); settle(1.0); ss.append(sample("pen"))
            _ = tapRect(wbtn("eraser")); settle(1.0); ss.append(sample("eraser2"))
            rec["samples"] = ss
            rec["warm"] = native()["warm"] ?? [:]
            rec["mainGaps"] = native()["mainGaps"] ?? []
            if let d = try? JSONSerialization.data(withJSONObject: rec), let line = String(data: d, encoding: .utf8) {
                let u = outDir.appendingPathComponent("eraserdiag.jsonl")
                if let h = try? FileHandle(forWritingTo: u) { h.seekToEndOfFile(); h.write(Data((line + "\n").utf8)); try? h.close() }
                else { try? (line + "\n").write(to: u, atomically: true, encoding: .utf8) }
            }
            print("ERASERDIAG \(rec)")
            app.terminate()
            return steps
        }
        let ey0 = z.ys[1] - 30, ey1 = max(z.ys[3] + 30, 600)
        let shot0 = o == "portrait" ? XCUIScreen.main.screenshot().pngRepresentation : Data()
        drag((ex, ey0), (ex, ey1), velocity: 200)
        settle(1.5)
        let post = prints()
        let untouched = pre.count == 5 && post.contains(pre[0]) && post.contains(pre[4])
        let cut = pre.count == 5 && !post.contains(pre[1]) && !post.contains(pre[2]) && !post.contains(pre[3])
        step("eraser cuts strokes 2-4, strokes 1 and 5 unchanged", untouched && cut, "before \(pre.count) after \(post.count) untouched=\(untouched) cut=\(cut)")
        if o == "portrait" {
            let shot1 = XCUIScreen.main.screenshot().pngRepresentation
            try? shot0.write(to: outDir.appendingPathComponent("erase-before-\(fo).png"))
            try? shot1.write(to: outDir.appendingPathComponent("erase-after-\(fo).png"))
            // 不比的区域：橡皮轨迹左右各 30 点、工具条、收起按钮
            var skip: [[Double]] = [[ex - 30, 0, 60, H0]]
            if let r = web()["dtool"] as? [Double] { skip.append(r) }
            if let r = native()["toggle"] as? [Double] { skip.append(r) }
            let winF = app.windows.firstMatch.frame, scrW = Double(sb.frame.width)
            // 窗口模式下系统画在窗口上的：左上的窗口按钮、右下的缩放把手（屏幕坐标）；窗口外面（墙纸、时间）pixelDiff 本来就不比
            let scrSkip: [[Double]] = windowed ? [[Double(winF.minX), Double(winF.minY), 120, 50], [Double(winF.maxX) - 60, Double(winF.maxY) - 60, 60, 60]] : []
            // 被切开的第 2–4 笔：沿原来的笔画外扩 4 点的长条单独比（只允许边缘抗锯齿变化），不算进"别的笔迹"
            let cutBands: [[Double]] = (1...3).map { i in [z.x0 - 4, z.ys[i] - 6, z.x1 - z.x0 + 8, 32] }   // 笔画从 y 斜到 y+20，粗 2.4
            let all = pixelDiff(shot0, shot1, W0, skip, win: winF, scrW: scrW, scrSkip: scrSkip, save: outDir.appendingPathComponent("erase-diff-all-\(fo).png"))
            skip += cutBands
            let r = pixelDiff(shot0, shot1, W0, skip, win: winF, scrW: scrW, scrSkip: scrSkip, save: outDir.appendingPathComponent("erase-diff-\(fo).png"))
            step("eraser: pixels outside 30pt of the eraser path: none differ by more than 8 levels", r.big == 0,
                 ">8 levels: \(r.big) px box(app pt)=\(r.bigBox); 1-8 levels: \(r.small) px max=\(r.smallMax) box(app pt)=\(r.smallBox) (diff image erase-diff-\(fo).png: red >8, orange 1-8); with cut strokes 2-4 bands: >8=\(all.big) 1-8=\(all.small) max=\(all.smallMax); window=\(winF)" + (windowed ? " (outside the window and system window chrome not compared)" : ""))
        }
        tool1("undo", "toolbar undo restores erase", keepsCount: false) { prints() == pre }
        tool1("pen", "toolbar pen", applies: true) { tool().hasPrefix("ink") }
        // 颜色：先换成蓝，再换成红（点颜色后不等，马上点色块）
        for c in ["blue", "red"] {
            tool1("color", "color button opens palette (\(c))", rects: true) { (web()["pal"] as? Bool) == true }
            tool1(c, "color \(c) right after opening palette", applies: true, a: "c-" + c) { (native()["color"] as? String) == c }
        }
        write("red stroke", (z.x0, z.ys[0] + 40), (z.x1, z.ys[0] + 50))
        step("new stroke is red", (native()["lastColor"] as? String) == "red", "lastColor=\(native()["lastColor"] ?? "nil")")
        let c6 = count()
        tool1("undo", "toolbar undo removes last stroke", keepsCount: false) { waitCount(c6 - 1, 1) == c6 - 1 }

        // ---- 只认笔（真机规则）：手指点工具条、点纸、挪纸、缩放 ----
        cmd("finger auto")
        step("pencilOnly by default", (native()["policy"] as? String) == "pencilOnly", "policy=\(native()["policy"] ?? "nil")")
        let kept = count()
        tool1("eraser", "finger tap on toolbar under pencilOnly", applies: true) { tool().hasPrefix("eraser") }
        tool1("pen", "finger tap pen under pencilOnly", applies: true) { tool().hasPrefix("ink") }
        _ = tapRect([z.x0 + 50, z.ys[2] + 30, 20, 20]); settle()
        step("finger tap on paper: canvas never first responder, no system edit menu",
             (native()["canvasFR"] as? Bool) == false && (native()["editMenus"] as? Int) == 0,
             "canvasFR=\(native()["canvasFR"] ?? "nil") editMenus=\(native()["editMenus"] ?? "nil") removed=\(native()["editMenusRemoved"] ?? "nil")")
        step("finger tap on paper: no stroke, toolbar still there", count() == kept && (web()["dtoolShown"] as? Bool) == true, "count \(kept)->\(count())")
        let v0 = nview()
        drag((z.x0 + 40, z.ys[2]), (z.x0 + 140, z.ys[2] + 90), velocity: 200, press: 0.05, hold: 0.8)
        settle(1.0)
        let v1 = nview()
        let moved = v0.count == 3 && v1.count == 3 && v1[0] - v0[0] > 10 && v1[1] - v0[1] > 10
        step("one finger pans paper", moved && count() == kept, "view \(v0.map { Int($0) }) -> \(v1.map { Int($0) }) count=\(count())")
        let zz0 = nview().last ?? 1
        base.pinch(withScale: 0.6, velocity: -1.0)
        settle(1.5)
        let zz1 = nview().last ?? 1
        step("pinch zoom: no stroke", count() == kept && abs(zz1 - zz0) > 0.08, "count \(kept)->\(count()) z \(zz0)->\(zz1)")
        let (vm, vnote) = viewsMatch()
        step("old draft follows canvas after pan and zoom", vm, vnote)
        tool1("zoom", "zoom button back to 100% where the strokes are") {
            let v = nview(), ss = native()["strokes"] as? [[Double]] ?? []
            let (W, H) = wh()
            let seen = ss.contains { $0.count == 4 && max($0[0], $0[2]) > 0 && min($0[0], $0[2]) < W && max($0[1], $0[3]) > 0 && min($0[1], $0[3]) < H }
            return v.count == 3 && abs(v[2] - 1) < 0.001 && seen
        }
        // 手指书写开关
        tool1("more", "more opens", rects: true) { (web()["moreOpen"] as? Bool) == true }
        tool1("finger", "finger switch on -> anyInput") { (native()["policy"] as? String) == "anyInput" }
        tool1("finger", "finger switch off -> pencilOnly") { (native()["policy"] as? String) == "pencilOnly" }
        tool1("more", "more closes") { (web()["moreOpen"] as? Bool) == false }
        // 拖手柄：往下挪 150 点，纸上不多笔画，下面没被点开东西
        if let g = center(wbtn("grip")), let d0 = web()["dtool"] as? [Double] {
            let c = count()
            drag(g, (g.0 - 30, g.1 + 150), velocity: 300, press: 0.2, hold: 0.2)
            settle(1.5)
            let d1 = web()["dtool"] as? [Double] ?? d0, opened = web()["aboveOn"] as? [String] ?? []
            step("drag grip moves toolbar, no stroke, nothing opened below", d1[1] - d0[1] > 60 && count() == c && opened.isEmpty,
                 "toolbar top \(Int(d0[1]))->\(Int(d1[1])) count \(c)->\(count()) opened=\(opened) clicks=\(web()["lastClicks"] ?? "nil") toolClk=\(web()["toolClk"] ?? "nil")")
            if !opened.isEmpty { cmd("closeall") }   // 失败时收掉，不连累后面
            if let g2 = center(wbtn("grip")) { drag(g2, (g2.0, g2.1 - 150), velocity: 300, press: 0.2, hold: 0.2); settle(1.0) }
        } else { step("drag grip moves toolbar, no stroke, nothing opened below", false, "no grip") }

        // ---- 四.1 工具条拖到左边、再开选题抽屉：两块让出区重叠，重叠处在遮罩里是洞（不露笔迹） ----
        do {
            cmd("toolleft"); settle(1.5)
            cmd("drawer"); settle(1.5)
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: outDir.appendingPathComponent("mask-overlap-\(fo).png"))
            let ov = (native()["passOverlap"] as? Bool) == true, okm = (native()["maskOverlapOK"] as? Bool) == true
            step("toolbar left + drawer open: overlap of the two is a hole in the mask", ov && okm,
                 "side=\(web()["side"] ?? "nil") drawer=\(web()["drawer"] ?? "nil") overlap=\(ov) maskOK=\(okm) passRects=\(native()["passRects"] ?? "nil") (screenshot mask-overlap-\(fo).png)")
            cmd("closeall"); settle(1.0)
            cmd("toolright"); settle(1.5)
        }
        restore()

        // ---- 三.4 问答面板放大：放不下工具条就整个收起，不盖面板上的按钮；缩回去工具条再出现 ----
        cmd("askopen"); settle(1.5)
        let fb0 = web()["fb"] as? [String: Any] ?? [:]
        if (fb0["on"] as? Bool) == true, tapRect(fb0["wideBtn"] as? [Double]) {
            settle(1.5)
            let fb1 = web()["fb"] as? [String: Any] ?? [:], pn = fb1["panel"] as? [Double] ?? [], dt = web()["dtool"] as? [Double] ?? []
            let hid = (web()["dhide"] as? Bool) == true
            let inter = pn.count == 4 && dt.count == 4 && CGRect(x: pn[0], y: pn[1], width: pn[2], height: pn[3]).intersects(CGRect(x: dt[0], y: dt[1], width: dt[2], height: dt[3]))
            let pr = native()["passRects"] as? [[Double]] ?? []
            let toolInRects = dt.count == 4 && pr.contains { $0.count == 4 && abs($0[0] - dt[0]) < 2 && abs($0[1] - dt[1]) < 2 && abs($0[2] - dt[2]) < 2 }
            // App 自己的开关按钮也不能盖住面板上的放大按钮（r29 窗口竖屏：盖住了，点"缩回"点到了开关、把草稿纸收了）
            let tgR = native()["toggle"] as? [Double] ?? [], wbR = fb1["wideBtn"] as? [Double] ?? []
            let tgCovers = tgR.count == 4 && wbR.count == 4 && CGRect(x: tgR[0], y: tgR[1], width: tgR[2], height: tgR[3]).intersects(CGRect(x: wbR[0], y: wbR[1], width: wbR[2], height: wbR[3]))
            step("ask panel enlarged: toolbar hidden or clear of the panel", (fb1["wide"] as? Bool) == true && (hid ? !toolInRects : !inter) && !tgCovers,
                 "wide=\(fb1["wide"] ?? "nil") hidden=\(hid) toolbar=\(dt) panel=\(pn) toolbar in pass rects=\(toolInRects) app toggle=\(tgR) enlarge button=\(wbR) covered=\(tgCovers)")
            let fb2w = (web()["fb"] as? [String: Any])?["wideBtn"] as? [Double]
            _ = tapRect(fb2w); settle(1.5)   // 面板上的放大按钮没被工具条盖住：点得到，缩回去
            let fb3 = web()["fb"] as? [String: Any] ?? [:]
            step("ask panel back to normal: toolbar shown again", (fb3["wide"] as? Bool) == false && (web()["dhide"] as? Bool) == false && (web()["dtoolShown"] as? Bool) == true,
                 "wide=\(fb3["wide"] ?? "nil") hidden=\(web()["dhide"] ?? "nil")")
        } else {
            step("ask panel enlarged: toolbar hidden or clear of the panel", false, "panel not open or no enlarge button: \(fb0)")
            step("ask panel back to normal: toolbar shown again", false, "skipped")
        }
        cmd("closeall"); settle(1.0)
        restore()

        // ---- 清空 ----
        let n0 = count(), v2a = v2()
        tool1("clear", "clear first tap: confirm state only") { (web()["clearSure"] as? Bool) == true && (web()["sureShown"] as? Bool) == true && count() == n0 && v2() == v2a }
        let sureShot = XCUIScreen.main.screenshot().pngRepresentation
        try? sureShot.write(to: outDir.appendingPathComponent("clearsure-\(fo)-tapped.png"))
        let k0 = web()["clk"] as? Int ?? -1
        _ = tapRect(wbtn("sure")); settle()
        step("tap on confirm bubble: nothing cleared, page not clicked", count() == n0 && v2() == v2a && (web()["clk"] as? Int ?? -2) == k0, "count=\(count()) v2=\(v2()) page clicks \(k0)->\(web()["clk"] ?? "nil")")
        Thread.sleep(forTimeInterval: 4.5)
        step("clear confirm times out", (web()["clearSure"] as? Bool) == false && count() == n0, "sure=\(web()["clearSure"] ?? "nil") count=\(count())")
        if let c = center(wbtn("clear")) {   // 按住清空，滑出去再松手：不算
            at(c.0, c.1).press(forDuration: 0.3, thenDragTo: at(c.0 - 160, c.1), withVelocity: 300, thenHoldForDuration: 0.1)
            settle()
            step("press clear, slide out, release: nothing happens", (web()["clearSure"] as? Bool) == false && count() == n0,
                 "sure=\(web()["clearSure"] ?? "nil") count=\(count()) toolEvs=\(web()["toolEvs"] ?? "nil") toolClk=\(web()["toolClk"] ?? "nil")")
            if (web()["clearSure"] as? Bool) == true { Thread.sleep(forTimeInterval: 4.5) }   // 失败时让确认态自己过期，不连累后面
        }
        if let c = center(wbtn("clear")) {   // 双击清空：第一下进确认态，紧跟着的第二下（<300 毫秒）不算，不清
            at(c.0, c.1).doubleTap()
            settle()
            step("double tap clear: second tap within 300ms ignored, nothing cleared", (web()["clearSure"] as? Bool) == true && count() == n0 && v2() == v2a,
                 "sure=\(web()["clearSure"] ?? "nil") count=\(count()) v2=\(v2()) toolEvs=\(web()["toolEvs"] ?? "nil")")
            Thread.sleep(forTimeInterval: 4.5)   // 等确认态自己过期
        }
        clearTwice("clear tap 1", "clear tap 2: native and old draft both 0") { waitCount(0, 1) == 0 && v2() == 0 }
        cmd("finger on")
        write("stroke after clear", (z.x0, z.ys[2]), (z.x1, z.ys[2] + 10))
        clearTwice("second clear tap 1", "second clear tap 2") { waitCount(0, 1) == 0 }
        tool1("undo", "undo #1: back to the stroke written after first clear", keepsCount: false) { waitCount(1, 1) == 1 && v2() == 0 }
        tool1("undo", "undo #2: that stroke undone", keepsCount: false) { waitCount(0, 1) == 0 && v2() == 0 }
        tool1("undo", "undo #3: first clear undone, old draft back", keepsCount: false) { waitCount(n0, 1) == n0 && v2() == v2a }
        // 清空后马上杀掉重启
        // 撤销清空后马上杀掉：撤销那一下也马上存了（四.5）
        clearTwice("undo-clear-kill: clear tap 1", "undo-clear-kill: clear tap 2") { waitCount(0, 1) == 0 }
        tool1("undo", "undo-clear-kill: undo the clear", keepsCount: false) { waitCount(n0, 1) == n0 && v2() == v2a }
        app.terminate()
        launch()
        _ = tapToggle(); settle(1.5)
        step("undo clear then kill + relaunch: strokes back", isOpen() && count() == n0 && v2() == v2a, "count=\(count()) (want \(n0)) v2=\(v2()) (want \(v2a))")
        cmd("finger on")
        clearTwice("clear before kill tap 1", "clear before kill tap 2") { waitCount(0, 1) == 0 }
        app.terminate()
        launch()
        _ = tapToggle(); settle(1.5)
        step("clear then kill + relaunch: stays cleared", isOpen() && count() == 0 && v2() == 0, "count=\(count()) v2=\(v2())")
        cmd("finger on")

        // ---- 离线清空旧稿：换题再回来，旧稿不回来；连上后补传 ----
        _ = http("_resetdrafts")
        app.terminate(); launch(); _ = tapToggle(); settle(1.5)
        step("old draft restored on server for offline test", v2() == 2, "v2=\(v2())")
        cmd("finger on")
        _ = switchTo("b", "2009-02"); _ = switchTo("a", "2009-01")   // 先在线打开过 2009-02：离线时只能打开 iPad 上存过的题
        settle(1.0)
        _ = http("_offline")
        clearTwice("offline clear tap 1", "offline clear tap 2") { v2() == 0 }
        let sw1 = switchTo("b", "2009-02"), sw2 = switchTo("a", "2009-01")
        step("offline: switch away and back by real taps, old draft stays cleared", v2() == 0 && !sw1.contains("WRONG") && !sw2.contains("WRONG"), "\(sw1) | \(sw2) v2=\(v2())")
        _ = http("_online")
        _ = switchTo("b", "2009-02"); _ = switchTo("a", "2009-01")
        settle(1.0)
        let srv = http("draft?id=2009-01")
        step("online again: cleared old draft uploaded", v2() == 0 && srv.contains("\"s\": []"), "v2=\(v2()) server=\(srv.prefix(120))")

        // ---- 三.1 旧稿晚到（假服务故意晚 5 秒回）：加载中挪纸，回来后取景窗不跳回；加载中清空，回来的旧稿一起清 ----
        // 假服务故意晚 12 秒回（边回边滴空格，App 的 6 秒请求超时不会触发）：窗口模式下 XCUITest 每点一下要 3 秒多，
        // 要保证挪纸、两下清空都发生在旧稿回来之前（r34 窗口竖屏 5 秒不够；r35 直接晚 10 秒又碰上了 App 的请求超时）
        _ = http("_resetdrafts"); _ = http("_slowdraft?ms=12000")
        app.terminate(); launch()
        _ = tapToggle(); settle(0.3)
        let ld1 = (web()["loading"] as? Bool) == true, nv0 = nview()
        z = zone()
        drag((z.x0 + 40, z.ys[2]), (z.x0 + 140, z.ys[2] + 90), velocity: 300, press: 0.05, hold: 0.3)   // 只认笔：单指挪纸
        let ld2 = (web()["loading"] as? Bool) == true, nv1 = nview()
        Thread.sleep(forTimeInterval: 12.5)
        let nv2 = nview(), wv = web()["V"] as? [Double] ?? []
        let panned = nv0.count == 3 && nv1.count == 3 && (abs(nv1[0] - nv0[0]) > 10 || abs(nv1[1] - nv0[1]) > 10)
        let follows = wv.count == 3 && nv2.count == 3 && abs(wv[0] - nv2[0]) < 1 && abs(wv[1] - nv2[1]) < 1 && abs(wv[2] - nv2[2]) < 0.001
        step("old draft arrives late after a pan: view kept, old draft shown and follows canvas",
             ld1 && ld2 && panned && nv1 == nv2 && follows && v2() == 2,
             "loading at open=\(ld1) after pan=\(ld2) native view \(nv0)->\(nv1)->\(nv2) web V=\(wv) v2=\(v2())")
        app.terminate(); launch()
        _ = tapToggle(); settle(0.3)
        let ld3 = (web()["loading"] as? Bool) == true
        clearTwice("slow old draft: clear tap 1", "slow old draft: clear tap 2") { true }
        let ld4 = (web()["loading"] as? Bool) == true
        Thread.sleep(forTimeInterval: 12.5)
        _ = http("_slowdraft?ms=0")   // 读电脑那份之前恢复正常（测试自己的请求也会被拖 5 秒、超时）
        let srvS = http("draft?id=2009-01")
        step("old draft arrives after a clear: cleared too and written back", ld3 && ld4 && v2() == 0 && srvS.contains("\"s\": []"),
             "loading at open=\(ld3) after clear=\(ld4) v2=\(v2()) server=\(srvS.prefix(120))")
        tool1("undo", "slow old draft: undo the clear brings it back", keepsCount: false) { Thread.sleep(forTimeInterval: 0.5); return v2() == 2 }
        _ = http("_slowdraft?ms=0")

        // ---- 三.2 清空过的旧稿离线时不回来；三.3 离线清空的连上后自动补传 ----
        _ = http("_resetdrafts")
        app.terminate(); launch(); _ = tapToggle(); settle(1.5)
        clearTwice("cache test online: clear tap 1", "cache test online: clear tap 2") { v2() == 0 }
        settle(1.5)   // 写回电脑（这时 App 应把离线缓存里这题的旧稿也换成清空后的）
        app.terminate(); _ = http("_offline"); launch(); _ = tapToggle(); settle(2.0)
        step("cleared online, killed, opened offline: old draft stays cleared", v2() == 0, "v2=\(v2())")
        _ = http("_online"); _ = http("_resetdrafts")
        app.terminate(); launch(); _ = tapToggle(); settle(1.5)   // 在线打开一次：缓存里是 2 条
        step("cache test: old draft back on server and in cache", v2() == 2, "v2=\(v2())")
        _ = http("_offline")
        clearTwice("cache test offline: clear tap 1", "cache test offline: clear tap 2") { v2() == 0 }
        _ = http("_online")
        Thread.sleep(forTimeInterval: 14)   // App 离线时每 8 秒探一次电脑；探到就补发记录、让网页补传旧稿（不重开草稿纸）
        let srvA = http("draft?id=2009-01")
        step("offline clear uploaded automatically when back online (no reopen)", srvA.contains("\"s\": []"), "server=\(srvA.prefix(120))")
        app.terminate(); _ = http("_offline"); launch(); _ = tapToggle(); settle(2.0)
        step("cleared offline, uploaded, opened offline again: stays cleared", v2() == 0, "v2=\(v2())")
        _ = http("_online"); _ = http("_resetdrafts")
        app.terminate(); launch(); _ = tapToggle(); settle(1.5)
        cmd("finger on")

        // ---- 收起后 200 毫秒内点页面选项要生效；写完一笔马上收起再开，那一笔还在 ----
        z = zone()
        write("stroke before quick close", (z.x0, z.ys[1]), (z.x1, z.ys[1] + 10))
        let keepP = prints()
        let k1 = web()["clk"] as? Int ?? -1
        let beatOpen = (native()["beat"] as? Bool) == true
        _ = tapRect(wbtn("close"))
        Thread.sleep(forTimeInterval: 0.15)
        _ = tapRect(web()["opt"] as? [Double])
        settle(1.0)
        step("main-thread heartbeat runs only while the draft is open", beatOpen && (native()["beat"] as? Bool) == false, "open=\(beatOpen) closed=\(native()["beat"] ?? "nil")")
        step("close then tap page option within 200ms: option gets the click", !isOpen() && (web()["clk"] as? Int ?? -1) > k1, "open=\(isOpen()) page clicks \(k1)->\(web()["clk"] ?? "nil")")
        _ = tapToggle(); settle(1.5)
        step("reopen: strokes kept", isOpen() && prints() == keepP, "count=\(count())")
        write("stroke then close immediately", (z.x0, z.ys[3]), (z.x1, z.ys[3] + 10))
        let keepQ = prints()
        _ = tapToggle(); settle(1.0)
        _ = tapToggle(); settle(1.5)
        step("stroke then close immediately: stroke kept after reopen", isOpen() && prints() == keepQ, "count \(keepQ.count)->\(count())")

        // ---- 换题（真点页面上的题号和抽屉里的题）再换回来：逐笔指纹一样 ----
        let pa = prints()
        _ = tapRect(wbtn("clear")); settle(0.3)
        let sureOn = (web()["clearSure"] as? Bool) == true, sureAct = lastTap()["act"] as? Int ?? 0
        let closedForSwitch = tapToggle(); settle(0.5)
        let st8 = state(), w8 = st8["web"] as? [String: Any] ?? [:], ts8 = st8["ts"] as? Int ?? 0
        let sinceConfirm = ts8 - sureAct   // 这份状态写出时，离确认那一下执行过了多久（App 时钟）
        step("clear confirm, then close to switch question: confirm dropped at once",
             sureOn && closedForSwitch && sureAct > 0 && (w8["clearSure"] as? Bool) == false && (w8["sureShown"] as? Bool) == false && (w8["open"] as? Bool) == false && sinceConfirm < 4000,
             "sure before=\(sureOn) after=\(w8["clearSure"] ?? "nil") bubble=\(w8["sureShown"] ?? "nil") open=\(w8["open"] ?? "nil"): state written \(sinceConfirm)ms after the confirm tap ran (confirm timeout is 4000)")
        let s1 = switchTo("b", "2009-02")
        let pb0 = prints()
        z = zone()
        write("stroke on 2009-02", (z.x0, z.ys[1] + 40), (z.x1, z.ys[1] + 60))
        let pb1 = prints()
        let s2 = switchTo("a", "2009-01")
        step("switch back by real taps: same strokes point by point", prints() == pa && !s1.contains("WRONG") && !s2.contains("WRONG"), "\(s1) | \(s2) count \(pa.count)->\(count()) (2009-02 had \(pb0.count))")
        let s3 = switchTo("b", "2009-02")
        step("other question kept its strokes point by point", prints() == pb1 && !s3.contains("WRONG"), s3)
        _ = switchTo("a", "2009-01")

        // ---- 工具条撤销后杀掉重启：和撤销后一样 ----
        z = zone()
        write("stroke before restart", (z.x0, z.ys[4]), (z.x1, z.ys[4] + 10))
        tool1("undo", "undo before restart", keepsCount: false) { waitCount(pa.count, 1) == pa.count }
        let afterUndo = prints(), v2b = v2()
        Thread.sleep(forTimeInterval: 1.5)
        app.terminate()
        launch()
        _ = tapToggle(); settle(1.5)
        step("after undo + kill + relaunch: same strokes", prints() == afterUndo && v2() == v2b, "count \(afterUndo.count)->\(count()) v2 \(v2b)->\(v2())")

        // ---- 开着转屏：笔画数不变，按新坐标写一笔落点对得上，工具条、收起按钮都在屏幕里 ----
        cmd("finger on")
        let nr = count()
        XCUIDevice.shared.orientation = o == "portrait" ? .landscapeLeft : .portrait
        Thread.sleep(forTimeInterval: 2.5)
        let (Wr, Hr) = wh()
        let tg = native()["toggle"] as? [Double] ?? [], dt = web()["dtool"] as? [Double] ?? []
        let inScr: ([Double]) -> Bool = { r in r.count == 4 && r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= Wr + 0.5 && r[1] + r[3] <= Hr + 0.5 }
        step("rotate while open: strokes kept, button and toolbar on screen", count() == nr && inScr(tg) && inScr(dt) && (native()["toggleHidden"] as? Bool) == false,
             "count \(nr)->\(count()) W=\(Wr) H=\(Hr) toggle=\(tg) toolbar=\(dt)")
        z = zone()
        write("stroke after rotate", (z.x0, z.ys[2] + 30), (z.x1, z.ys[2] + 40))
        XCUIDevice.shared.orientation = ori
        Thread.sleep(forTimeInterval: 2.0)

        // ---- Pencil 双击（模拟器造不出：命令直接调处理函数；不等于真机验证） ----
        let tb = web()["tool"] as? String ?? "?"
        cmd("pencil2"); settle()
        let ta = web()["tool"] as? String ?? "?"
        let logged = (native()["pencilLogged"] as? Bool) == true
        step("pencil double tap handler: switches once, toolbar follows, logged", tb != ta && tool().hasPrefix(ta == "eraser" ? "eraser" : "ink") && logged,
             "web tool \(tb)->\(ta) native=\(tool())")
        // 主线程 ≥250ms 卡顿：次数、最长
        let il = ((try? String(contentsOf: outDir.appendingPathComponent(name + ".ink.log"), encoding: .utf8)) ?? "").split(separator: "\n")
        let gaps = il.compactMap { l -> Int? in
            guard let r = l.range(of: "main thread blocked ") else { return nil }
            let t = l[r.upperBound...]; guard let p = t.firstIndex(of: "+") else { return nil }
            return Int(t[t.index(after: p)...].prefix { $0.isNumber })
        }
        mainStats[o] = ["count": gaps.count, "maxMs": gaps.max() ?? 0, "over1s": gaps.filter { $0 >= 1000 }.count]
        // 被取消的触摸：整个方向跑下来（含几次重启）一次都不许有
        let cl = Array(cancelLines().dropFirst(0).filter { !setupCancels.contains($0) })
        let nNative = cl.filter { $0.hasPrefix("native touch cancelled") }.count
        let nPC = cl.filter { $0.hasPrefix("web pointercancel") }.count, nTC = cl.filter { $0.hasPrefix("web touchcancel") }.count
        cancelStats[o] = ["nativeTouchCancelled": nNative, "webPointerCancel": nPC, "webTouchCancel": nTC, "lines": Array(cl.prefix(30)),
                          "setupResizeDrag": setupCancels]   // 测试拖窗口缩放把手那一下被系统收走的记录（不计入）
        step("no cancelled touches (native touchesCancelled, web pointercancel/touchcancel)", cl.isEmpty,
             "native=\(nNative) pointercancel=\(nPC) touchcancel=\(nTC) \(cl.prefix(6).joined(separator: " | "))")
        app.terminate()
        return steps
    }

    /// 两张截图（PNG）逐像素比，跳过 skip 里的矩形（屏幕点坐标），返回不同的像素个数
    /// 逐像素比两张整屏截图。skip 是 App 里的坐标（点）；win 是 App 窗口在屏幕上的框、scrW 是屏幕宽（点），W 是 App 自己的宽（点）。
    /// 窗口外面（窗口模式下系统画的墙纸、时间）不比；scrSkip 是屏幕坐标里不比的框（系统的窗口按钮、缩放把手）。
    /// 返回：差 > 8 级（任一通道）的像素个数和框；差 1–8 级的像素个数、最大差、框。框都是 App 坐标 [x0, y0, x1, y1]。
    /// 差异图：> 8 级画红，1–8 级画橙。
    private func pixelDiff(_ a: Data, _ b: Data, _ W: Double, _ skip: [[Double]], win: CGRect, scrW: Double, scrSkip: [[Double]] = [], save: URL)
        -> (big: Int, bigBox: [Int], small: Int, smallMax: Int, smallBox: [Int]) {
        guard let ia = UIImage(data: a)?.cgImage, let ib = UIImage(data: b)?.cgImage, ia.width == ib.width, ia.height == ib.height else { return (-1, [], -1, -1, []) }
        func rgba(_ i: CGImage) -> [UInt8] {
            var px = [UInt8](repeating: 0, count: i.width * i.height * 4)
            let ctx = CGContext(data: &px, width: i.width, height: i.height, bitsPerComponent: 8, bytesPerRow: i.width * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            ctx?.draw(i, in: CGRect(x: 0, y: 0, width: i.width, height: i.height))
            return px
        }
        let pa = rgba(ia), pb = rgba(ib), s = Double(ia.width) / scrW, k = W / Double(win.width)   // s：截图像素 / 屏幕点；k：App 点 / 屏幕点
        var n = 0, bx0 = Int.max, by0 = Int.max, bx1 = -1, by1 = -1
        var sn = 0, smax = 0, sx0 = Int.max, sy0 = Int.max, sx1 = -1, sy1 = -1
        var mark = [UInt8](repeating: 0, count: ia.width * ia.height * 4)
        for y in 0..<ia.height {
            for x in 0..<ia.width {
                let sx = Double(x) / s, sy = Double(y) / s   // 屏幕上的点
                if sx < Double(win.minX) || sx >= Double(win.maxX) || sy < Double(win.minY) || sy >= Double(win.maxY) { continue }
                if scrSkip.contains(where: { sx >= $0[0] && sx <= $0[0] + $0[2] && sy >= $0[1] && sy <= $0[1] + $0[3] }) { continue }
                let px = (sx - Double(win.minX)) * k, py = (sy - Double(win.minY)) * k   // App 里的点
                if skip.contains(where: { px >= $0[0] && px <= $0[0] + $0[2] && py >= $0[1] && py <= $0[1] + $0[3] }) { continue }
                let i = (y * ia.width + x) * 4
                let dd = max(abs(Int(pa[i]) - Int(pb[i])), abs(Int(pa[i + 1]) - Int(pb[i + 1])), abs(Int(pa[i + 2]) - Int(pb[i + 2])))
                if dd > 8 {
                    n += 1; bx0 = min(bx0, x); by0 = min(by0, y); bx1 = max(bx1, x); by1 = max(by1, y)
                    mark[i] = 255; mark[i + 3] = 255
                } else if dd > 0 {
                    sn += 1; smax = max(smax, dd); sx0 = min(sx0, x); sy0 = min(sy0, y); sx1 = max(sx1, x); sy1 = max(sy1, y)
                    mark[i] = 255; mark[i + 1] = 150; mark[i + 3] = 255
                }
            }
        }
        // 不同的像素画成红点存一张图，方便看是哪里变了
        if n + sn > 0, let ctx = CGContext(data: &mark, width: ia.width, height: ia.height, bitsPerComponent: 8, bytesPerRow: ia.width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
           let img = ctx.makeImage() { try? UIImage(cgImage: img).pngData()?.write(to: save) }
        let toApp: (Int, Int) -> [Int] = { x, y in [Int((Double(x) / s - Double(win.minX)) * k), Int((Double(y) / s - Double(win.minY)) * k)] }
        return (n, n > 0 ? toApp(bx0, by0) + toApp(bx1, by1) : [], sn, smax, sn > 0 ? toApp(sx0, sy0) + toApp(sx1, sy1) : [])
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
