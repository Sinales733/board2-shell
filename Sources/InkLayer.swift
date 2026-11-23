import UIKit
import PencilKit
import WebKit

/// 原生笔迹草稿纸（1.8 起按"备忘录"的方式正规使用 PencilKit）。
/// - 草稿纸打开时，PKCanvasView 是盖在网页上面的普通视图，自己接触摸：笔写字，手指挪纸、双指缩放（画布本身就是滚动视图）；
///   写字、橡皮、撤销重做、防手掌全是 PencilKit 自带的。工具用苹果的 PKToolPicker（笔、橡皮、颜色、粗细、撤销重做、"用手指绘图"）。
///   画画方式跟系统走（drawingPolicy = .default：配过 Pencil 的 iPad 默认只认笔，工具盘里打开"用手指绘图"后手指也写）。
/// - 打开时手指不穿透到下面的题（要点下面先收起草稿纸）；只有网页"纸上面的那几层"（问答面板、抽屉等）和提示条让出来给网页。
/// - 开关：App 自己的按钮（DraftToggle），盖在网页草稿纸按钮原来的位置上，一直点得到。开关状态仍以网页为准（网页 Kit.draft.open/close）。
/// - 网页 kit/draft.js（v9 起）在 App 里只负责：纸、旧 v2 笔迹只读垫底、题号和开关告诉 App；不碰任何触摸。
///   取景窗由画布定，每次滚动缩放把 {x, y, z}（屏幕 = 纸面 × z + (x, y)）交给网页（Kit.draft.native.at），旧稿跟着画。
/// - 新笔迹存 PencilKit 自己的格式：iPad 上 Application Support/ink/<键>.drawing（+ 每题的取景窗），
///   连得上电脑时另存一份到电脑的 data/draft/pk_<键>.json（走原来的 POST /draft，不覆盖 <题号>.json）。1.3–1.7 存的照常读。
/// 存盘：画布每次变（写、擦、撤销重做、合并进电脑那份）记"笔迹脏"，挪纸缩放停下记"取景窗脏"，1.2 秒防抖后存；换题、收起、进后台立刻存。
final class InkLayer: NSObject {

    /// 纸面坐标 (0, 0) 在画布内容里的位置。画布 10 万点见方，纸面坐标往四个方向都能写到 ±5 万。
    static let origin: CGFloat = 50_000
    static let contentSide: CGFloat = 100_000

    let canvas = InkCanvas()
    let toggle = DraftToggle()
    private let toolPicker = PKToolPicker()
    private weak var host: UIView?
    private weak var webView: WKWebView?
    private let store = InkStore()

    private var isOpen = false
    private var id: String?
    private var theme = "night"
    private var labels = (open: "", close: "")
    private var webBtn = CGRect.zero
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

    /// 在页面最开头告诉网页：这里有原生笔迹，draft.js 据此不显示自己的工具条、不碰触摸。
    static let flagScript = "window.B2Native = Object.assign(window.B2Native || {}, { ink: true, v: 4 });"

    /// 打开草稿纸时的默认笔（墨色，和网页草稿纸的"墨"一样，白天那一套；夜间 PencilKit 自己换算）。
    private static let defaultInk = UIColor(red: 0x1f / 255, green: 0x1d / 255, blue: 0x1a / 255, alpha: 1)

    /// 开关按钮被点：让网页开 / 关（网页再把状态发回来，画布跟着显示 / 隐藏）。
    var onToggle: ((Bool) -> Void)?

    init(host: UIView, webView: WKWebView) {
        self.host = host
        self.webView = webView
        super.init()

        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.isHidden = true
        canvas.drawingPolicy = .default
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
        maskLayer.fillRule = .evenOdd
        canvas.layer.mask = maskLayer
        canvas.drawingGestureRecognizer.addTarget(self, action: #selector(drawingGesture(_:)))

        toolPicker.addObserver(canvas)
        toolPicker.addObserver(self)
        toolPicker.selectedTool = canvas.tool
        toolPicker.colorUserInterfaceStyle = .dark

        toggle.isHidden = true
        toggle.addTarget(self, action: #selector(togglePressed), for: .touchUpInside)
        host.insertSubview(toggle, aboveSubview: canvas)
        placeToggle()
    }

    // MARK: - 开关按钮

    @objc private func togglePressed() {
        Haptics.tap()
        InkDiag.shared.log("toggle tap open=\(isOpen)")
        onToggle?(!isOpen)
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
        if toggle.frame != f { toggle.frame = f }
        toggle.isOn = isOpen
        toggle.accessibilityLabel = isOpen ? labels.close : labels.open
    }

    func hostDidLayout() {
        placeToggle()
        applyMask()
    }

    // MARK: - 网页发来的消息

    func handle(_ body: [String: Any]) {
        guard let k = body["k"] as? String else { return }
        guard k == "state" else { InkDiag.shared.log("msg \(k) (ignored)"); return }
        let open = (body["open"] as? Bool ?? false) && body["id"] is String
        // 状态消息在挪纸时会很密（里面带着取景窗）：只在开关、题号、纸上面那几层的个数变了时记一行
        let sum = "open=\(open) id=\((body["id"] as? String).map { InkStore.key($0) } ?? "nil") rects=\((body["rects"] as? [Any])?.count ?? 0)"
        if sum != lastStateLog { lastStateLog = sum; InkDiag.shared.log("msg state " + sum) }
        if let t = body["theme"] as? String, t != theme {
            theme = t
            let style: UIUserInterfaceStyle = t == "day" ? .light : .dark
            canvas.overrideUserInterfaceStyle = style
            toolPicker.colorUserInterfaceStyle = style
        }
        if let l = body["labels"] as? [String: Any] {
            labels = (open: l["open"] as? String ?? labels.open, close: l["close"] as? String ?? labels.close)
        }
        if let b = body["btn"] as? [Double], b.count == 4, b.allSatisfy({ $0.isFinite }) {
            webBtn = CGRect(x: b[0], y: b[1], width: b[2], height: b[3])
        }
        if let rs = body["rects"] as? [[Double]] {
            canvas.passRects = rs.compactMap { r in
                guard r.count == 4, r.allSatisfy({ $0.isFinite }) else { return nil }
                return CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
            }
            applyMask()
        }
        toggle.isHidden = false

        // 先处理换题：旧题存盘，再换成新题（取景窗：本机存过就用本机的，否则先用网页旧稿的）
        let newId = body["id"] as? String
        if newId != id {
            saveNow()
            id = newId
            viewSettled = false
            load()
        }
        if !viewSettled, let v = body["view"] as? [String: Any], let x = v["x"] as? Double, let y = v["y"] as? Double, let z = v["z"] as? Double,
           x.isFinite, y.isFinite, z.isFinite, z > 0 {
            setView(x: CGFloat(x), y: CGFloat(y), z: CGFloat(z))
        }
        if open != isOpen {
            isOpen = open
            canvas.isHidden = !open
            if open {
                canvas.becomeFirstResponder()
                toolPicker.setVisible(true, forFirstResponder: canvas)
                tellWebView()
            } else {
                toolPicker.setVisible(false, forFirstResponder: canvas)
                canvas.resignFirstResponder()
                saveNow()
            }
            InkDiag.shared.log("canvas \(open ? "open" : "closed") strokes=\(canvas.drawing.strokes.count) picker=\(toolPicker.isVisible)")
        }
        placeToggle()
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
        let path = UIBezierPath(rect: CGRect(x: -10_000, y: -10_000, width: 40_000, height: 40_000))
        for r in canvas.passRects { path.append(UIBezierPath(roundedRect: r, cornerRadius: 12)) }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        // 画布是滚动视图，图层的原点跟着内容偏移走；遮罩放在偏移处，里面的路径就是屏幕坐标。
        maskLayer.frame = CGRect(origin: canvas.contentOffset, size: canvas.bounds.size)
        maskLayer.path = path.cgPath
        CATransaction.commit()
    }

    // MARK: - Pencil 双击

    /// 草稿纸开着：笔 ⇄ 橡皮（PencilKit 的工具盘自己记着上一支笔）；返回 false 表示草稿纸没开，交给网页（网页会打开草稿纸）。
    func pencilDoubleTap() -> Bool {
        guard isOpen else { return false }
        if canvas.tool is PKEraserTool {
            let ink = lastInk ?? PKInkingTool(.pen, color: InkLayer.defaultInk, width: 2.4)
            toolPicker.selectedTool = ink
            canvas.tool = ink
        } else {
            if let t = canvas.tool as? PKInkingTool { lastInk = t }
            toolPicker.selectedTool = PKEraserTool(.vector)
            canvas.tool = PKEraserTool(.vector)
        }
        InkDiag.shared.log("pencil double tap -> \(InkLayer.toolName(canvas.tool))")
        return true
    }
    private var lastInk: PKInkingTool?

    static func toolName(_ t: PKTool) -> String {
        if let e = t as? PKEraserTool { return e.eraserType == .bitmap ? "eraser-bitmap" : "eraser-vector" }
        if let i = t as? PKInkingTool { return "ink-\(i.inkType.rawValue)" }
        if t is PKLassoTool { return "lasso" }
        return String(describing: type(of: t))
    }

    // MARK: - 手势（只记日志）

    @objc private func drawingGesture(_ gr: UIGestureRecognizer) {
        let names = [0: "possible", 1: "began", 2: "changed", 3: "ended", 4: "cancelled", 5: "failed"]
        if gr.state == .changed { return }
        let p = gr.location(in: canvas.superview)
        InkDiag.shared.log("draw \(names[gr.state.rawValue] ?? "?") at \(InkDiag.pt(p)) tool=\(InkLayer.toolName(canvas.tool)) strokes=\(canvas.drawing.strokes.count)")
    }

    // MARK: - 画布内容

    private func setDrawing(_ d: PKDrawing, _ why: String) {
        InkDiag.shared.log("setDrawing \(why) \(canvas.drawing.strokes.count)->\(d.strokes.count)")
        settingDrawing = true
        canvas.drawing = d
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

    private func saveSoon() {
        saveWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.saveNow() }
        saveWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: w)
    }

    /// 立刻存当前这道题（笔迹脏就存笔迹并上传；只是取景窗脏就只更新取景窗）。PKDrawing 是值，拷一份交给后台队列序列化。
    func saveNow(done: (() -> Void)? = nil) {
        saveWork?.cancel(); saveWork = nil
        guard let id = id, dirtyDrawing || dirtyView else { done?(); return }
        let drawing = dirtyDrawing ? canvas.drawing : nil
        let v = viewForSave()
        dirtyDrawing = false
        dirtyView = false
        store.save(id: id, drawing: drawing, view: v, done: done)
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
        guard let id = id else { setDrawing(PKDrawing(), "no-question"); return }
        setDrawing(PKDrawing(), "load-start")
        store.load(id) { [weak self] local in
            guard let self = self, token == self.loadToken else { return }
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
    func testFinger(_ on: Bool) {
        canvas.drawingPolicy = on ? .anyInput : .pencilOnly
        InkDiag.shared.log("test drawingPolicy=\(on ? "anyInput" : "pencilOnly")")
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
            prints.append(String(format: "%016llx-%d", h, pts.count))
        }
        let tf = toggle.frame
        return ["count": canvas.drawing.strokes.count, "strokes": strokes, "prints": prints, "open": isOpen, "id": id ?? NSNull(),
                "view": [Double(v.x), Double(v.y), Double(v.z)], "tool": InkLayer.toolName(canvas.tool),
                "picker": toolPicker.isVisible, "firstResponder": canvas.isFirstResponder,
                "toggle": [Double(tf.minX), Double(tf.minY), Double(tf.width), Double(tf.height)], "toggleHidden": toggle.isHidden,
                "policy": canvas.drawingPolicy.rawValue, "log": InkDiag.shared.tail(30)]
    }

    // MARK: - 自检（只在云端模拟器截图模式下用，题号都是测试用的，不碰真数据）

    /// 清空 / 撤销清空要存盘（第 1 条）、同题两次上传按顺序（第 3 条）、怪字符题号上下对得上（第 23 条）、时间是整数毫秒（第 24 条）。
    /// 1.8：撤销走 PencilKit 的撤销管理器（工具盘上的撤销按钮用的就是它）。
    func selfTest(done: @escaping ([String: Any]) -> Void) {
        var out: [String: Any] = [:]
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
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                        self.store.debugCompare(testId) { info in
                                            out.merge(info) { a, _ in a }
                                            self.id = saveId; self.isOpen = saveOpen
                                            self.load()
                                            done(out)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

extension InkLayer: PKCanvasViewDelegate, PKToolPickerObserver {
    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        guard !settingDrawing else { return }
        let n = canvasView.drawing.strokes.count
        InkDiag.shared.log("strokes \(lastCount)->\(n) tool=\(InkLayer.toolName(canvasView.tool))")
        lastCount = n
        guard id != nil else { return }
        changed()
    }

    func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
        InkDiag.shared.log("tool begin \(InkLayer.toolName(canvasView.tool))")
    }

    func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        InkDiag.shared.log("tool end \(InkLayer.toolName(canvasView.tool)) strokes=\(canvasView.drawing.strokes.count)")
    }

    func toolPickerSelectedToolDidChange(_ toolPicker: PKToolPicker) {
        InkDiag.shared.log("picker tool -> \(InkLayer.toolName(toolPicker.selectedTool))")
    }

    func toolPickerVisibilityDidChange(_ toolPicker: PKToolPicker) {
        InkDiag.shared.log("picker visible=\(toolPicker.isVisible)")
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
    private func viewMoved() {
        let v = view
        InkDiag.shared.log("view settled x=\(Int(v.x)) y=\(Int(v.y)) z=\((v.z * 1000).rounded() / 1000)")
        guard id != nil else { return }
        viewSettled = true
        dirtyView = true
        saveSoon()
    }
}

/// 画布：网页"纸上面的那几层"（问答面板、抽屉、提示条……）那几块不接触摸，让给下面的网页。
final class InkCanvas: PKCanvasView {
    var passRects: [CGRect] = []
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard super.point(inside: point, with: event) else { return false }
        // point 是画布（滚动视图）自己的坐标：减掉内容偏移才是屏幕上的位置
        let p = CGPoint(x: point.x - contentOffset.x, y: point.y - contentOffset.y)
        return !passRects.contains { $0.contains(p) }
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
/// - 本机有改动、电脑那份没变过（t == base）：传本机的。
/// - 两边都变了：合并（电脑那份 + 本机多出来的笔画），两边的都不丢，再传上去。
final class InkStore {
    struct Local { var drawing: PKDrawing; var view: [String: Double]? }

    private let fm = FileManager.default
    private let dir: URL
    private let q = DispatchQueue(label: "board2.ink.store")
    /// 正在上传的键 → 传完还要不要再传一次（这期间又改过）
    private var inflight: [String: Bool] = [:]

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

    /// drawing 为 nil：只更新取景窗，不动笔迹、不上传。
    func save(id: String, drawing: PKDrawing?, view: [String: Double], done: (() -> Void)? = nil) {
        let k = InkStore.key(id)
        q.async {
            var m = self.meta(k)
            m["id"] = id
            if !view.isEmpty { m["view"] = view }
            if let drawing = drawing {
                try? drawing.dataRepresentation().write(to: self.drawingURL(k), options: .atomic)
                m["t"] = NSNumber(value: InkStore.now())
                m["dirty"] = true
            }
            self.setMeta(k, m)
            if drawing != nil { self.pushLocked(k, done: nil) }
            self.main { done?() }
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
                if again && ok { self.pushLocked(k, done: nil) }
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
                let localDirty = (m["dirty"] as? Bool) == true
                let base = InkStore.ms(m["base"])
                let localT = InkStore.ms(m["t"])
                guard let doc = o["doc"] as? [String: Any], let st = InkStore.ms(doc["t"]),
                      let b64 = doc["data"] as? String, let bin = Data(base64Encoded: b64),
                      let remote = try? PKDrawing(data: bin) else {
                    // 电脑上还没有：有本机的就传上去
                    if localT != nil { m["dirty"] = true; self.setMeta(k, m); self.pushLocked(k, done: nil) }
                    finish(nil); return
                }
                if st == base || (localT != nil && st <= localT! && !localDirty) {
                    // 电脑那份没变过（或者不比本机新）：本机有改动就传
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
                // 两边都变了：合并，谁的都不丢（画布那边还会再和屏幕上现有的合并一次）
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
    static func merge(_ a: PKDrawing, _ b: PKDrawing) -> PKDrawing {
        func key(_ s: PKStroke) -> String {
            let p = s.path.first?.location ?? .zero
            return "\(s.path.creationDate.timeIntervalSince1970)-\(s.path.count)-\(Int(p.x))-\(Int(p.y))"
        }
        let have = Set(a.strokes.map(key))
        var out = a
        out.strokes.append(contentsOf: b.strokes.filter { !have.contains(key($0)) })
        return out
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
