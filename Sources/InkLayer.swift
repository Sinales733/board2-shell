import UIKit
import PencilKit
import WebKit

/// 原生笔迹草稿纸（1.8 起按"备忘录"的方式正规使用 PencilKit）。
/// - 草稿纸打开时，PKCanvasView 是盖在网页上面的普通视图，自己接触摸：笔写字，手指只挪纸、双指缩放（画布本身就是滚动视图）；
///   写字、橡皮、撤销、防手掌全是 PencilKit 自带的。工具条用网页原来那条（kit/draft.js 的 #dtool，不用苹果的工具盘）：
///   它把笔 / 橡皮 / 颜色 / 手指书写放在状态消息里发过来，App 换成 PKInkingTool / PKEraserTool(.bitmap，和 1.6 一样)、笔的颜色、
///   drawingPolicy（手指书写关 = .pencilOnly，手指只挪纸缩放；开 = .anyInput）；撤销、清空、缩放比例单独发消息，App 做完回报能不能撤销。
/// - 打开时手指不穿透到下面的题（要点下面先收起草稿纸）；网页"纸上面的那几层"（工具条和它展开的小弹层、问答面板、抽屉、提示条）
///   让出来给网页：画布在那里不接触摸，点工具条第一下就到网页、纸上不留笔画。收起时第一响应者交回网页，下面第一下就能点。
/// - Pencil 双击：交给网页切笔 / 橡皮（和网页草稿纸一直以来的做法一样），网页再把新工具发回来，工具条高亮跟着变。
///   画布自己不处理双击（WWDC19 Introducing PencilKit：要处理 Pencil 双击得自己用 UIPencilInteraction；苹果文档没说画布会自己切）。
/// - 开关：App 自己的按钮（DraftToggle），盖在网页草稿纸按钮原来的位置上（夹在安全区内），一直点得到。开关状态以网页为准
///   （网页 Kit.draft.open/close）；但收起不只靠网页：网页报错、1 秒内没回话、网页换页或进程挂了，App 自己先存盘再收起。
/// - 网页 kit/draft.js（v10 起）在 App 里负责：纸、工具条、旧 v2 笔迹垫底（清空时一起清）、题号和开关告诉 App；不碰纸上的触摸。
///   取景窗由画布定，每次滚动缩放把 {x, y, z}（屏幕 = 纸面 × z + (x, y)）交给网页（Kit.draft.native.at），旧稿跟着画。
/// - 新笔迹存 PencilKit 自己的格式：iPad 上 Application Support/ink/<键>.drawing（+ 每题的取景窗），
///   连得上电脑时另存一份到电脑的 data/draft/pk_<键>.json（走原来的 POST /draft，不覆盖 <题号>.json）。1.3–1.7 存的照常读。
/// 存盘：画布每次变（写、擦、撤销重做、合并进电脑那份）记"笔迹脏"，挪纸缩放停下记"取景窗脏"，1.2 秒防抖后存；换题、收起、进后台立刻存。
/// 这道题还没从盘上读完就要存（读盘时写了字又马上换题）：不直接覆盖，而是在存盘队列里和盘上那份合并后再存。
final class InkLayer: NSObject {

    /// 纸面坐标 (0, 0) 在画布内容里的位置。画布 10 万点见方，纸面坐标往四个方向都能写到 ±5 万。
    static let origin: CGFloat = 50_000
    static let contentSide: CGFloat = 100_000

    let canvas = InkCanvas()
    let toggle = DraftToggle()
    private weak var host: UIView?
    private weak var webView: WKWebView?
    private let store = InkStore()

    private var isOpen = false
    /// 草稿纸开着没有（三指长按开设置时要看）
    var drawerOpen: Bool { isOpen }
    private var id: String?
    private var theme = "night"
    private var labels = (open: "", close: "")
    private var webBtn = CGRect.zero
    private var webBtnCovered = false
    private let maskLayer = CAShapeLayer()

    private var settingDrawing = false
    private var lastCount = 0
    private var saveWork: DispatchWorkItem?
    private var loadToken = 0
    /// 这道题打开后画布有没有变过（等电脑那份回来时用：变过就合并，没变过才整张换）。
    private var changedSinceLoad = false
    private var dirtyDrawing = false
    private var dirtyView = false
    /// 这道题的取景窗是不是已经由 App 定了（本机存过的取景窗 / 用户挪过）；没定之前用网页旧稿的取景窗
    private var viewSettled = false
    private var applyingView = false
    private var lastStateLog = ""
    /// 这道题已经从盘上读完了吗（没读完时存盘改成"和盘上那份合并再存"，免得盖掉原笔迹）
    private var loaded = true
    private var closeSeq = 0
    /// 第一次变脏的时刻（开机以来秒；0 = 不脏）：防抖最长等 5 秒
    private var firstDirtyAt: TimeInterval = 0
    /// 最近一次给画布换上工具：哪个、墙上时刻（毫秒）、换这一句用了多久
    private var lastToolApply: [String: Any] = [:]
    /// 让出区个数最近一次变化：个数、网页发出时刻、App 收到时刻（墙上毫秒）
    private var lastRects: [String: Any] = [:]
    /// 抬笔了但 PencilKit 还没把这一笔交到画布上（drawingDidChange 没回来）：收起 / 换题先等它
    private var pendingStroke = false
    private var pendingSince: TimeInterval = 0
    /// 最后一笔属于哪道题（抬笔那一刻的题号）
    private var pendingStrokeId: String?
    /// 等最后一笔期间到的消息：按到达顺序排队，等完一起按顺序处理
    private var deferQueue: [[String: Any]] = []
    private var deferring = false
    /// 等了 300 毫秒还没交到画布的那一笔：晚到时按它原来的题号存（题号、截止时刻）
    private var lateStroke: (id: String, until: TimeInterval)?
    /// 最近一次工具条点击的时间线（截图模式状态文件用）
    private var lastTap: [String: Any] = [:]
    private var toolName = "pen", colorName = "ink", finger = false
    /// 测试用：强制手指也写（模拟器里写字用），nil = 跟网页工具条的手指书写开关走
    private var testFingerOverride: Bool?

    /// 在页面最开头告诉网页：这里有原生笔迹，draft.js 据此不显示自己的工具条、不碰触摸。
    static let flagScript = "window.B2Native = Object.assign(window.B2Native || {}, { ink: true, v: 4 });"
        // 1.8 起手指默认只挪纸：第一次打开 1.8 时把网页工具条记着的"手指书写"关掉（1.7 时可能为了能写字打开过），只做一次
        + "try{if(!localStorage.getItem('b2fingerReset18')){var u=JSON.parse(localStorage.getItem('b2draftUI')||'{}');u.finger=false;"
        + "localStorage.setItem('b2draftUI',JSON.stringify(u));localStorage.setItem('b2fingerReset18','1');}}catch(e){}"

    /// 网页工具条的四种颜色（存白天那一套；夜间 PencilKit 自己按深色界面换算，和网页"存名字、昼夜各有色值"效果接近）。
    static let colors: [String: UIColor] = [
        "ink": UIColor(red: 0x1f / 255, green: 0x1d / 255, blue: 0x1a / 255, alpha: 1),
        "red": UIColor(red: 0xc3 / 255, green: 0x3a / 255, blue: 0x32 / 255, alpha: 1),
        "blue": UIColor(red: 0x2b / 255, green: 0x64 / 255, blue: 0xa3 / 255, alpha: 1),
        "green": UIColor(red: 0x2a / 255, green: 0x7f / 255, blue: 0x4a / 255, alpha: 1)
    ]
    private static var defaultInk: UIColor { colors["ink"]! }

    init(host: UIView, webView: WKWebView) {
        self.host = host
        self.webView = webView
        super.init()

        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.isHidden = true
        canvas.drawingPolicy = .pencilOnly
        canvas.showsVerticalScrollIndicator = false
        canvas.showsHorizontalScrollIndicator = false
        canvas.contentInsetAdjustmentBehavior = .never
        canvas.bouncesZoom = false
        canvas.bounces = false
        canvas.minimumZoomScale = 0.05
        canvas.maximumZoomScale = 30
        canvas.contentSize = CGSize(width: InkLayer.contentSide, height: InkLayer.contentSide)
        canvas.contentOffset = CGPoint(x: InkLayer.origin, y: InkLayer.origin)
        canvas.tool = PKInkingTool(.pen, color: InkLayer.defaultInk, width: 2.4)
        canvas.delegate = self
        canvas.accessibilityIdentifier = "b2inkCanvas"
        canvas.translatesAutoresizingMaskIntoConstraints = false
        host.insertSubview(canvas, aboveSubview: webView)
        NSLayoutConstraint.activate([
            canvas.topAnchor.constraint(equalTo: host.topAnchor),
            canvas.bottomAnchor.constraint(equalTo: host.bottomAnchor),
            canvas.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            canvas.trailingAnchor.constraint(equalTo: host.trailingAnchor)
        ])
        maskLayer.fillRule = .evenOdd   // 路径里已经没有重叠的洞了，两种规则结果一样
        // 启动时（画布一定是空的）先给画布换一次位图橡皮再换回笔：冷启动后第一次换橡皮、画布上又有笔画时，PencilKit 要卡 1.7–3.9 秒
        // （云端诊断 r29-diag：不预热冷启动第一次 1721ms；空画布上预热只要 2–12ms，之后换橡皮 3–4ms）。诊断变体 nowarm 关掉它
        if !ShotVariant.on("nowarm") { DispatchQueue.main.async { self.buildTools(); self.warmEraser("launch") } }
        canvas.layer.mask = maskLayer
        canvas.drawingGestureRecognizer.addTarget(self, action: #selector(drawingGesture(_:)))

        toggle.isHidden = true
        toggle.addTarget(self, action: #selector(togglePressed), for: .touchUpInside)
        host.insertSubview(toggle, aboveSubview: canvas)
        placeToggle()
    }

    // MARK: - 开关按钮

    @objc private func togglePressed() {
        Haptics.tap()
        let want = !isOpen
        InkDiag.shared.log("toggle tap open=\(isOpen)")
        guard let web = webView else { if !want { forceClose("no web view") }; return }
        if want {
            web.evaluateJavaScript("Kit.draft.open();0") { _, e in if let e = e { InkDiag.shared.log("toggle open js error \(e)") } }
            return
        }
        // 收起：让网页收；网页报错、或 1 秒内没等到网页说"收了"，App 自己先存盘再收起
        closeSeq += 1
        let seq = closeSeq
        web.evaluateJavaScript("Kit.draft.close();0") { [weak self] _, e in
            if let e = e { self?.forceClose("js error \(e.localizedDescription)") }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self = self, seq == self.closeSeq, self.isOpen else { return }
            self.forceClose("no state from web in 1s")
        }
    }

    /// 不等网页：先存盘再收起画布和工具盘（网页卡住、换页、进程挂了时用）。
    func forceClose(_ why: String) {
        guard isOpen else { return }
        InkDiag.shared.log("force close: \(why)")
        saveAfterLastStroke()
        isOpen = false
        closeUI()
        placeToggle()
        webView?.evaluateJavaScript("window.Kit && Kit.draft && Kit.draft.D.open && Kit.draft.close();0", completionHandler: nil)
    }

    /// 按钮放在网页草稿纸按钮的位置上（网页的那颗在 App 里只占位不显示）；网页没报位置就放右上角。
    private func placeToggle() {
        guard let host = host else { return }
        let s: CGFloat = 46
        var f: CGRect
        if webBtn.width > 4 && webBtn.height > 4 {
            f = CGRect(x: webBtn.midX - s / 2, y: webBtn.midY - s / 2, width: s, height: s)
        } else {
            let top = host.safeAreaInsets.top
            f = CGRect(x: host.bounds.width - host.safeAreaInsets.right - 12 - s, y: top + 12, width: s, height: s)
        }
        // 夹进安全区：任何情况下（转屏、网页按钮跑到屏幕外）按钮都整个在屏幕里、点得到
        let safe = host.bounds.inset(by: host.safeAreaInsets).insetBy(dx: 4, dy: 4)
        if safe.width > s && safe.height > s {
            f.origin.x = min(max(f.minX, safe.minX), safe.maxX - s)
            f.origin.y = min(max(f.minY, safe.minY), safe.maxY - s)
        }
        // 开着、网页按钮那里被面板盖住（比如竖屏把问答面板放大了）：按钮挪到不压任何让出区的地方，不盖住面板上的按钮
        if isOpen && webBtnCovered {
            let cands = [CGPoint(x: safe.maxX - s, y: safe.minY), CGPoint(x: safe.minX, y: safe.minY),
                         CGPoint(x: safe.maxX - s, y: safe.maxY - s), CGPoint(x: safe.minX, y: safe.maxY - s)]
            if let p = cands.first(where: { c in !canvas.passRects.contains { $0.intersects(CGRect(origin: c, size: CGSize(width: s, height: s))) } }) {
                f.origin = p
            }
        }
        if toggle.frame != f { toggle.frame = f }
        // 收着时：网页这一页本来就没有草稿纸按钮（量不到）、或者它被抽屉、问答面板盖住了，App 的按钮也不出来，免得压在别的东西上。
        // 开着时一直在（要靠它收起）。
        toggle.isHidden = !isOpen && (webBtn.width <= 4 || webBtnCovered)
        toggle.isOn = isOpen
        toggle.accessibilityLabel = isOpen ? labels.close : labels.open
    }

    func hostDidLayout() {
        placeToggle()
        applyMask()
    }

    // MARK: - 网页发来的消息

    /// 每 30 毫秒看一眼最后一笔交到画布没有；交了或等满 300 毫秒，按顺序处理排着的消息。
    /// 等满还没交：记下它属于哪道题，晚到时按那个题号合并存盘（不丢、不串到新题）。
    private func waitStrokeThenDrain() {
        let waited = ProcessInfo.processInfo.systemUptime - pendingSince
        if pendingStroke && waited < 0.3 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in self?.waitStrokeThenDrain() }
            return
        }
        if pendingStroke {
            InkDiag.shared.log("pending stroke not committed after \(Int(waited * 1000))ms, go on; late stroke goes to \(pendingStrokeId ?? "nil")")
            if let pid = pendingStrokeId { lateStroke = (pid, ProcessInfo.processInfo.systemUptime + 3) }
            pendingStroke = false
        }
        deferring = false
        let q = deferQueue
        deferQueue = []
        for b in q { handle(b) }
    }

    /// 收起、进后台前：先等最后一笔交到画布（最多 300 毫秒），再存
    func saveAfterLastStroke(done: (() -> Void)? = nil) {
        if pendingStroke && ProcessInfo.processInfo.systemUptime - pendingSince < 0.3 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in self?.saveAfterLastStroke(done: done) }
            return
        }
        saveNow(done: done)
    }

    func handle(_ body: [String: Any]) {
        MainBeat.time("msg-\(body["k"] as? String ?? "?")") { handleInner(body) }
    }

    private func handleInner(_ body: [String: Any]) {
        guard let k = body["k"] as? String else { return }
        // 正在等最后一笔：这期间来的消息排在后面，按到达顺序处理
        if deferring { deferQueue.append(body); return }
        // 最后一笔还没交到画布上，又要收起或换题：等它（最多 300 毫秒）再处理这条消息，不然存盘会漏掉这一笔
        if k == "state", pendingStroke, ((body["open"] as? Bool) == false || (body["id"] as? String) != id) {
            deferring = true
            deferQueue = [body]
            waitStrokeThenDrain()
            return
        }
        switch k {
        case "state": break
        case "tap":
            // 工具条每点一下：网页收到的时间（网页的毫秒时钟）和 App 收到的时间都记下，点不动时看卡在哪一段
            // 按下 → 网页生效（抬起）→ App 收到：哪一段慢一眼看得出
            // 时间线（墙上时间毫秒）：系统收到触摸开始 / 结束（TouchClock）→ 网页各事件的时间戳和处理时刻 → act() 执行 → App 收到
            let act = (body["t"] as? Double).map { Int64($0) } ?? 0
            let ev = (body["ev"] as? [String]) ?? []
            let lift = TouchClock.lastEnd?.ms ?? 0, down = TouchClock.lastBegin?.ms ?? 0, liftRecv = TouchClock.lastEnd?.recv ?? 0
            let liftToAct = lift > 0 && act > 0 ? act - lift : -1
            // 晚到：抬手那下触摸自己的时间戳 → App 的 sendEvent 收到它；App 侧：收到 → 网页执行这一下
            let late = lift > 0 && liftRecv > 0 ? liftRecv - lift : -1, appSide = liftRecv > 0 && act > 0 ? act - liftRecv : -1
            lastTap = ["a": body["a"] as? String ?? "?", "down": down, "lift": lift, "act": act, "liftToAct": liftToAct, "late": late, "appSide": appSide, "liftRecv": liftRecv, "ev": ev, "recv": InkStore.now()]
            InkDiag.shared.log("toolbar tap \(body["a"] as? String ?? "?") down=\(down) lift=\(lift) act=\(act) lift_to_act=\(liftToAct) late=\(late) app=\(appSide) lift_recv=\(liftRecv) app_recv=\(InkStore.now()) ev=\(ev.joined(separator: " "))")
            return
        case "undo":
            let can = canvas.undoManager?.canUndo ?? false
            canvas.undoManager?.undo()
            InkDiag.shared.log("undo applied (canUndo was \(can)) strokes=\(canvas.drawing.strokes.count)")
            tellUndo()
            return
        case "clear":
            clearAll()
            return
        case "zoomTo":
            // 网页算好的"回到 100%、回到有笔迹的地方"
            if let x = body["x"] as? Double, let y = body["y"] as? Double, let z = body["z"] as? Double, x.isFinite, y.isFinite, z > 0 {
                viewSettled = true; setView(x: CGFloat(x), y: CGFloat(y), z: CGFloat(z)); viewMoved()
                InkDiag.shared.log("zoomTo applied \(Int(x)),\(Int(y)),\(z)")
            }
            return
        case "zoom100":
            let v = view, W = canvas.bounds.width, H = canvas.bounds.height
            if v.z > 0 { let cx = (W / 2 - v.x) / v.z, cy = (H / 2 - v.y) / v.z; viewSettled = true; setView(x: W / 2 - cx, y: H / 2 - cy, z: 1); viewMoved() }
            InkDiag.shared.log("zoom100 applied")
            return
        default:
            InkDiag.shared.log("msg \(k) (ignored)"); return
        }
        let open = (body["open"] as? Bool ?? false) && body["id"] is String
        // 状态消息在挪纸时会很密（里面带着取景窗）：只在开关、题号、纸上面那几层的个数变了时记一行
        let sum = "open=\(open) id=\((body["id"] as? String).map { InkStore.key($0) } ?? "nil") rects=\((body["rects"] as? [Any])?.count ?? 0)"
        if sum != lastStateLog { lastStateLog = sum; InkDiag.shared.log("msg state " + sum) }
        applyTool(tool: body["tool"] as? String, color: body["color"] as? String, finger: body["finger"] as? Bool)
        if let t = body["theme"] as? String, t != theme {
            theme = t
            let style: UIUserInterfaceStyle = t == "day" ? .light : .dark
            canvas.overrideUserInterfaceStyle = style
        }
        if let l = body["labels"] as? [String: Any] {
            labels = (open: l["open"] as? String ?? labels.open, close: l["close"] as? String ?? labels.close)
        }
        if let b = body["btn"] as? [Double], b.count == 4, b.allSatisfy({ $0.isFinite }) {
            webBtn = CGRect(x: b[0], y: b[1], width: b[2], height: b[3])
        }
        webBtnCovered = body["covered"] as? Bool ?? false
        if let rs = body["rects"] as? [[Double]] {
            if rs.count != canvas.passRects.count {
                let sent = (body["ts"] as? Double).map { Int64($0) } ?? 0, recv = InkStore.now()
                lastRects = ["count": rs.count, "sent": sent, "recv": recv]
                if sent > 0 && recv - sent > 100 { InkDiag.shared.log("state with \(rs.count) rects arrived \(recv - sent)ms after the page sent it") }
            }
            canvas.passRects = rs.compactMap { r in
                guard r.count == 4, r.allSatisfy({ $0.isFinite }) else { return nil }
                return CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
            }
            applyMask()
        }

        // 先处理换题：旧题存盘，再换成新题（取景窗：本机存过就用本机的，否则先用网页旧稿的）
        let newId = body["id"] as? String
        if newId != id {
            closeSeq += 1   // 网页回话了，不用兜底收起
            saveNow()
            id = newId
            viewSettled = false
            load()
        }
        if let v = body["view"] as? [String: Any], let x = v["x"] as? Double, let y = v["y"] as? Double, let z = v["z"] as? Double,
           x.isFinite, y.isFinite, z.isFinite, z > 0 {
            if !viewSettled {
                setView(x: CGFloat(x), y: CGFloat(y), z: CGFloat(z))
            } else {
                // 取景窗已由画布定：网页那边的（比如它读完旧稿又按旧稿摆了一次）对不上就再告诉它一遍
                let n = view
                if abs(CGFloat(x) - n.x) > 0.5 || abs(CGFloat(y) - n.y) > 0.5 || abs(CGFloat(z) - n.z) > 0.0005 { tellWebView() }
            }
        }
        if !open { closeSeq += 1 }
        if open != isOpen {
            isOpen = open
            if open { openUI() } else { saveNow(); closeUI() }
        }
        placeToggle()
    }

    // MARK: - 画布、工具盘的显示和收起

    /// PencilKit 的选择交互在手指点纸时会弹系统编辑菜单（选择 / 粘贴），弹之前同步读剪贴板（XPC）、排菜单（r30 抓到的调用栈：
    /// PKSelectionInteraction → UIEditMenuInteraction → UICollectionView / PBServerConnection，主线程卡 0.5–1.6 秒）。草稿纸用不到这个菜单：拿掉。
    private(set) var editMenusRemoved = 0
    private func removeEditMenus() {
        var stack: [UIView] = [canvas]
        while let v = stack.popLast() {
            for i in v.interactions where i is UIEditMenuInteraction { v.removeInteraction(i); editMenusRemoved += 1 }
            stack.append(contentsOf: v.subviews)
        }
    }
    var editMenuCount: Int {
        var n = 0, stack: [UIView] = [canvas]
        while let v = stack.popLast() { n += v.interactions.filter { $0 is UIEditMenuInteraction }.count; stack.append(contentsOf: v.subviews) }
        return n
    }

    /// 工具对象只造一次、存起来，换工具时只是把存好的那个交给画布。
    /// 根因（r35 抓到的调用栈）：每"造"一个 PencilKit 工具（PKInkingTool / PKEraserTool 的初始化）都会去资源目录读它的图标
    /// （PKToolConfiguration → UIImage → CoreUI 资源目录查找），第一次读某个配置的图标很慢（0.5–3.9 秒），以前每次换工具都现造一个。
    private var tools: [String: PKTool] = [:]
    private func cachedTool(_ key: String) -> PKTool {
        if let t = tools[key] { return t }
        let t: PKTool = key == "eraser" ? (ShotVariant.on("vector") ? PKEraserTool(.vector) : PKEraserTool(.bitmap))
            : PKInkingTool(.pen, color: InkLayer.colors[key] ?? InkLayer.defaultInk, width: 2.4)
        tools[key] = t
        return t
    }
    /// 启动时把要用到的工具都造好（笔 4 种颜色 + 位图橡皮），慢的那一下发生在启动、用户还没点的时候
    private func buildTools() {
        let t0 = ProcessInfo.processInfo.systemUptime
        for k in ["eraser"] + Array(InkLayer.colors.keys).sorted() { _ = cachedTool(k) }
        InkDiag.shared.log("tools built \(tools.count) took \(Int((ProcessInfo.processInfo.systemUptime - t0) * 1000))ms")
    }

    /// 预热：给画布换一次位图橡皮再换回来（启动时做一次）
    private var warmed = false
    private(set) var warmInfo: [String: Any] = [:]
    private func warmEraser(_ whereName: String) {
        guard !warmed else { return }
        warmed = true
        let saved = canvas.tool, t0 = ProcessInfo.processInfo.systemUptime
        canvas.tool = cachedTool("eraser")
        canvas.tool = saved
        let ms = Int((ProcessInfo.processInfo.systemUptime - t0) * 1000)
        warmInfo = ["where": whereName, "ms": ms, "strokes": canvas.drawing.strokes.count]
        InkDiag.shared.log("eraser warm at \(whereName) took \(ms)ms strokes=\(canvas.drawing.strokes.count)")
    }

    private func openUI() {
        InkDiag.shared.touchLogging = true
        MainBeat.start()
        removeEditMenus()
        canvas.isHidden = false
        tellWebView()
        tellUndo()
        InkDiag.shared.log("canvas open strokes=\(canvas.drawing.strokes.count) tool=\(InkLayer.toolName(canvas.tool)) policy=\(canvas.drawingPolicy.rawValue)")
    }

    private func closeUI() {
        // 收起：撤销记录清掉（网页那边每次清空记的旧稿也清掉了，两边一一对应）
        canvas.undoManager?.removeAllActions()
        tellUndo()
        let rc = canvas.isFirstResponder ? canvas.resignFirstResponder() : true
        canvas.isHidden = true
        // 画布不当第一响应者（InkCanvas.canBecomeFirstResponder = false），网页一直是，不用再交回去。
        // 以前每写一笔、每次收起都 webView.becomeFirstResponder()：会让 WebKit 重新拉起键盘那一套（r30 抓到的调用栈：UIKeyboardSceneDelegate…，最长卡 7.3 秒）
        let w = webView?.isFirstResponder ?? false
        InkDiag.shared.touchLogging = false
        MainBeat.stop()
        InkDiag.shared.log("canvas closed strokes=\(canvas.drawing.strokes.count) resign canvas=\(rc) web first=\(w)")
    }

    // MARK: - 网页工具条

    /// 工具条的状态（笔 / 橡皮、颜色、手指书写）换成画布的工具和画画规则。只在真变了时换、记日志。
    private func applyTool(tool: String?, color: String?, finger f: Bool?) {
        let t = tool ?? toolName, c = color ?? colorName, fg = f ?? finger
        let policy: PKCanvasViewDrawingPolicy = (testFingerOverride ?? fg) ? .anyInput : .pencilOnly
        if canvas.drawingPolicy != policy {
            canvas.drawingPolicy = policy
            InkDiag.shared.log("drawingPolicy=\(policy == .anyInput ? "anyInput" : "pencilOnly") (finger=\(fg))")
        }
        finger = fg
        guard t != toolName || c != colorName else { return }
        toolName = t; colorName = c
        let t0 = ProcessInfo.processInfo.systemUptime
        if t == "eraser" {
            canvas.tool = cachedTool("eraser")
        } else {
            canvas.tool = cachedTool(c)
        }
        let ms = Int((ProcessInfo.processInfo.systemUptime - t0) * 1000)
        lastToolApply = ["tool": t, "color": c, "wall": TouchClock.wall(ProcessInfo.processInfo.systemUptime), "assignMs": ms]
        InkDiag.shared.log("tool applied \(InkLayer.toolName(canvas.tool)) color=\(c) assign=\(ms)ms wall=\(lastToolApply["wall"] ?? 0)")
    }

    /// 告诉网页：撤销能不能点（工具条的撤销按钮跟着亮 / 灰）。
    /// 告诉网页：撤销能不能点、新笔迹在纸面上的范围（缩放比例按钮"回到有笔迹的地方"用）。
    private func tellUndo() {
        let can = canvas.undoManager?.canUndo ?? false
        let b = canvas.drawing.bounds
        var bounds = "null"
        if !b.isNull && !b.isEmpty && b.minX.isFinite && b.maxX.isFinite {
            let o = InkLayer.origin
            bounds = "[\(b.minX - o),\(b.minY - o),\(b.maxX - o),\(b.maxY - o)]"
        }
        webView?.evaluateJavaScript("window.Kit && Kit.draft && Kit.draft.native && Kit.draft.native.update && Kit.draft.native.update({ undo: \(can), bounds: \(bounds) })", completionHandler: nil)
    }

    /// 清空（工具条第一层的清空，网页已经做过两次确认）：这道题的新笔迹清掉，登记撤销；撤销时新笔迹回来，网页垫底的旧笔迹也放回去。
    private func clearAll() {
        let before = canvas.drawing
        InkDiag.shared.log("clear strokes \(before.strokes.count)->0")
        canvas.undoManager?.registerUndo(withTarget: self) { me in
            me.setDrawing(before, "undo-clear")
            me.changed()
            me.saveNow()   // 撤销清空也马上存（和清空一样，不走防抖）
            me.tellUndo()
            me.webView?.evaluateJavaScript("window.Kit && Kit.draft && Kit.draft.native && Kit.draft.native.unclear && Kit.draft.native.unclear()", completionHandler: nil)
        }
        setDrawing(PKDrawing(), "clear")
        changed()
        saveNow()   // 清空不走 1.2 秒防抖，马上存（清完马上被杀掉也不会回来）
        tellUndo()
    }

    // MARK: - 取景窗

    /// 屏幕 = 纸面 × z + (x, y)；纸面点 P 在画布内容里是 P + origin，所以内容偏移 = origin × z − (x, y)。
    var view: (x: CGFloat, y: CGFloat, z: CGFloat) {
        let z = canvas.zoomScale, o = InkLayer.origin
        return (o * z - canvas.contentOffset.x, o * z - canvas.contentOffset.y, z)
    }

    private func setView(x: CGFloat, y: CGFloat, z: CGFloat) {
        applyingView = true
        let zz = min(max(z, canvas.minimumZoomScale), canvas.maximumZoomScale)
        if abs(canvas.zoomScale - zz) > 1e-9 { canvas.setZoomScale(zz, animated: false) }
        let o = InkLayer.origin
        canvas.contentOffset = CGPoint(x: o * zz - x, y: o * zz - y)
        applyingView = false
        tellWebView()
        applyMask()
    }

    /// 把画布现在的取景窗交给网页（旧 v2 笔迹跟着画）。
    private func tellWebView() {
        let v = view
        guard v.x.isFinite, v.y.isFinite, v.z > 0 else { return }
        InkDiag.shared.view("\(Int(v.x)),\(Int(v.y)),\((v.z * 1000).rounded() / 1000)")
        webView?.evaluateJavaScript("window.Kit && Kit.draft && Kit.draft.native && Kit.draft.native.at({ x: \(v.x), y: \(v.y), z: \(v.z) })", completionHandler: nil)
    }

    /// 转屏、窗口变大小：屏幕中心对着纸面上的同一个点，缩放不变（和网页草稿纸的规矩一样）。
    func keepCenter(from old: CGSize, to new: CGSize) {
        let v = view
        guard v.z > 0, old.width > 0 else { return }
        let cx = (old.width / 2 - v.x) / v.z, cy = (old.height / 2 - v.y) / v.z
        setView(x: new.width / 2 - cx * v.z, y: new.height / 2 - cy * v.z, z: v.z)
    }

    /// 网页"纸上面的那几层"（问答面板、抽屉……）：画布在那里挖空（新字不浮在面板上），触摸也让给网页。
    private func applyMask() {
        // 让出区（洞）先并成一块（重叠处只算一次），再从外框里减掉。只靠环绕方向 + 非零规则时，两个洞重叠处是 +1−1−1=−1，仍会被填上、笔迹露出来
        let outer = CGPath(rect: CGRect(x: -10_000, y: -10_000, width: 40_000, height: 40_000), transform: nil)
        var holes: CGPath?
        for r in canvas.passRects {
            let h = CGPath(roundedRect: r, cornerWidth: min(12, r.width / 2), cornerHeight: min(12, r.height / 2), transform: nil)
            holes = holes.map { $0.union(h) } ?? h
        }
        let path = UIBezierPath(cgPath: holes.map { outer.subtracting($0) } ?? outer)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        // 画布是滚动视图，图层的原点跟着内容偏移走；遮罩放在偏移处，里面的路径就是屏幕坐标。
        maskLayer.frame = CGRect(origin: canvas.contentOffset, size: canvas.bounds.size)
        maskLayer.path = path.cgPath
        CATransaction.commit()
    }

    /// 自检：任意两块让出区重叠处的中心点，遮罩路径里都不算"填充"（是洞，不露笔迹）。没有重叠就是 true
    func maskOverlapOK() -> Bool {
        guard let path = maskLayer.path else { return true }
        let rs = canvas.passRects
        for i in 0..<rs.count { for j in (i + 1)..<max(i + 1, rs.count) {
            let x = rs[i].intersection(rs[j])
            if x.isNull || x.width < 2 || x.height < 2 { continue }
            if path.contains(CGPoint(x: x.midX, y: x.midY), using: .evenOdd) { return false }
        } }
        return true
    }
    /// 有没有两块让出区重叠（测试看"这一步真造出了重叠"）
    var passOverlap: Bool {
        let rs = canvas.passRects
        for i in 0..<rs.count { for j in (i + 1)..<max(i + 1, rs.count) where !rs[i].intersection(rs[j]).isNull && rs[i].intersection(rs[j]).width >= 2 { return true } }
        return false
    }

    /// 最近一次画画手势结束时手指 / 笔在屏幕上的位置（截图模式的状态文件用）
    private var lastTouchEnd = CGPoint(x: -1, y: -1)

    static func toolName(_ t: PKTool) -> String {
        if let e = t as? PKEraserTool { return e.eraserType == .bitmap ? "eraser-bitmap" : "eraser-vector" }
        if let i = t as? PKInkingTool { return "ink-\(i.inkType.rawValue)" }
        if t is PKLassoTool { return "lasso" }
        return String(describing: type(of: t))
    }

    // MARK: - 手势（只记日志）

    @objc private func drawingGesture(_ gr: UIGestureRecognizer) {
        if gr.state == .changed { return }
        let names = [0: "possible", 1: "began", 2: "changed", 3: "ended", 4: "cancelled", 5: "failed"]
        let p = gr.location(in: canvas.superview)
        if gr.state == .began {
            canvas.penDown = true
            // 掌根先压在工具条上、笔后落下：网页工具条上那一下还没抬起的按下作废（不然掌根一抬就算点了一下）
            webView?.evaluateJavaScript("window.Kit && Kit.draft && Kit.draft.native && Kit.draft.native.penDown && Kit.draft.native.penDown()", completionHandler: nil)
        }
        if gr.state == .ended || gr.state == .cancelled || gr.state == .failed { canvas.penDown = false }
        if gr.state == .ended { lastTouchEnd = p; pendingStroke = true; pendingStrokeId = id; pendingSince = ProcessInfo.processInfo.systemUptime }
        // 写完一笔：画布要是拿了第一响应者，交回网页（不然下一下点工具条，网页要先抢回第一响应者，点击会晚到）
        if gr.state == .ended || gr.state == .cancelled, canvas.isFirstResponder {
            let w = webView?.becomeFirstResponder() ?? false
            InkDiag.shared.log("first responder back to web=\(w)")
        }
        InkDiag.shared.log("draw \(names[gr.state.rawValue] ?? "?") at \(InkDiag.pt(p)) tool=\(InkLayer.toolName(canvas.tool)) strokes=\(canvas.drawing.strokes.count)")
    }

    // MARK: - 画布内容

    private func setDrawing(_ d: PKDrawing, _ why: String) {
        InkDiag.shared.log("setDrawing \(why) \(canvas.drawing.strokes.count)->\(d.strokes.count)")
        settingDrawing = true
        MainBeat.time("setDrawing-\(why)") { canvas.drawing = d }
        lastCount = d.strokes.count
        settingDrawing = false
    }

    /// 画布内容变了（写、擦、撤销重做、合并）：一律记脏、过一会儿存。
    private func changed() {
        dirtyDrawing = true
        changedSinceLoad = true
        saveSoon()
    }

    // MARK: - 存、取

    /// 停笔 1.2 秒后存；但脏了 5 秒一定存（一直连着写也存）
    private func saveSoon() {
        let now = ProcessInfo.processInfo.systemUptime
        if firstDirtyAt == 0 { firstDirtyAt = now }
        if now - firstDirtyAt >= 5 { saveNow(); return }
        saveWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.saveNow() }
        saveWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: w)
    }

    /// App 要被杀掉：把存盘队列同步跑完
    func saveNowAndWait() {
        saveNow()
        store.waitIdle()
    }

    /// 立刻存当前这道题（笔迹脏就存笔迹并上传；只是取景窗脏就只更新取景窗）。PKDrawing 是值，拷一份交给后台队列序列化。
    func saveNow(done: (() -> Void)? = nil) {
        saveWork?.cancel(); saveWork = nil
        firstDirtyAt = 0
        guard let id = id, dirtyDrawing || dirtyView else { done?(); return }
        let drawing = dirtyDrawing ? canvas.drawing : nil
        let v = viewForSave()
        dirtyDrawing = false
        dirtyView = false
        if !loaded && drawing != nil { InkDiag.shared.log("save before load finished: merge with disk") }
        store.save(id: id, drawing: drawing, view: v, mergeWithDisk: !loaded) { [weak self] ok in
            if !ok, let self = self, self.id == id {
                // 写盘失败：仍算脏，2 秒后再存（不记 t、不传）
                self.dirtyDrawing = true
                self.saveWork?.cancel()
                let w = DispatchWorkItem { [weak self] in self?.saveNow() }
                self.saveWork = w
                DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: w)
            }
            done?()
        }
    }

    private func viewForSave() -> [String: Double] {
        let v = view
        let W = canvas.bounds.width, H = canvas.bounds.height
        guard v.z > 0, W > 0 else { return [:] }
        let cx = Double((W / 2 - v.x) / v.z), cy = Double((H / 2 - v.y) / v.z)
        guard cx.isFinite, cy.isFinite else { return [:] }
        return ["cx": cx, "cy": cy, "z": Double(v.z)]
    }

    private func load() {
        loadToken += 1
        let token = loadToken
        changedSinceLoad = false
        dirtyDrawing = false
        dirtyView = false
        canvas.undoManager?.removeAllActions()
        tellUndo()
        guard let id = id else { loaded = true; setDrawing(PKDrawing(), "no-question"); return }
        loaded = false
        setDrawing(PKDrawing(), "load-start")
        store.load(id) { [weak self] local in
            guard let self = self, token == self.loadToken else { return }
            self.loaded = true
            if let d = local?.drawing {
                // 读盘的这一小会儿里可能已经写了字：读到的和现在画布上的合并
                if self.changedSinceLoad {
                    self.setDrawing(InkStore.merge(d, self.canvas.drawing), "load-merge")
                    self.dirtyDrawing = true
                    self.saveSoon()
                } else {
                    self.setDrawing(d, "load-local")
                }
            }
            self.canvas.undoManager?.removeAllActions()
            self.tellUndo()
            if let v = local?.view { self.restoreView(v) }
            self.store.pull(id: id) { remote in
                guard token == self.loadToken, let remote = remote else { return }
                if self.changedSinceLoad || self.dirtyDrawing {
                    // 等电脑回话的时候写了字：不整张换，和电脑那份合并
                    self.setDrawing(InkStore.merge(remote, self.canvas.drawing), "pull-merge")
                    self.changed()
                } else {
                    self.setDrawing(remote, "pull-remote")
                    self.canvas.undoManager?.removeAllActions()
                    self.tellUndo()
                }
            }
        }
    }

    /// 本机存过这道题的取景窗（屏幕中心对着的纸面点 + 缩放）：照它摆。
    private func restoreView(_ v: [String: Double]) {
        guard let cx = v["cx"], let cy = v["cy"], let z = v["z"], cx.isFinite, cy.isFinite, z.isFinite, z > 0 else { return }
        let W = canvas.bounds.width, H = canvas.bounds.height
        viewSettled = true
        setView(x: W / 2 - CGFloat(cx) * CGFloat(z), y: H / 2 - CGFloat(cy) * CGFloat(z), z: CGFloat(z))
    }

    /// 截图用：在纸面 (120, 140) 附近写一个"√"和一条横线，看新字和网页旧稿的位置对不对得上。
    func drawSample() {
        guard id != nil else { return }
        var d = canvas.drawing
        d.strokes.append(contentsOf: InkLayer.sampleStrokes())
        setDrawing(d, "sample")
        changed()
    }

    static func sampleStrokes() -> [PKStroke] {
        let o = InkLayer.origin
        let red = UIColor(red: 0xc3 / 255, green: 0x3a / 255, blue: 0x32 / 255, alpha: 1)
        func stroke(_ pts: [CGPoint], _ color: UIColor) -> PKStroke {
            let ps = pts.enumerated().map { i, p in
                PKStrokePoint(location: CGPoint(x: p.x + o, y: p.y + o), timeOffset: Double(i) * 0.01,
                              size: CGSize(width: 3, height: 3), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
            }
            return PKStroke(ink: PKInk(.pen, color: color), path: PKStrokePath(controlPoints: ps, creationDate: Date()))
        }
        var tick: [CGPoint] = []
        for i in 0...20 { let t = CGFloat(i) / 20; tick.append(CGPoint(x: 120 + 40 * t, y: 160 + 40 * t)) }
        for i in 0...30 { let t = CGFloat(i) / 30; tick.append(CGPoint(x: 160 + 90 * t, y: 200 - 110 * t)) }
        var line: [CGPoint] = []
        for i in 0...40 { let t = CGFloat(i) / 40; line.append(CGPoint(x: 120 + 260 * t, y: 240 + 6 * sin(t * 12))) }
        return [stroke(tick, red), stroke(line, defaultInk)]
    }

    /// 连上电脑了：把还没传过去的新笔迹都补传。done(传成功了几份)。
    func syncAll(done: ((Int) -> Void)? = nil) {
        saveNow { [weak self] in self?.store.pushAll(done: done) }
    }

    // MARK: - 截图模式用

    /// testInk 用：只认笔 / 手指也写（模拟器没有笔，系统默认就是手指也写）。
    /// testInk 用：所有题的新笔迹全删（本机文件也删）、取景窗回原点、撤销记录清空。
    func testWipeAll() {
        store.wipeAll()
        setDrawing(PKDrawing(), "test-wipe")
        dirtyDrawing = false; dirtyView = false; saveWork?.cancel(); saveWork = nil
        viewSettled = true; setView(x: 0, y: 0, z: 1)
        canvas.undoManager?.removeAllActions()
        tellUndo()
    }

    /// testInk 用：这道题的新笔迹清零（不登记撤销），每个方向从干净的纸开始。
    func testReset() {
        setDrawing(PKDrawing(), "test-reset")
        changed()
        saveNow()
        canvas.undoManager?.removeAllActions()
        tellUndo()
    }

    func testFinger(_ on: Bool?) {
        testFingerOverride = on
        InkDiag.shared.log("test finger override=\(on.map { String($0) } ?? "off (follow toolbar)")")
        applyTool(tool: nil, color: nil, finger: nil)
    }

    /// 最后一笔是哪种颜色（按网页四种颜色认；认不出给 "other"）
    private func lastStrokeColor() -> String {
        guard let st = canvas.drawing.strokes.last else { return "" }
        func rgb(_ c: UIColor) -> [CGFloat] { var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0; c.getRed(&r, green: &g, blue: &b, alpha: &a); return [r, g, b] }
        let got = rgb(st.ink.color)
        for (k, c) in InkLayer.colors where zip(rgb(c), got).allSatisfy({ abs($0 - $1) < 0.02 }) { return k }
        return "other"
    }

    /// 状态文件用：笔画数、每一笔第一个点和最后一个点在屏幕上的位置、每一笔点数据的指纹、取景窗、工具、按钮位置。
    func debugInfo() -> [String: Any] {
        let o = InkLayer.origin, v = view
        var strokes: [[Double]] = [], prints: [String] = []
        for st in canvas.drawing.strokes {
            let pts = Array(st.path)
            guard let a = pts.first?.location.applying(st.transform), let b = pts.last?.location.applying(st.transform) else { strokes.append([]); prints.append(""); continue }
            func scr(_ p: CGPoint) -> [Double] { [Double((p.x - o) * v.z + v.x), Double((p.y - o) * v.z + v.y)] }
            strokes.append(scr(a) + scr(b))
            // 指纹：每个控制点的位置（取到 0.01）、粗细、时间 + 变换；擦别的笔画以后，没被擦到的这一笔必须一模一样
            var h: UInt64 = 1469598103934665603
            func mix(_ x: Double) { var u = UInt64(bitPattern: Int64((x * 100).rounded())); for _ in 0..<8 { h = (h ^ (u & 0xff)) &* 1099511628211; u >>= 8 } }
            for p in pts { mix(Double(p.location.x)); mix(Double(p.location.y)); mix(Double(p.size.width)); mix(p.timeOffset) }
            let t = st.transform
            for x in [t.a, t.b, t.c, t.d, t.tx, t.ty] { mix(Double(x)) }
            // 位图橡皮擦一笔时可能不改它的点、而是给它加遮罩（mask）：遮罩也算进指纹
            if let m = st.mask { let b = m.bounds; for x in [b.minX, b.minY, b.width, b.height] { mix(Double(x)) } } else { mix(-1) }
            prints.append(String(format: "%016llx-%d", h, pts.count))
        }
        let tf = toggle.frame
        return ["count": canvas.drawing.strokes.count, "strokes": strokes, "prints": prints, "open": isOpen, "id": id ?? NSNull(),
                "view": [Double(v.x), Double(v.y), Double(v.z)], "tool": InkLayer.toolName(canvas.tool),
                "color": colorName, "canUndo": canvas.undoManager?.canUndo ?? false, "lastTap": lastTap, "canvasFR": canvas.isFirstResponder, "editMenus": editMenuCount, "editMenusRemoved": editMenusRemoved, "toolApply": lastToolApply, "lastRects": lastRects, "beat": MainBeat.running, "maskOverlapOK": maskOverlapOK(), "passOverlap": passOverlap, "warm": warmInfo, "variant": ShotVariant.name, "pencilLogged": InkDiag.shared.contains("pencil double tap -> web"), "mainGaps": MainBeat.gaps, "mainSlow": MainBeat.slow, "lastColor": lastStrokeColor(),
                "webBtn": [Double(webBtn.minX), Double(webBtn.minY), Double(webBtn.width), Double(webBtn.height)], "covered": webBtnCovered,
                "passRects": canvas.passRects.map { [Double($0.minX), Double($0.minY), Double($0.width), Double($0.height)] },
                "screen": [Double(host?.bounds.width ?? 0), Double(host?.bounds.height ?? 0)],
                "window": [Double(host?.window?.bounds.width ?? 0), Double(host?.window?.bounds.height ?? 0)],
                "uiscreen": [Double(host?.window?.screen.bounds.width ?? 0), Double(host?.window?.screen.bounds.height ?? 0)],
                "webFrame": webView.map { [Double($0.frame.minX), Double($0.frame.minY), Double($0.frame.width), Double($0.frame.height)] } ?? [],
                "toggle": [Double(tf.minX), Double(tf.minY), Double(tf.width), Double(tf.height)], "toggleHidden": toggle.isHidden,
                "policy": canvas.drawingPolicy == .anyInput ? "anyInput" : (canvas.drawingPolicy == .pencilOnly ? "pencilOnly" : "default"), "lastTouchEnd": [Double(lastTouchEnd.x), Double(lastTouchEnd.y)], "log": InkDiag.shared.tail(30)]
    }

    // MARK: - 自检（只在云端模拟器截图模式下用，题号都是测试用的，不碰真数据）

    /// 清空 / 撤销清空要存盘（第 1 条）、同题两次上传按顺序（第 3 条）、怪字符题号上下对得上（第 23 条）、时间是整数毫秒（第 24 条）。
    /// 1.8：撤销走 PencilKit 的撤销管理器（工具盘上的撤销按钮用的就是它）。
    func selfTest(done: @escaping ([String: Any]) -> Void) {
        var out: [String: Any] = [:]
        // 合并认"同一笔"的键：存盘再读回，和内存里那份合并，笔画数不能变多（第 5 条）
        let sample = PKDrawing(strokes: InkLayer.sampleStrokes())
        if let back = try? PKDrawing(data: sample.dataRepresentation()) {
            out["mergeRoundTrip"] = InkStore.merge(back, sample).strokes.count == sample.strokes.count
                && InkStore.merge(sample, back).strokes.count == sample.strokes.count
            out["creationDateExactAfterRoundTrip"] = zip(back.strokes, sample.strokes).allSatisfy { $0.path.creationDate == $1.path.creationDate }
        }
        store.legacyCheck { info in
            out.merge(info) { a, _ in a }
            self.selfTestRest(out, done: done)
        }
    }

    private func selfTestRest(_ start: [String: Any], done: @escaping ([String: Any]) -> Void) {
        var out = start
        saveNow()
        let saveId = id, saveOpen = isOpen
        let testId = "selftest ink/ä#" + String(InkStore.now())
        // 1) 写两笔 → 存 → 清空（登记撤销）→ 存 → 重新读：应该是 0 笔
        id = testId; isOpen = true
        load()
        setDrawing(PKDrawing(), "selftest")
        drawSample()
        saveNow { [self] in
            let before = self.canvas.drawing
            self.canvas.undoManager?.registerUndo(withTarget: self) { me in me.setDrawing(before, "selftest-undo"); me.changed() }
            self.setDrawing(PKDrawing(), "selftest-clear")
            self.changed()
            self.saveNow {
                self.store.load(testId) { local in
                    out["clearPersisted"] = (local?.drawing.strokes.count ?? -1) == 0
                    // 2) 撤销 → 存 → 重新读：应该回到 2 笔
                    out["undoManager"] = self.canvas.undoManager != nil
                    self.canvas.undoManager?.undo()
                    self.saveNow {
                        self.store.load(testId) { local2 in
                            out["undoPersisted"] = (local2?.drawing.strokes.count ?? -1) == 2
                            // 3) 连着两次改动、两次上传：电脑上最后留的是最新那份（t 和本机一样，整数）
                            self.drawSample()
                            self.saveNow {
                                self.drawSample()
                                self.saveNow {
                                    // 上传要排队（同一道题同一时间只传一份），等它传完：最多等 12 秒，对上了就停
                                    func check(_ left: Int) {
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                            self.store.debugCompare(testId) { info in
                                                if (info["serverMatchesLocal"] as? Bool) != true && left > 0 { check(left - 1); return }
                                                out.merge(info) { a, _ in a }
                                                out["compareTries"] = 6 - left
                                                self.id = saveId; self.isOpen = saveOpen
                                                self.load()
                                                done(out)
                                            }
                                        }
                                    }
                                    check(5)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

extension InkLayer: PKCanvasViewDelegate {
    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        guard !settingDrawing else { return }
        let n = canvasView.drawing.strokes.count
        if let late = lateStroke {
            if ProcessInfo.processInfo.systemUptime > late.until { lateStroke = nil }
            else if late.id != id, n > lastCount {
                // 换题后才交到画布的那一笔：从这道题拿掉，合并进它原来那道题存盘
                lateStroke = nil
                let all = canvasView.drawing.strokes
                let extra = Array(all.suffix(n - lastCount))
                setDrawing(PKDrawing(strokes: Array(all.prefix(lastCount))), "late-stroke-moved")
                store.save(id: late.id, drawing: PKDrawing(strokes: extra), view: [:], mergeWithDisk: true)
                InkDiag.shared.log("late stroke(s) \(extra.count) saved to \(late.id), not to \(id ?? "nil")")
                tellUndo()
                return
            } else if late.id == id { lateStroke = nil }
        }
        // 抬笔（draw ended）到这一笔交到画布上的间隔，写进日志好量
        let gap = pendingStroke ? " after_draw_end_ms=\(Int((ProcessInfo.processInfo.systemUptime - pendingSince) * 1000))" : ""
        pendingStroke = false
        InkDiag.shared.log("strokes \(lastCount)->\(n) tool=\(InkLayer.toolName(canvasView.tool))" + gap)
        lastCount = n
        tellUndo()
        guard id != nil else { return }
        changed()
    }

    func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
        InkDiag.shared.log("tool begin \(InkLayer.toolName(canvasView.tool))")
    }

    func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        InkDiag.shared.log("tool end \(InkLayer.toolName(canvasView.tool)) strokes=\(canvasView.drawing.strokes.count)")
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        applyMask()
        guard !applyingView else { return }
        tellWebView()
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        applyMask()
        guard !applyingView else { return }
        tellWebView()
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        viewSettled = true
        InkDiag.shared.log("pan begin touches=\(scrollView.panGestureRecognizer.numberOfTouches)")
    }

    func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
        viewSettled = true
        InkDiag.shared.log("zoom begin z=\((scrollView.zoomScale * 1000).rounded() / 1000)")
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { viewMoved() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { viewMoved() }

    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) { viewMoved() }

    /// 用户挪完 / 缩放完：这道题的取景窗由 App 定了，过一会儿存。
    func viewMoved() {
        let v = view
        InkDiag.shared.log("view settled x=\(Int(v.x)) y=\(Int(v.y)) z=\((v.z * 1000).rounded() / 1000)")
        guard id != nil else { return }
        viewSettled = true
        dirtyView = true
        saveSoon()
    }
}

/// 画布：网页"纸上面的那几层"（工具条和它的小弹层、问答面板、抽屉、提示条……）那几块不接触摸，让给下面的网页。
final class InkCanvas: PKCanvasView {
    var passRects: [CGRect] = []
    /// 不当第一响应者：画笔不需要它（只有工具盘、编辑菜单要）；当了就会和网页来回抢，每抢一次 WebKit 要重新拉起键盘那一套
    override var canBecomeFirstResponder: Bool { false }
    /// 笔正按在纸上写（画画手势开始到结束）：这段时间里落在让出区（工具条等）的手指不给网页，当掌根；笔一抬立刻恢复
    var penDown = false
    private var lastLogged: TimeInterval = -1
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard super.point(inside: point, with: event) else { return false }
        // point 是画布（滚动视图）自己的坐标：减掉内容偏移才是屏幕上的位置
        let p = CGPoint(x: point.x - contentOffset.x, y: point.y - contentOffset.y)
        guard let r = passRects.first(where: { $0.contains(p) }) else { return true }
        // 掌根：这次刚按下的触摸全是手指，而且同一事件里另有一支正在动或停着的笔（笔正按在纸上写）。
        // 笔自己点工具条时，按下的那下是笔，结构上不会被拦；不看 penDown 的时序
        if let ts = event?.allTouches {
            let began = ts.filter { $0.phase == .began }
            if !began.isEmpty, began.allSatisfy({ $0.type == .direct }),
               ts.contains(where: { $0.type == .pencil && ($0.phase == .moved || $0.phase == .stationary) }) {
                return true   // 留在画布上（只认笔时手指在画布上什么都不做）
            }
        }
        if let e = event, e.timestamp != lastLogged {   // 同一下触摸只记一次
            lastLogged = e.timestamp
            InkDiag.shared.log("pass to web at \(InkDiag.pt(p)) rect=\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width)),\(Int(r.height))")
        }
        return false
    }
}

/// 草稿纸开关按钮（原生，盖在画布上，一直点得到）：样子照网页 .ic（46×46 圆角 12、1.9 粗的描边图标），
/// 浮在内容上所以有底色和细边；打开时用强调色（网页按钮打开时的样子）。图标是网页草稿纸按钮的那支笔，读屏的字用网页 ui.json 里现成的。
final class DraftToggle: PressButton {
    private let shape = CAShapeLayer()
    var isOn = false { didSet { if oldValue != isOn { setNeedsLayout() } } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "b2draftToggle"
        layer.cornerRadius = 12
        layer.cornerCurve = .continuous
        layer.borderWidth = 1
        shape.fillColor = UIColor.clear.cgColor
        shape.lineWidth = 1.9
        shape.lineCap = .round
        shape.lineJoin = .round
        layer.addSublayer(shape)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let s: CGFloat = 24, o = CGPoint(x: (bounds.width - s) / 2, y: (bounds.height - s) / 2)
        // 网页 ICO.btn：M4 20l1.2-4.6L15.6 5a2.1 2.1 0 0 1 3 3L8.2 18.4z M13.8 6.8l3 3 M13 20h7
        let p = UIBezierPath()
        p.move(to: CGPoint(x: 4, y: 20)); p.addLine(to: CGPoint(x: 5.2, y: 15.4)); p.addLine(to: CGPoint(x: 15.6, y: 5))
        p.addArc(withCenter: CGPoint(x: 17.1, y: 6.5), radius: 2.12, startAngle: -.pi * 3 / 4, endAngle: .pi / 4, clockwise: true)
        p.addLine(to: CGPoint(x: 8.2, y: 18.4)); p.close()
        p.move(to: CGPoint(x: 13.8, y: 6.8)); p.addLine(to: CGPoint(x: 16.8, y: 9.8))
        p.move(to: CGPoint(x: 13, y: 20)); p.addLine(to: CGPoint(x: 20, y: 20))
        p.apply(CGAffineTransform(translationX: o.x, y: o.y))
        shape.frame = bounds
        shape.path = p.cgPath
        let tc = traitCollection
        shape.strokeColor = (isOn ? Theme.accent : (isHighlighted ? Theme.text : Theme.secondaryText)).resolvedColor(with: tc).cgColor
        backgroundColor = (isOn ? Theme.accentSoft : (isHighlighted ? Theme.surface2 : Theme.surface)).resolvedColor(with: tc)
        layer.borderColor = (isOn ? Theme.accent : Theme.line).resolvedColor(with: tc).cgColor
    }

    override var isHighlighted: Bool { didSet { setNeedsLayout() } }
    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        setNeedsLayout()
    }
}

// MARK: - 新笔迹的存取

/// iPad 上：Application Support/ink/<键>.drawing（PencilKit 格式）+ <键>.json（{id, t, base, dirty, view}）。
/// t 是这份最后改的时间（整数毫秒），base 是上次和电脑对上时电脑那份的 t，dirty 表示有改动还没传到电脑。
/// 电脑上：POST /draft {id: "pk_<键>", doc: {v: "pk1", t, view, pages: [], data: base64}} → data/draft/pk_<键>.json。
/// 所有读写都在一个后台串行队列上，回调回主线程。同一道题同一时间只有一个上传在路上，后来的改动等它回来再传。
/// 对时规则（只有这台 iPad 写 pk_ 文件）：
/// - 本机没改动、电脑那份比本机认识的新（t 更大）：用电脑的。
/// - 电脑那份没变过（t == base）或不比本机新（t ≤ 本机 t）：以本机为准，不合并（合并会把本机擦掉的笔画捡回来）；本机有改动就传。
/// - 电脑那份比本机的还新、本机又有没传的改动（重装、换机这类情况）：合并（电脑那份 + 本机多出来的笔画），再传上去。
final class InkStore {
    struct Local { var drawing: PKDrawing; var view: [String: Double]? }

    private let fm = FileManager.default
    private let dir: URL
    private let q = DispatchQueue(label: "board2.ink.store")
    /// 正在上传的键 → 传完还要不要再传一次（这期间又改过）
    private var inflight: [String: Bool] = [:]
    /// 上传失败后重试了几次（成功、再存一次就清零）
    private var retries: [String: Int] = [:]

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("ink", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    /// 题号 → 键：只留电脑 server.py 认的字符（A–Z a–z 0–9 _ -），开头必须是字母数字；太长（>36）截断加 8 位校验码。
    /// 本机文件名、电脑上的 pk_<键> 都用它，上传、下载、补传对得上。
    static func key(_ id: String) -> String {
        var k = String(id.unicodeScalars.map { s -> Character in
            (s.isASCII && (CharacterSet.alphanumerics.contains(s) || s == "-" || s == "_")) ? Character(s) : "_"
        })
        if k.isEmpty || k.first == "_" || k.first == "-" { k = "q" + k }
        if k.count > 36 || k != id {
            // 变过样的加校验码，免得两道不同的题变成同一个键
            var h: UInt32 = 2166136261
            for b in id.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
            k = String(k.prefix(27)) + "_" + String(format: "%08x", h)
        }
        return k
    }

    private func drawingURL(_ k: String) -> URL { dir.appendingPathComponent(k + ".drawing") }
    private func metaURL(_ k: String) -> URL { dir.appendingPathComponent(k + ".json") }

    /// 测试用：本机存的新笔迹全删
    func wipeAll() {
        q.sync {
            for f in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] { try? fm.removeItem(at: f) }
        }
    }

    /// 等存盘队列里的活都做完（App 要被杀掉时用）
    func waitIdle() { q.sync {} }

    private func meta(_ k: String) -> [String: Any] {
        guard let d = try? Data(contentsOf: metaURL(k)), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return o
    }
    private func setMeta(_ k: String, _ m: [String: Any]) {
        if let d = try? JSONSerialization.data(withJSONObject: m) { try? d.write(to: metaURL(k), options: .atomic) }
    }
    /// 兼容老数据：t / base 以前是带小数的毫秒（Double），一律取整成 Int64。
    private static func ms(_ v: Any?) -> Int64? {
        if let n = v as? NSNumber { return Int64(n.doubleValue.rounded()) }
        return nil
    }
    static func now() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

    private func main(_ f: @escaping () -> Void) { DispatchQueue.main.async(execute: f) }

    func load(_ id: String, done: @escaping (Local?) -> Void) {
        let k = InkStore.key(id)
        q.async {
            var out: Local?
            if let d = try? Data(contentsOf: self.drawingURL(k)), let drawing = try? PKDrawing(data: d) {
                out = Local(drawing: drawing, view: self.meta(k)["view"] as? [String: Double])
            }
            self.main { done(out) }
        }
    }

    /// drawing 为 nil：只更新取景窗，不动笔迹、不上传。mergeWithDisk：这道题还没读完盘就要存，先和盘上那份合并（不覆盖原笔迹）。
    /// done(写盘成功没有)
    func save(id: String, drawing: PKDrawing?, view: [String: Double], mergeWithDisk: Bool = false, done: ((Bool) -> Void)? = nil) {
        let k = InkStore.key(id)
        q.async {
            var m = self.meta(k)
            m["id"] = id
            if !view.isEmpty && !mergeWithDisk { m["view"] = view }
            if var drawing = drawing {
                if mergeWithDisk, let d = try? Data(contentsOf: self.drawingURL(k)), let old = try? PKDrawing(data: d) {
                    drawing = InkStore.merge(old, drawing)
                }
                do {
                    try drawing.dataRepresentation().write(to: self.drawingURL(k), options: .atomic)
                    m["t"] = NSNumber(value: InkStore.now())
                    m["dirty"] = true
                } catch {
                    // 写盘失败：不记新的 t、dirty（不然下次对时会以为本机有一份新的）
                    InkDiag.shared.log("ink write failed \(k): \(error.localizedDescription)")
                    self.setMeta(k, m)
                    self.main { done?(false) }
                    return
                }
            }
            self.setMeta(k, m)
            if drawing != nil { self.retries[k] = 0; self.pushLocked(k, done: nil) }
            self.main { done?(true) }
        }
    }

    private static func serverURL(_ path: String) -> URL? {
        guard let base = ServerSettings.url else { return nil }
        return URL(string: path, relativeTo: base)
    }

    /// 在队列上调用。同一个键同一时间只有一个上传；正在传就记下"传完再传一次"。
    private func pushLocked(_ k: String, done: ((Bool) -> Void)?) {
        if inflight[k] != nil { inflight[k] = true; done?(false); return }
        let m = meta(k)
        guard (m["dirty"] as? Bool) == true, let t = InkStore.ms(m["t"]),
              let data = try? Data(contentsOf: drawingURL(k)), let url = InkStore.serverURL("draft") else { done?(false); return }
        guard (try? PKDrawing(data: data)) != nil else {   // 本机文件坏了：不传（传上去会把电脑那份好的盖掉）
            InkDiag.shared.log("ink push skipped \(k): local .drawing unreadable")
            done?(false); return
        }
        let doc: [String: Any] = ["v": "pk1", "t": NSNumber(value: t), "pages": [], "view": m["view"] ?? NSNull(),
                                  "id": m["id"] ?? k, "data": data.base64EncodedString()]
        guard let body = try? JSONSerialization.data(withJSONObject: ["id": "pk_" + k, "doc": doc]) else { done?(false); return }
        inflight[k] = false
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.httpBody = body
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.timeoutInterval = 15
        URLSession.shared.dataTask(with: r) { _, resp, _ in
            self.q.async {
                let ok = (resp as? HTTPURLResponse)?.statusCode == 200
                if ok {
                    var m2 = self.meta(k)
                    if InkStore.ms(m2["t"]) == t {   // 传的过程中没再改过
                        m2["dirty"] = false
                    }
                    m2["base"] = NSNumber(value: t)
                    self.setMeta(k, m2)
                }
                let again = self.inflight[k] == true
                self.inflight[k] = nil
                if ok { self.retries[k] = 0 }
                if again {
                    self.pushLocked(k, done: nil)   // 传的过程中又改过：再传一次（这次失败了也照样传最新的）
                } else if !ok {
                    // 失败：过一会儿重传（5、10、15… 秒，最多 12 次；连上电脑时 syncAll 也会再传）
                    let n = (self.retries[k] ?? 0) + 1
                    self.retries[k] = n
                    if n <= 12 { self.q.asyncAfter(deadline: .now() + Double(min(60, 5 * n))) { self.pushLocked(k, done: nil) } }
                }
                done?(ok)
            }
        }.resume()
    }

    /// 把所有没传上去的都补传。done(传成功了几份)，主线程回调。
    func pushAll(done: ((Int) -> Void)? = nil) {
        q.async {
            let files = (try? self.fm.contentsOfDirectory(at: self.dir, includingPropertiesForKeys: nil)) ?? []
            let keys = files.filter { $0.pathExtension == "json" }.map { $0.deletingPathExtension().lastPathComponent }
                .filter { (self.meta($0)["dirty"] as? Bool) == true }
            guard !keys.isEmpty else { self.main { done?(0) }; return }
            var left = keys.count, ok = 0
            for k in keys {
                self.pushLocked(k) { good in
                    if good { ok += 1 }
                    left -= 1
                    if left == 0 { let n = ok; self.main { done?(n) } }
                }
            }
        }
    }

    /// 打开一道题时去电脑上看一眼。需要用电脑那份（或合并后的）时回调新的画（主线程），不需要时回调 nil。
    func pull(id: String, done: @escaping (PKDrawing?) -> Void) {
        let k = InkStore.key(id)
        guard var comps = InkStore.serverURL("draft").flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: true) }) else { done(nil); return }
        comps.queryItems = [URLQueryItem(name: "id", value: "pk_" + k), URLQueryItem(name: "t", value: String(InkStore.now()))]
        guard let url = comps.url else { done(nil); return }
        var r = URLRequest(url: url)
        r.timeoutInterval = 4
        URLSession.shared.dataTask(with: r) { data, resp, _ in
            self.q.async {
                let finish: (PKDrawing?) -> Void = { d in self.main { done(d) } }
                guard (resp as? HTTPURLResponse)?.statusCode == 200, let data = data,
                      let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { finish(nil); return }
                var m = self.meta(k)
                // 本机 .drawing 读不出来（坏了、没了）但 .json 里还记着 t：当作本机没有这道题，别用这个 t 把电脑那份挡掉
                let localOK = (try? Data(contentsOf: self.drawingURL(k))).flatMap { try? PKDrawing(data: $0) } != nil
                let localDirty = localOK && (m["dirty"] as? Bool) == true
                let base = localOK ? InkStore.ms(m["base"]) : nil
                let localT = localOK ? InkStore.ms(m["t"]) : nil
                guard let doc = o["doc"] as? [String: Any], let st = InkStore.ms(doc["t"]),
                      let b64 = doc["data"] as? String, let bin = Data(base64Encoded: b64),
                      let remote = try? PKDrawing(data: bin) else {
                    // 电脑上还没有：有本机的就传上去
                    if localT != nil { m["dirty"] = true; self.setMeta(k, m); self.pushLocked(k, done: nil) }
                    finish(nil); return
                }
                if st == base || (localT != nil && st <= localT!) {
                    // 电脑那份没变过、或者不比本机新：pk_ 只有这台 iPad 在写，以本机为准，不合并（合并会把本机擦掉的笔画从电脑那份里捡回来）。
                    // 本机有改动就传。
                    if localDirty { self.pushLocked(k, done: nil) }
                    finish(nil); return
                }
                if !localDirty {
                    // 电脑上的比本机认识的新（重装过 App、本机没这道题）：用电脑的
                    guard localT == nil || st > localT! else { finish(nil); return }
                    try? bin.write(to: self.drawingURL(k), options: .atomic)
                    m["id"] = id; m["t"] = NSNumber(value: st); m["base"] = NSNumber(value: st); m["dirty"] = false
                    if let v = doc["view"] as? [String: Double] { m["view"] = v }
                    self.setMeta(k, m)
                    finish(remote); return
                }
                // 电脑那份比本机的还新、本机又有没传的改动（只会在重装、换机这类情况出现）：合并，谁的都不丢
                let local = (try? Data(contentsOf: self.drawingURL(k))).flatMap { try? PKDrawing(data: $0) } ?? PKDrawing()
                let merged = InkStore.merge(remote, local)
                try? merged.dataRepresentation().write(to: self.drawingURL(k), options: .atomic)
                m["t"] = NSNumber(value: InkStore.now()); m["dirty"] = true
                self.setMeta(k, m)
                self.pushLocked(k, done: nil)
                finish(merged)
            }
        }.resume()
    }

    /// 电脑那份为底，加上本机有而电脑没有的笔画（按笔画的创建时间、点数、第一个点认同一笔）。
    /// 创建时间取到毫秒：PencilKit 存盘再读回来后时间的小数尾巴不一定一模一样，取全精度会把同一笔认成两笔（自检 mergeRoundTrip 查这个）。
    static func strokeKey(_ s: PKStroke) -> String {
        let p = s.path.first?.location ?? .zero
        return "\(Int64((s.path.creationDate.timeIntervalSince1970 * 1000).rounded()))-\(s.path.count)-\(Int(p.x.rounded()))-\(Int(p.y.rounded()))"
    }

    static func merge(_ a: PKDrawing, _ b: PKDrawing) -> PKDrawing {
        let key = strokeKey
        let have = Set(a.strokes.map(key))
        var out = a
        out.strokes.append(contentsOf: b.strokes.filter { !have.contains(key($0)) })
        return out
    }

    /// 自检用（第 h 条）：1.3–1.7 存在 iPad 上的旧笔迹（.drawing + .json）1.8 能不能原样读出来。
    /// 有示例页带的样本（ci/fixture/legacy/，由 1.6 起没变过的存盘代码生成）就用它；没有就按 1.6 的写法现场写一份，
    /// 并把样本写到 Mac 上（legacy-ink-sample.*），下一轮放进示例页。读出来后比笔画数和每一笔每个控制点的坐标。
    func legacyCheck(done: @escaping ([String: Any]) -> Void) {
        func fetch(_ path: String, _ cb: @escaping (Data?) -> Void) {
            guard let url = InkStore.serverURL(path) else { cb(nil); return }
            URLSession.shared.dataTask(with: url) { d, r, _ in cb((r as? HTTPURLResponse)?.statusCode == 200 ? d : nil) }.resume()
        }
        fetch("legacy/ink-sample.drawing") { bin in
            fetch("legacy/ink-sample.json") { js in
                self.q.async {
                    var out: [String: Any] = [:]
                    var data = bin, metaData = js
                    var expect: [[[Double]]] = []
                    if let mj = js.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }), let e = mj["expect"] as? [[[Double]]], bin != nil {
                        expect = e
                        out["legacySource"] = "fixture"
                    } else {
                        // 按 1.6（715b56b）InkStore.save 的写法：PKDrawing.dataRepresentation() 原样写盘，旁边的 .json 是 {id, t, dirty, view}
                        let o = InkLayer.origin
                        var strokes: [PKStroke] = []
                        for i in 0..<3 {
                            var pts: [PKStrokePoint] = []
                            for j in 0..<6 {
                                let x: CGFloat = o + 100 + CGFloat(j) * 40
                                let y: CGFloat = o + 120 + CGFloat(i) * 60 + CGFloat(j) * 3
                                let t: TimeInterval = Double(j) * 0.02
                                pts.append(PKStrokePoint(location: CGPoint(x: x, y: y), timeOffset: t, size: CGSize(width: 2.4, height: 2.4),
                                                         opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2))
                            }
                            strokes.append(PKStroke(ink: PKInk(.pen, color: .black), path: PKStrokePath(controlPoints: pts, creationDate: Date(timeIntervalSince1970: 1_790_000_000 + Double(i)))))
                        }
                        let d = PKDrawing(strokes: strokes)
                        expect = d.strokes.map { st in Array(st.path).map { [Double($0.location.x), Double($0.location.y)] } }
                        data = d.dataRepresentation()
                        let meta: [String: Any] = ["id": "legacy sample", "t": NSNumber(value: Int64(1_790_000_000_000)), "dirty": false,
                                                   "view": ["cx": 300.0, "cy": 300.0, "z": 1.0], "expect": expect]
                        metaData = try? JSONSerialization.data(withJSONObject: meta, options: [.sortedKeys])
                        out["legacySource"] = "generated"
                        if let dir = ShotMode.hostOut {
                            try? data?.write(to: dir.appendingPathComponent("legacy-ink-sample.drawing"))
                            try? metaData?.write(to: dir.appendingPathComponent("legacy-ink-sample.json"))
                        }
                    }
                    let k = InkStore.key("legacy sample")
                    try? data?.write(to: self.drawingURL(k), options: .atomic)
                    try? metaData?.write(to: self.metaURL(k), options: .atomic)
                    self.main {
                        self.load("legacy sample") { local in
                            let got = local?.drawing.strokes.map { st in Array(st.path).map { [Double($0.location.x), Double($0.location.y)] } } ?? []
                            var same = got.count == expect.count
                            if same {
                                for (a, b) in zip(got, expect) where a.count != b.count || zip(a, b).contains(where: { abs($0[0] - $1[0]) > 1e-6 || abs($0[1] - $1[1]) > 1e-6 }) { same = false }
                            }
                            out["legacyStrokes"] = got.count
                            out["legacyReadSame"] = same
                            out["legacyView"] = local?.view != nil
                            self.q.async {
                                try? self.fm.removeItem(at: self.drawingURL(k)); try? self.fm.removeItem(at: self.metaURL(k))
                                self.main { done(out) }
                            }
                        }
                    }
                }
            }
        }
    }

    /// 自检用：本机这份和电脑那份的 t、笔画数对不对得上。
    func debugCompare(_ id: String, done: @escaping ([String: Any]) -> Void) {
        let k = InkStore.key(id)
        q.async {
            let m = self.meta(k)
            let local = (try? Data(contentsOf: self.drawingURL(k))).flatMap { try? PKDrawing(data: $0) }
            var out: [String: Any] = ["inkKey": k, "localT": m["t"] ?? NSNull(), "localDirty": m["dirty"] ?? NSNull(),
                                      "localStrokes": local?.strokes.count ?? -1,
                                      "tIsInteger": (m["t"] as? NSNumber).map { $0.doubleValue == $0.doubleValue.rounded() } ?? false]
            guard let url = InkStore.serverURL("draft?id=pk_" + k) else { self.main { done(out) }; return }
            URLSession.shared.dataTask(with: url) { data, _, _ in
                let o = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                let doc = o?["doc"] as? [String: Any]
                out["serverT"] = doc?["t"] ?? NSNull()
                let rs = (doc?["data"] as? String).flatMap { Data(base64Encoded: $0) }.flatMap { try? PKDrawing(data: $0) }
                out["serverStrokes"] = rs?.strokes.count ?? -1
                out["serverMatchesLocal"] = InkStore.ms(doc?["t"]) != nil && InkStore.ms(doc?["t"]) == InkStore.ms(m["t"])
                self.main { done(out) }
            }.resume()
        }
    }
}
