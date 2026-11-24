import UIKit
import ObjectiveC

/// 触摸时间线（诊断用，只旁听）：在 UIApplication.sendEvent 上记每一下触摸的开始、结束时刻（换算成墙上时间毫秒），
/// 不改触摸去向、不加手势识别器。草稿纸开着（或云端截图模式）时才记。
/// 用来和网页那边工具条事件的时间对齐，分清"触摸结束晚到 WebKit"、"WebKit 晚派发"、"网页主线程忙"。
enum TouchClock {
    /// 最近一下结束的触摸：墙上时间毫秒、落点、落在哪个视图上
    /// ms：触摸自己的时间戳；recv：App 的 UIApplication.sendEvent 收到它的时刻（都是墙上毫秒）
    private(set) static var lastEnd: (ms: Int64, x: Int, y: Int, view: String, recv: Int64)?
    private(set) static var lastBegin: (ms: Int64, x: Int, y: Int, view: String, recv: Int64)?
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
        let recv = Int64((Date().timeIntervalSince1970 * 1000).rounded())   // sendEvent 收到这一下的时刻
        let rec = (ms, Int(p.x.rounded()), Int(p.y.rounded()), v, recv)
        switch t.phase {
        case .began:
            lastBegin = rec
            downAt[ObjectIdentifier(t)] = (ms, p)
            if downAt.count > 40 { downAt.removeAll() }
            InkDiag.shared.log("touch began \(kind) t=\(ms) recv=\(recv) at \(rec.1),\(rec.2) view=\(v)")
        case .moved:
            if let d = downAt.removeValue(forKey: ObjectIdentifier(t)) {
                InkDiag.shared.log("touch first move \(kind) +\(ms - d.0)ms after down, moved \(Int(hypot(p.x - d.1.x, p.y - d.1.y)))pt at \(rec.1),\(rec.2)")
            }
        case .ended, .cancelled:
            downAt.removeValue(forKey: ObjectIdentifier(t))
            lastEnd = rec
            InkDiag.shared.log("touch \(t.phase == .ended ? "ended" : "cancelled") \(kind) t=\(ms) recv=\(recv) at \(rec.1),\(rec.2) view=\(v)")
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
        StallSampler.startIfNeeded()
        let t = Timer(timeInterval: 0.05, repeats: true) { _ in
            let now = ProcessInfo.processInfo.systemUptime
            let gap = now - last
            if gap > 0.25, InkDiag.shared.touchLogging || ShotMode.isOn {
                let rec = "\(TouchClock.wall(last))+\(Int(gap * 1000))(after \(doing))"
                gaps.append(rec); if gaps.count > 12 { gaps.removeFirst() }
                InkDiag.shared.log("main thread blocked \(rec)")
                StallSampler.takeAsync(TouchClock.wall(last))
            }
            last = now
            StallSampler.tick()
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

/// 诊断（只在云端截图 / 测试模式）：主线程卡住时它在干什么。
/// 后台一条线程每 50 毫秒看一眼主线程的打拍（MainBeat 每拍更新）；超过 400 毫秒没打拍，就给主线程发一个信号，
/// 信号处理里只做 backtrace()（取当时的调用栈地址），主线程缓过来后由 MainBeat 把符号化的调用栈记进笔迹日志（"stall stack …"）。
/// 用来分清卡顿是 PencilKit、XCUITest 查元素（无障碍查询）、写文件还是别的。真机上不开。
private let stallFrames = UnsafeMutablePointer<UnsafeMutableRawPointer?>.allocate(capacity: 64)
private var stallFrameCount: Int32 = 0
enum StallSampler {
    private static var mainThread: pthread_t?
    private static var lastTick = DispatchTime.now().uptimeNanoseconds
    private static var sampled = false
    private static var started = false

    static func startIfNeeded() {
        guard ShotMode.isOn, !started else { return }
        started = true
        mainThread = pthread_self()
        signal(SIGUSR2) { _ in stallFrameCount = backtrace(stallFrames, 64) }
        let th = Thread {
            while true {
                Thread.sleep(forTimeInterval: 0.05)
                guard MainBeat.running || MainWatch.active, let m = mainThread else { continue }
                let idle = DispatchTime.now().uptimeNanoseconds &- lastTick
                if idle > 400_000_000 && !sampled { sampled = true; pthread_kill(m, SIGUSR2) }
            }
        }
        th.name = "b2-stall-sampler"
        th.qualityOfService = .userInteractive
        th.start()
    }

    /// 主线程每拍调一次
    static func tick() { lastTick = DispatchTime.now().uptimeNanoseconds; sampled = false }

    /// 取走这次卡顿时抓到的调用栈：地址先拷出来，符号化在后台线程做完再记日志（不占主线程）
    static func takeAsync(_ at: Int64) {
        let n = Int(stallFrameCount)
        guard n > 0 else { return }
        stallFrameCount = 0
        let copy = UnsafeMutablePointer<UnsafeMutableRawPointer?>.allocate(capacity: n)
        copy.update(from: stallFrames, count: n)
        DispatchQueue.global(qos: .utility).async {
            if let st = symbolize(copy, n) { InkDiag.shared.log("stall stack \(at): " + st) }
            copy.deallocate()
        }
    }
    private static func symbolize(_ frames: UnsafeMutablePointer<UnsafeMutableRawPointer?>, _ n: Int) -> String? {
        guard let syms = backtrace_symbols(frames, Int32(n)) else { return nil }
        var out: [String] = []
        for i in 0..<n {
            guard let c = syms[i] else { continue }
            // 一行：序号 模块 地址 符号 + 偏移；只留模块和符号
            let parts = String(cString: c).split(separator: " ", omittingEmptySubsequences: true)
            if parts.count >= 4 { out.append("\(parts[1]):\(parts[3...].prefix(1).joined())") } else { out.append(String(cString: c)) }
        }
        free(syms)
        return out.prefix(40).joined(separator: " | ")
    }
}

/// 主线程存活看门狗（只在云端测试模式；从启动起一直跑，不看草稿纸开没开）：
/// 后台线程每 50 毫秒往主线程丢一个任务，记下主线程真正执行它的时刻（墙上毫秒），每秒追加写到 <名字>.beats.log。
/// 用来判断"触摸晚送到 App"的那段时间里 App 主线程是不是活着（相邻两次执行间隔大，就是主线程自己卡了）。
enum MainWatch {
    private static let lock = NSLock()
    private static var buf: [Int64] = []
    private static var started = false
    static var active: Bool { started }
    private static var lastRun: Int64 = 0
    static func start() {
        guard ShotMode.isOn, !started else { return }
        started = true
        StallSampler.startIfNeeded()
        let th = Thread {
            var n = 0
            while true {
                Thread.sleep(forTimeInterval: 0.05)
                DispatchQueue.main.async {
                    let t = Int64((Date().timeIntervalSince1970 * 1000).rounded())
                    lock.lock(); buf.append(t); lock.unlock()
                    StallSampler.tick()
                    if lastRun > 0 && t - lastRun > 250 { StallSampler.takeAsync(lastRun) }   // 刚缓过来：把卡着时抓到的调用栈记下来
                    lastRun = t
                }
                n += 1
                if n % 20 == 0 {
                    lock.lock(); let out = buf; buf.removeAll(keepingCapacity: true); lock.unlock()
                    if !out.isEmpty { ShotMode.hostWrite(".beats.log", out.map(String.init).joined(separator: "\n"), append: true) }
                }
            }
        }
        th.name = "b2-main-watch"
        th.qualityOfService = .userInteractive
        th.start()
    }
}
