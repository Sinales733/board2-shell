import UIKit

/// 云端模拟器截图、自检用的开关，全从启动参数读（xcrun simctl launch ... -b2shot main）。
/// 平时装在 iPad 上不会带这些参数，所以一样都不生效。
enum ShotMode {
    private static let d = UserDefaults.standard

    /// 要拍的画面：main / settings / draft / offline / noconn / selftest；空 = 平时。
    static var scene: String? { d.string(forKey: "b2shot") }
    static var isOn: Bool { scene != nil }
    /// 临时的服务器地址（不存）。
    static var server: String? { d.string(forKey: "b2server") }
    /// landscape / portrait
    static var orient: String? { d.string(forKey: "b2orient") }
    /// day / night：网页和原生界面都用这一套
    static var theme: String? { d.string(forKey: "b2theme") }
    /// 打开哪道题、停在第几步
    static var question: String? { d.string(forKey: "b2q") }
    static var step: String? { d.string(forKey: "b2at") }
    /// 不读不写 iPad 上存的内容（拍"连不上"那一张时用）
    static var noCache: Bool { d.bool(forKey: "b2nocache") }

    /// 自检结果、"可以拍了"的记号，写在 App 的 Documents 里，CI 用 simctl get_app_container 去读。
    static var docs: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }

    static func mark(_ name: String, _ obj: Any = ["ok": true]) {
        let url = docs.appendingPathComponent(name)
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: url, options: .atomic)
        }
    }

    /// UI 测试给的 Mac 上的输出目录和这一张的名字（模拟器里的 App 能直接写 Mac 的文件）。
    /// 页面加载着的时候 UI 测试读不到 App 里的标签（一直在等 App 空闲），所以就绪和自检结果改用文件传。
    static var hostOut: URL? {
        guard let p = ProcessInfo.processInfo.environment["B2_OUT"], !p.isEmpty else { return nil }
        return URL(fileURLWithPath: p, isDirectory: true)
    }
    static var shotName: String { ProcessInfo.processInfo.environment["B2_NAME"] ?? (scene ?? "shot") }

    static func hostWrite(_ suffix: String, _ text: String, append: Bool = false) {
        guard let dir = hostOut else { return }
        let url = dir.appendingPathComponent(shotName + suffix)
        if append, let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile(); h.write(Data((text + "\n").utf8)); try? h.close()
        } else {
            try? (text + (append ? "\n" : "")).write(to: url, atomically: true, encoding: .utf8)
        }
    }

    static func clearMarks() {
        for n in ["ready.json", "selftest.json"] {
            try? FileManager.default.removeItem(at: docs.appendingPathComponent(n))
        }
    }

    /// 页面地址上要加的参数（网页自带的截图参数：id、at、theme、still）。
    static var pageQuery: [URLQueryItem] {
        guard isOn else { return [] }
        var q: [URLQueryItem] = []
        if let id = question { q.append(URLQueryItem(name: "id", value: id)) }
        if let at = step { q.append(URLQueryItem(name: "at", value: at)) }
        if let t = theme { q.append(URLQueryItem(name: "theme", value: t)) }
        q.append(URLQueryItem(name: "still", value: "1"))
        return q
    }
}
