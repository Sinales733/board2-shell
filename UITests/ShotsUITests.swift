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
            shot("motion-settings-\(t)", scene: "motion", orient: .landscapeLeft, theme: t, screenshot: false, wait: 40)
        }
        _ = http("_offline")
        for t in themes {
            shot("motion-offline-\(t)", scene: "motion-offline", orient: .landscapeLeft, theme: t, screenshot: false, wait: 40)
        }
        _ = http("_online")
        XCUIDevice.shared.orientation = .portrait
    }

    // MARK: - 真实触摸写字（1.7 起；1.8 改成测正规 PencilKit 画布 + 苹果工具盘）

    /// 用 XCUITest 的真拖动、真点按（走完整的 UIKit 触摸链路）测草稿纸。模拟器造不出 Apple Pencil，
    /// 写字时让画布"手指也写"（drawingPolicy = anyInput，相当于工具盘里打开"用手指绘图"），挪纸时改回"只认笔"。
    /// 每一步都读 App 写出的状态核对；结果写 inktest.json，ci/check_selftest.py 逐条检查。
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
        for u in [readyURL, stateURL, cmdURL, outDir.appendingPathComponent(name + ".ink.log")] { try? FileManager.default.removeItem(at: u) }
        app.launchEnvironment = ["B2_OUT": outDir.path, "B2_NAME": name]
        app.launchArguments = ["-b2shot", "inktest", "-b2theme", "night", "-b2q", "2009-01", "-b2at", "3", "-b2server", server]
        app.launch()
        XCUIDevice.shared.orientation = ori
        var steps: [[String: Any]] = []
        func step(_ n: String, _ ok: Bool, _ note: String) {
            steps.append(["name": "\(o): \(n)", "ok": ok, "note": note])
            print("INK \(o): \(n) ok=\(ok) \(note)")
        }
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline && !FileManager.default.fileExists(atPath: readyURL.path) { Thread.sleep(forTimeInterval: 0.3) }
        Thread.sleep(forTimeInterval: 1.0)

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
        /// 等笔画数变成 want（最多 t 秒），变到了再多等一会儿看它会不会又变（写出来又没了）
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
        let W = (web()["W"] as? Double) ?? 820, H = (web()["H"] as? Double) ?? 1180
        let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
        func at(_ x: Double, _ y: Double) -> XCUICoordinate { origin.withOffset(CGVector(dx: x, dy: y)) }
        func drag(_ a: (Double, Double), _ b: (Double, Double), velocity: CGFloat = 300, press: TimeInterval = 0.05, hold: TimeInterval = 0.05) {
            at(a.0, a.1).press(forDuration: press, thenDragTo: at(b.0, b.1), withVelocity: XCUIGestureVelocity(velocity), thenHoldForDuration: hold)
            Thread.sleep(forTimeInterval: 0.5)
        }
        func tapRect(_ r: [Double]?) -> Bool {
            guard let r = r, r.count == 4, r[2] > 0 else { return false }
            at(r[0] + r[2] / 2, r[1] + r[3] / 2).tap()
            Thread.sleep(forTimeInterval: 1.0)
            return true
        }
        /// 工具盘里的按钮：按读屏标签找（英文 / 中文都试），找到就点一次。返回找到的标签。
        func tapPicker(_ names: [String]) -> String? {
            for n in names {
                let e = app.descendants(matching: .any).matching(NSPredicate(format: "label ==[c] %@ OR identifier ==[c] %@", n, n)).firstMatch
                if e.waitForExistence(timeout: 3) && e.isHittable { e.tap(); Thread.sleep(forTimeInterval: 1.0); return n }
            }
            // 找不到：把界面树写下来，下次照着改
            try? app.debugDescription.write(to: outDir.appendingPathComponent("\(name)-tree.txt"), atomically: true, encoding: .utf8)
            return nil
        }
        /// 最后一笔第一个点、最后一个点离拖动起止点多远（屏幕上的点）
        func lastErr(_ a: (Double, Double), _ b: (Double, Double)) -> (Double, Double) {
            guard let ss = native()["strokes"] as? [[Double]], let s = ss.last, s.count == 4 else { return (9999, 9999) }
            return (hypot(s[0] - a.0, s[1] - a.1), hypot(s[2] - b.0, s[3] - b.1))
        }
        /// 终点必须对准（< 18 点，查取景窗换算对不对）；起点放宽到 < 60：PencilKit 认手指画画要先等一下分辨是不是挪纸（系统行为），
        /// 模拟器里的拖动一按下就开始走，开头一小段会被吃掉。真机用笔没有这一等。
        func write(_ label: String, _ a: (Double, Double), _ b: (Double, Double)) {
            let before = count()
            drag(a, b, velocity: 250, press: 0.3)
            let after = waitCount(before + 1)
            let (es, ee) = lastErr(a, b)
            // 手指真正抬起的位置（UIKit 报给画画手势的）：笔画最后一个点必须就在那里
            var te = 9999.0
            if let t = native()["lastTouchEnd"] as? [Double], t.count == 2, let ss = native()["strokes"] as? [[Double]], let s = ss.last, s.count == 4 {
                te = hypot(s[2] - t[0], s[3] - t[1])
            }
            step(label, after == before + 1 && te < 4, "count \(before)->\(after) stroke end vs real touch \(String(format: "%.1f", te)) (vs requested drag: start \(Int(es)) end \(Int(ee)))")
        }
        /// 网页旧稿的取景窗和画布的一样（旧稿跟着画布走）
        func viewsMatch() -> (Bool, String) {
            let n = nview(), w = web()["V"] as? [Double] ?? []
            guard n.count == 3, w.count == 3 else { return (false, "n=\(n) w=\(w)") }
            let ok = abs(n[0] - w[0]) < 1.5 && abs(n[1] - w[1]) < 1.5 && abs(n[2] - w[2]) < 0.002
            return (ok, "native \(n.map { Int($0 * 100) }) web \(w.map { Int($0 * 100) })")
        }

        let ready = FileManager.default.fileExists(atPath: readyURL.path)
        let n0 = native(), w0 = web()
        step("ready", ready && (w0["open"] as? Bool) == true && (n0["open"] as? Bool) == true && (n0["picker"] as? Bool) == true && (w0["dtoolShown"] as? Bool) == false,
             "ready=\(ready) web open=\(w0["open"] ?? "nil") canvas open=\(n0["open"] ?? "nil") picker=\(n0["picker"] ?? "nil") webToolbar=\(w0["dtoolShown"] ?? "nil") W=\(W) H=\(H)")
        // 写字区：左边一段、中间一段高，避开右上角的按钮和底下的工具盘
        let x0 = W * 0.12, x1 = W * 0.52
        let ys = (0..<5).map { H * 0.25 + Double($0) * H * 0.07 }
        let n = o == "portrait" ? 5 : 2
        for i in 0..<n { write("finger stroke \(i + 1)", (x0, ys[i]), (x1, ys[i] + 20)) }
        if o == "landscape" {
            // 对照：草稿纸收着时点页面中部，页面能不能收到 pointerdown（看测试环境本身点不点得到网页）
            cmd("close")
            let b0 = web()["clicks"] as? Int ?? -1
            at(W * 0.62 + 20, H * 0.5 + 20).tap(); Thread.sleep(forTimeInterval: 1.0)
            let b1 = web()["clicks"] as? Int ?? -1
            step("baseline: closed (via cmd), tap on page reaches page", b1 > b0, "page pointerdowns \(b0)->\(b1)")
            cmd("open")
            let (vm, note) = viewsMatch()
            step("old draft follows canvas", vm, note)
            app.terminate(); return steps
        }

        // 工具盘：点橡皮（只点一次），工具确实变了；沿第 5 笔擦，第 1–4 笔逐点不变
        let five = prints()
        let er = tapPicker(["Eraser", "Object Eraser", "Pixel Eraser", "橡皮擦", "橡皮"])
        step("picker: tap eraser once", er != nil && tool().hasPrefix("eraser"), "found=\(er ?? "nil") tool=\(tool())")
        drag((x0 - 20, ys[4] - 1), (x1 + 20, ys[4] + 21), velocity: 300)
        Thread.sleep(forTimeInterval: 1.0)
        let afterErase = prints()
        let keptSame = five.count == 5 && Array(five.prefix(4)).allSatisfy { afterErase.contains($0) }
        let fifth = five.count == 5 ? five[4] : "-"
        step("erase leaves other strokes untouched", keptSame && !afterErase.contains(fifth),
             "before \(five.count) after \(afterErase.count) untouched=\(keptSame)")
        let un = tapPicker(["Undo", "撤销"])
        Thread.sleep(forTimeInterval: 0.6)
        step("picker: undo", un != nil && prints() == five, "found=\(un ?? "nil") count=\(count())")
        let re = tapPicker(["Redo", "重做"])
        Thread.sleep(forTimeInterval: 0.6)
        step("picker: redo", re != nil && prints() == afterErase, "found=\(re ?? "nil") count=\(count())")
        _ = tapPicker(["Undo", "撤销"])
        let pen = tapPicker(["Pen", "钢笔", "笔"])
        step("picker: tap pen once", pen != nil && tool().hasPrefix("ink"), "found=\(pen ?? "nil") tool=\(tool())")
        let kept = count()

        // 草稿纸开着（只认笔）：手指点下面的选项不生效；原生按钮点一次收起；收起后点选项生效；再点一次打开，笔画还在
        cmd("finger off")
        let pageR: [Double] = [W * 0.62, H * 0.5, 40, 40]
        let clicks0 = web()["clicks"] as? Int ?? -1
        _ = tapRect(pageR)
        let clicks1 = web()["clicks"] as? Int ?? -1
        step("open: tap on page is blocked", clicks1 == clicks0 && count() == kept, "page pointerdowns \(clicks0)->\(clicks1)")
        // 开关：按读屏标识找到 App 的按钮点一次（点不到会记下为什么）
        let tgEl = app.buttons.matching(identifier: "b2draftToggle").firstMatch
        let tgFound = tgEl.waitForExistence(timeout: 3), tgHit = tgFound && tgEl.isHittable
        if tgHit { tgEl.tap(); Thread.sleep(forTimeInterval: 1.0) } else { _ = tapRect(native()["toggle"] as? [Double]) }
        let tg = native()["toggle"] as? [Double]
        if (web()["open"] as? Bool) != false {
            try? app.debugDescription.write(to: outDir.appendingPathComponent("\(name)-toggle-tree.txt"), atomically: true, encoding: .utf8)
        }
        step("toggle closes (one tap)", (web()["open"] as? Bool) == false && (native()["open"] as? Bool) == false && (native()["picker"] as? Bool) == false,
             "web=\(web()["open"] ?? "nil") canvas=\(native()["open"] ?? "nil") toggle=\(tg ?? []) found=\(tgFound) hittable=\(tgHit)")
        _ = tapRect(pageR)
        let clicks2 = web()["clicks"] as? Int ?? -1
        step("closed: tap on page works", clicks2 > clicks1, "page pointerdowns \(clicks1)->\(clicks2)")
        // 这个示例页里网页本来没有草稿纸按钮（量不到），收着时 App 的按钮也不出来：那就用命令打开
        let hiddenWhenClosed = (native()["toggleHidden"] as? Bool) == true
        if hiddenWhenClosed { cmd("open") } else { _ = tapRect(native()["toggle"] as? [Double]) }
        let c2 = waitCount(kept)
        step("reopen, strokes kept", (web()["open"] as? Bool) == true && (native()["picker"] as? Bool) == true && (native()["toggleHidden"] as? Bool) == false && c2 == kept,
             "count \(kept)->\(c2) via \(hiddenWhenClosed ? "cmd (toggle hidden: page has no draft button)" : "toggle")")

        // 只认笔时单指拖动挪纸：取景窗跟着手指走，没有多出笔画，网页旧稿跟着走
        let v0 = nview()
        drag((x0 + 40, ys[2]), (x0 + 140, ys[2] + 90), velocity: 200, hold: 0.8)
        Thread.sleep(forTimeInterval: 1.2)
        let v1 = nview()
        let moved = v0.count == 3 && v1.count == 3 && abs((v1[0] - v0[0]) - 100) < 25 && abs((v1[1] - v0[1]) - 90) < 25
        step("one finger pans paper", moved && count() == kept, "view \(v0.map { Int($0) }) -> \(v1.map { Int($0) }) count=\(count())")
        let (vm, vnote) = viewsMatch()
        step("old draft follows canvas", vm, vnote)

        // 换题再换回来：笔画还在；换过去写的那一笔也还在
        cmd("finger on")
        cmd("goto 2009-02"); Thread.sleep(forTimeInterval: 1.5)
        let other0 = count()
        step("switch question", (web()["id"] as? String) == "2009-02" && (native()["id"] as? String) == "2009-02", "id=\(web()["id"] ?? "nil") count=\(other0)")
        write("stroke on 2009-02", (x0, ys[1] + 40), (x1, ys[1] + 60))
        cmd("goto 2009-01"); Thread.sleep(forTimeInterval: 1.5)
        var c3 = waitCount(kept)
        step("switch back keeps strokes", (web()["id"] as? String) == "2009-01" && c3 == kept, "id=\(web()["id"] ?? "nil") count \(kept)->\(c3)")
        cmd("goto 2009-02"); Thread.sleep(forTimeInterval: 1.5)
        c3 = waitCount(other0 + 1)
        step("other question kept its stroke", c3 == other0 + 1, "count \(other0 + 1)->\(c3)")
        cmd("goto 2009-01"); Thread.sleep(forTimeInterval: 1.5)
        _ = waitCount(kept)

        // 双指缩放：不多出笔画；缩放以后再写，落点对得上；旧稿跟着缩放
        let z0 = nview().last ?? 1
        app.pinch(withScale: 1.8, velocity: 1.5)
        Thread.sleep(forTimeInterval: 1.5)
        let z1 = nview().last ?? 1
        step("pinch zoom adds no stroke", count() == kept && abs(z1 - z0) > 0.15, "count \(kept)->\(count()) z \(z0)->\(z1)")
        write("stroke after zoom", (x0 + 30, ys[2] + 30), (x1 - 30, ys[2] + 50))
        let (vm2, vnote2) = viewsMatch()
        step("old draft follows zoom", vm2, vnote2)
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
