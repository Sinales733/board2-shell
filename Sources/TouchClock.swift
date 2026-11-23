import UIKit
import ObjectiveC

/// 触摸时间线（诊断用，只旁听）：在 UIApplication.sendEvent 上记每一下触摸的开始、结束时刻（换算成墙上时间毫秒），
/// 不改触摸去向、不加手势识别器。草稿纸开着（或云端截图模式）时才记。
/// 用来和网页那边工具条事件的时间对齐，分清"触摸结束晚到 WebKit"、"WebKit 晚派发"、"网页主线程忙"。
enum TouchClock {
    /// 最近一下结束的触摸：墙上时间毫秒、落点、落在哪个视图上
    private(set) static var lastEnd: (ms: Int64, x: Int, y: Int, view: String)?
    private(set) static var lastBegin: (ms: Int64, x: Int, y: Int, view: String)?

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
            InkDiag.shared.log("touch began \(kind) t=\(ms) at \(rec.1),\(rec.2) view=\(v)")
        case .ended, .cancelled:
            lastEnd = rec
            InkDiag.shared.log("touch \(t.phase == .ended ? "ended" : "cancelled") \(kind) t=\(ms) at \(rec.1),\(rec.2) view=\(v)")
        default:
            break
        }
    }
}

extension UIApplication {
    @objc func b2_sendEvent(_ e: UIEvent) {
        if e.type == .touches, InkDiag.shared.touchLogging || ShotMode.isOn, let ts = e.allTouches {
            for t in ts where t.phase == .began || t.phase == .ended || t.phase == .cancelled { TouchClock.record(t) }
        }
        b2_sendEvent(e)   // 换过实现：这里调的是系统原来的 sendEvent
    }
}

/// 云端测试用的变体开关（-b2var a,b,…；平时为空，什么都不变）。用来并排比"写完字后第一下点工具条慢"的几种可能原因。
enum ShotVariant {
    static let set: Set<String> = Set((UserDefaults.standard.string(forKey: "b2var") ?? "").split(separator: ",").map(String.init))
    static func on(_ k: String) -> Bool { set.contains(k) }
}
