import UIKit
import ObjectiveC

/// 触摸时间线（诊断用，只旁听）：在 UIApplication.sendEvent 上记每一下触摸的开始、结束时刻（换算成墙上时间毫秒），
/// 不改触摸去向、不加手势识别器。草稿纸开着（或云端截图模式）时才记。
/// 用来和网页那边工具条事件的时间对齐，分清"触摸结束晚到 WebKit"、"WebKit 晚派发"、"网页主线程忙"。
enum TouchClock {
    /// 最近一下结束的触摸：墙上时间毫秒、落点、落在哪个视图上
    private(set) static var lastEnd: (ms: Int64, x: Int, y: Int, view: String)?
    private(set) static var lastBegin: (ms: Int64, x: Int, y: Int, view: String)?
    /// 系统发来的、阶段是"取消"的触摸，开机以来一共几下（云端测试要求是 0）
    private(set) static var cancelled = 0
    /// 每个手势识别器上次记下的状态：只在它进入 began / ended（认出来了）/ cancelled / failed 时记一行
    private static var grState: [ObjectIdentifier: Int] = [:]
    /// 按下时刻（墙上毫秒），记第一次移动用；记过第一次移动的就删掉
    private static var downAt: [ObjectIdentifier: (Int64, CGPoint)] = [:]

    static func install() {
        let c: AnyClass = UIApplication.self
        guard let m1 = class_getInstanceMethod(c, #selector(UIApplication.sendEvent(_:))),
              let m2 = class_getInstanceMethod(c, #selector(UIApplication.b2_sendEvent(_:))) else { return }
        method_exchangeImplementations(m1, m2)
    }

    /// 触摸自带的时间戳（开机以来秒）换算成墙上时间毫秒
    static func wall(_ t: TimeInterval) -> Int64 {
        Int64(((Date().timeIntervalSince1970 - (ProcessInfo.processInfo.systemUptime - t)) * 1000).rounded())
    }

    fileprivate static func record(_ t: UITouch) {
        let p = t.location(in: nil)
        let v = t.view.map { String(describing: type(of: $0)) } ?? "nil"
        let ms = wall(t.timestamp)
        let kind = t.type == .pencil ? "pencil" : (t.type == .direct ? "finger" : "other")
        let rec = (ms, Int(p.x.rounded()), Int(p.y.rounded()), v)
        switch t.phase {
        case .began:
            lastBegin = rec
            downAt[ObjectIdentifier(t)] = (ms, p)
            if downAt.count > 40 { downAt.removeAll() }
            InkDiag.shared.log("touch began \(kind) t=\(ms) at \(rec.1),\(rec.2) view=\(v)")
        case .moved:
            if let d = downAt.removeValue(forKey: ObjectIdentifier(t)) {
                InkDiag.shared.log("touch first move \(kind) +\(ms - d.0)ms after down, moved \(Int(hypot(p.x - d.1.x, p.y - d.1.y)))pt at \(rec.1),\(rec.2)")
            }
        case .ended, .cancelled:
            downAt.removeValue(forKey: ObjectIdentifier(t))
            lastEnd = rec
            InkDiag.shared.log("touch \(t.phase == .ended ? "ended" : "cancelled") \(kind) t=\(ms) at \(rec.1),\(rec.2) view=\(v)")
            if t.phase == .cancelled {
                cancelled += 1
                let line = "native touch cancelled #\(cancelled) \(kind) t=\(ms) at \(rec.1),\(rec.2) view=\(v) grs=[\(grs(t))]"
                InkDiag.shared.log(line)
                if ShotMode.isOn { ShotMode.hostWrite(".cancel.log", line, append: true) }
            }
        default:
            break
        }
    }
}

extension TouchClock {
    fileprivate static func stateName(_ s: UIGestureRecognizer.State) -> String {
        switch s {
        case .possible: return "possible"
        case .began: return "began"
        case .changed: return "changed"
        case .ended: return "ended"
        case .cancelled: return "cancelled"
        case .failed: return "failed"
        @unknown default: return "?"
        }
    }
    /// 这下触摸上挂着的手势识别器（类名、挂在哪个视图上、状态）
    fileprivate static func grs(_ t: UITouch) -> String {
        (t.gestureRecognizers ?? []).map { g in
            "\(type(of: g))@\(g.view.map { String(describing: type(of: $0)) } ?? "nil"):\(stateName(g.state))"
        }.joined(separator: ",")
    }
    /// 分发完这批触摸以后：手势识别器有进入 began / ended / cancelled 的就记一行（谁认出了手势、谁会把触摸从视图手里拿走）
    fileprivate static func afterDispatch(_ ts: Set<UITouch>) {
        var seen = Set<ObjectIdentifier>()
        for t in ts {
            for g in t.gestureRecognizers ?? [] {
                let id = ObjectIdentifier(g)
                if seen.contains(id) { continue }
                seen.insert(id)
                let s = g.state.rawValue
                if grState[id] != s {
                    grState[id] = s
                    if g.state == .began || g.state == .ended || g.state == .cancelled {
                        InkDiag.shared.log("gesture \(type(of: g))@\(g.view.map { String(describing: type(of: $0)) } ?? "nil") -> \(stateName(g.state)) cancelsTouchesInView=\(g.cancelsTouchesInView)")
                    }
                }
            }
            if t.phase == .began { InkDiag.shared.log("touch grs at began: [\(grs(t))]") }
        }
        if grState.count > 400 { grState.removeAll() }
    }
}

extension UIApplication {
    @objc func b2_sendEvent(_ e: UIEvent) {
        let on = e.type == .touches && (InkDiag.shared.touchLogging || ShotMode.isOn)
        let ts = on ? (e.allTouches ?? []) : []
        for t in ts where t.phase == .began || t.phase == .moved || t.phase == .ended || t.phase == .cancelled { TouchClock.record(t) }
        b2_sendEvent(e)   // 换过实现：这里调的是系统原来的 sendEvent
        if on { TouchClock.afterDispatch(ts) }
    }
}

/// 云端诊断用的变体开关（启动参数 -b2var 名字；平时为空，什么都不变）
enum ShotVariant {
    static let name: String = UserDefaults.standard.string(forKey: "b2var") ?? ""
    static func on(_ k: String) -> Bool { name == k }
}

/// 诊断：App 主线程有没有被卡住——每 50 毫秒打一次拍，两拍之间超过 250 毫秒就记"从几点起卡了多久、卡之前最后在做什么"。
/// 另外几处可能慢的活（整张换画布、遮罩、状态消息、状态探针写文件）超过 30 毫秒记一笔。草稿纸开着或截图模式下才记。
enum MainBeat {
    private static var last = ProcessInfo.processInfo.systemUptime
    private static var timer: Timer?
    static var doing = "-"
    private(set) static var gaps: [String] = []
    private(set) static var slow: [String] = []

    static func stop() { timer?.invalidate(); timer = nil }
    static var running: Bool { timer != nil }

    static func start() {
        guard timer == nil else { return }
        last = ProcessInfo.processInfo.systemUptime
        let t = Timer(timeInterval: 0.05, repeats: true) { _ in
            let now = ProcessInfo.processInfo.systemUptime
            let gap = now - last
            if gap > 0.25, InkDiag.shared.touchLogging || ShotMode.isOn {
                let rec = "\(TouchClock.wall(last))+\(Int(gap * 1000))(after \(doing))"
                gaps.append(rec); if gaps.count > 12 { gaps.removeFirst() }
                InkDiag.shared.log("main thread blocked \(rec)")
            }
            last = now
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    /// 量一段活用了多久（超过 30 毫秒记下来）
    @discardableResult
    static func time<T>(_ name: String, _ f: () -> T) -> T {
        let prev = doing; doing = name
        let t0 = ProcessInfo.processInfo.systemUptime
        let r = f()
        let d = ProcessInfo.processInfo.systemUptime - t0
        doing = prev
        if d > 0.03 {
            let rec = "\(name)@\(TouchClock.wall(t0))+\(Int(d * 1000))"
            slow.append(rec); if slow.count > 12 { slow.removeFirst() }
            InkDiag.shared.log("slow \(rec)")
        }
        return r
    }
}
