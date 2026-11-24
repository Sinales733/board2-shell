import XCTest

/// 边缘压力测试（只在 GitHub Actions 的 stress 任务里跑，环境变量 B2_STRESS = full-portrait / full-landscape / windowed-portrait / windowed-landscape）：
/// 工具条每个按钮（笔、橡皮、颜色、清空、缩放比例、更多、收起）轮流各点 300 下，左边缘抽屉里的题格点 300 下，两下之间随机隔 150–600 毫秒。
/// 要求：被系统 / 手势收走的触摸 0 次；工具条每一下 抬手→网页执行 ≤300ms，一下都不能丢；笔 / 橡皮每一下 抬手→画布换上 ≤300ms；
/// 题格每一下 抬手→网页收到 click ≤300ms。结果写 stress-<配置>.json，ci/check_stress.py 判。
/// 不点撤销（没有可撤销的东西时按钮是灰的，点了不算一下）；拖动类控件（手柄、透明度条）不在这里。
final class StressUITests: XCTestCase {

    private let server = "http://127.0.0.1:8409/"
    private let cfg = ProcessInfo.processInfo.environment["B2_STRESS"] ?? ""
    private lazy var outDir: URL = {
        let host = ProcessInfo.processInfo.environment["SIMULATOR_HOST_HOME"] ?? NSTemporaryDirectory()
        let url = URL(fileURLWithPath: host).appendingPathComponent("b2shots", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    override func setUp() { continueAfterFailure = true }

    private func http(_ path: String) {
        let sem = DispatchSemaphore(value: 0)
        var r = URLRequest(url: URL(string: server + path)!)
        r.timeoutInterval = 5
        URLSession.shared.dataTask(with: r) { _, _, _ in sem.signal() }.resume()
        _ = sem.wait(timeout: .now() + 8)
    }

    // swiftlint:disable:next function_body_length
    func testStress() {
        guard !cfg.isEmpty else { return }
        let windowed = cfg.hasPrefix("windowed"), portrait = cfg.hasSuffix("portrait")
        let ori: UIDeviceOrientation = portrait ? .portrait : .landscapeLeft
        let name = "stress-" + cfg
        let app = XCUIApplication()
        let readyURL = outDir.appendingPathComponent(name + ".ready"), stateURL = outDir.appendingPathComponent(name + ".state.json")
        let cmdURL = outDir.appendingPathComponent(name + ".cmd"), logURL = outDir.appendingPathComponent(name + ".ink.log")
        let cancelURL = outDir.appendingPathComponent(name + ".cancel.log")
        for u in [logURL, cancelURL] { try? FileManager.default.removeItem(at: u) }
        func launch() {
            XCUIDevice.shared.orientation = ori
            for u in [readyURL, stateURL, cmdURL] { try? FileManager.default.removeItem(at: u) }
            app.launchEnvironment = ["B2_OUT": outDir.path, "B2_NAME": name]
            app.launchArguments = ["-b2shot", "inktest", "-b2theme", "night", "-b2q", "2009-01", "-b2server", server]
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
        func web() -> [String: Any] { state()["web"] as? [String: Any] ?? [:] }
        func cmd(_ c: String) { try? c.write(to: cmdURL, atomically: true, encoding: .utf8); Thread.sleep(forTimeInterval: 1.0) }
        let base = app.webViews.firstMatch
        func wh() -> (Double, Double) { ((web()["W"] as? Double) ?? 820, (web()["H"] as? Double) ?? 1180) }
        func center(_ r: [Double]?) -> (Double, Double)? { guard let r = r, r.count == 4, r[2] > 0 else { return nil }; return (r[0] + r[2] / 2, r[1] + r[3] / 2) }
        // 位置事先查好（工具条不动），连点时不再读状态
        func coord(_ r: [Double]?) -> XCUICoordinate? {
            guard let c = center(r) else { return nil }
            let (W, H) = wh()
            return base.coordinate(withNormalizedOffset: CGVector(dx: c.0 / W, dy: c.1 / H))
        }
        func pause() { Thread.sleep(forTimeInterval: Double.random(in: 0.15...0.6)) }
        let toggle = app.buttons.matching(identifier: "b2draftToggle").firstMatch

        _ = http("_online"); _ = http("_resetdrafts")
        launch(); cmd("resetall"); app.terminate(); launch()
        _ = base.waitForExistence(timeout: 10)
        var setup: [String] = []
        if windowed {   // 窗口模式：拖右下角缩放把手缩成窗口（这一下被系统收走，单独记）
            let wc = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 1))
            let before = ((try? String(contentsOf: cancelURL, encoding: .utf8)) ?? "").split(separator: "\n").count
            wc.withOffset(CGVector(dx: -6, dy: -6)).press(forDuration: 0.6, thenDragTo: wc.withOffset(CGVector(dx: -110, dy: -130)))
            Thread.sleep(forTimeInterval: 2.0)
            setup = ((try? String(contentsOf: cancelURL, encoding: .utf8)) ?? "").split(separator: "\n").dropFirst(before).map(String.init)
        }
        let winF = app.windows.firstMatch.frame
        if toggle.waitForExistence(timeout: 3) { toggle.tap() }
        Thread.sleep(forTimeInterval: 1.5)
        cmd("mark stress-toolbar-start")
        let btns = web()["btn"] as? [String: Any] ?? [:]
        let order = ["pen", "eraser", "color", "clear", "zoom", "more", "close"]
        var cs: [String: XCUICoordinate] = [:]
        for k in order { if let c = coord(btns[k] as? [Double]) { cs[k] = c } }
        var sent: [String: Int] = [:]
        let rounds = 300
        if cs.count == order.count {
            for _ in 0..<rounds {
                for k in order {
                    cs[k]!.tap(); sent[k, default: 0] += 1; pause()
                    if k == "close" { toggle.tap(); sent["reopen", default: 0] += 1; pause() }
                }
            }
        }
        cmd("mark stress-toolbar-end")
        // 左边缘抽屉里的题格：收起草稿纸，点题号开抽屉、点题格换题，300 下
        if toggle.exists { toggle.tap(); Thread.sleep(forTimeInterval: 1.0) }
        cmd("mark stress-cells-start")
        var cellSent = 0
        if let tag = coord(web()["tag"] as? [Double]) {
            tag.tap(); Thread.sleep(forTimeInterval: 1.2)
            let cells = web()["cells"] as? [String: Any] ?? [:]
            let ca = coord(cells["a"] as? [Double]), cb = coord(cells["b"] as? [Double])
            if let ca = ca, let cb = cb {
                cb.tap(); cellSent += 1; pause()
                for i in 1..<rounds {
                    tag.tap(); pause()
                    (i % 2 == 0 ? cb : ca).tap(); cellSent += 1; pause()
                }
            }
        }
        cmd("mark stress-cells-end")
        Thread.sleep(forTimeInterval: 2.0)
        let rec: [String: Any] = ["cfg": cfg, "window": "\(winF)", "sentToolbar": sent, "sentCells": cellSent, "setupResizeDrag": setup,
                                  "btnFound": Array(cs.keys).sorted()]
        if let d = try? JSONSerialization.data(withJSONObject: rec, options: [.prettyPrinted, .sortedKeys]) {
            try? d.write(to: outDir.appendingPathComponent(name + ".sent.json"))
        }
        print("STRESS sent \(rec)")
        app.terminate()
    }
}
