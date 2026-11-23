import UIKit

/// 笔迹诊断日志：真机上草稿纸写不了字时，不用再让人描述，直接读电脑上的日志。
/// 记的是一行一行的短记录（时间 + 事件），不记题目内容：画画手势开始/结束/取消（带位置、工具）、工具盘换工具、
/// 笔画数的变化、画布开关、挪纸缩放、网页发来的状态（开关、题号变了才记）、画布被整张换掉的原因。
/// 攒在内存里（最多 3000 行），每 8 秒、App 进后台时 POST 到电脑的 /inklog（server.py 落到 data/inklog/ink.log，限大小、轮换）；
/// 电脑连不上或者还是没这个接口的旧 server.py：留着下次再发，满了丢最旧的。
/// 云端模拟器截图模式下同时写到 Mac 上的 <名字>.ink.log，测试失败时能直接看。
final class InkDiag {
    static let shared = InkDiag()

    private var lines: [String] = []
    private var sending = false
    private var timer: Timer?
    private let fmt: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()
    /// 同一种高频事件（取景窗变化）只记个数，攒到下一条别的事件前一起写一行。
    private var viewCount = 0
    private var lastView = ""
    let session = String(format: "%04x", UInt16.random(in: 0...0xffff))

    private init() {
        timer = Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in self?.flush() }
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.log("app background"); self?.flush()
        }
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        log("start app=\(v)(\(b)) ios=\(UIDevice.current.systemVersion) model=\(UIDevice.current.model) shot=\(ShotMode.scene ?? "-")")
    }

    /// 取景窗：只计数，最后一个值留着。
    func view(_ s: String) {
        viewCount += 1
        lastView = s
    }

    func log(_ s: String) {
        if Thread.isMainThread { append(s) } else { DispatchQueue.main.async { self.append(s) } }
    }

    private func append(_ s: String) {
        let t = fmt.string(from: Date())
        if viewCount > 0 {
            push("\(t) view x\(viewCount) last=\(lastView)")
            viewCount = 0
        }
        push("\(t) \(s)")
    }

    private func push(_ line: String) {
        lines.append(line)
        if lines.count > 3000 { lines.removeFirst(lines.count - 3000) }
        if ShotMode.isOn { ShotMode.hostWrite(".ink.log", line, append: true) }
    }

    /// 最近几行（截图模式的状态文件用）。
    func tail(_ n: Int) -> [String] { Array(lines.suffix(n)) }

    func flush() {
        guard !sending, !lines.isEmpty, !ShotMode.isOn || ShotMode.server != nil,
              let base = ServerSettings.url, let url = URL(string: "inklog", relativeTo: base) else { return }
        let batch = Array(lines.prefix(400))
        let body: [String: Any] = ["s": session, "lines": batch]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.httpBody = data
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.timeoutInterval = 6
        sending = true
        URLSession.shared.dataTask(with: r) { _, resp, _ in
            DispatchQueue.main.async {
                self.sending = false
                guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return }
                // 发出去的那几行删掉（这期间新来的留着；满了被挤掉的部分按实际剩下的算）
                let n = min(batch.count, self.lines.count)
                if n > 0, Array(self.lines.prefix(n)) == Array(batch.prefix(n)) { self.lines.removeFirst(n) }
                if !self.lines.isEmpty { self.flush() }
            }
        }.resume()
    }

    static func pt(_ p: CGPoint) -> String { "\(Int(p.x.rounded())),\(Int(p.y.rounded()))" }
}
