import UIKit
import WebKit

enum ServerSettings {
    /// 示例地址（仓库里不写死某一台电脑的地址）。第一次打开连不上时，连不上页 / 设置页里填自己电脑的地址，存在本机。
    static let defaultAddress = "http://192.168.1.10:8409/"
    private static let key = "serverAddress"

    static var address: String {
        get {
            if let shot = ShotMode.server { return shot }
            let saved = UserDefaults.standard.string(forKey: key)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return saved.isEmpty ? defaultAddress : saved
        }
        set {
            UserDefaults.standard.set(normalize(newValue), forKey: key)
        }
    }

    static var url: URL? {
        return URL(string: normalize(address))
    }

    /// 没写 http:// 就补上；去掉首尾空白。
    static func normalize(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return defaultAddress }
        let lower = s.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            s = "http://" + s
        }
        return s
    }

    /// 1.8 以前默认地址写死在 App 里，没手动改过地址的 iPad 本机没存地址。升级以后从网页数据记录里把那台电脑找回来：
    /// 以前直接用 http://<电脑>:8409/ 打开过（1.2 起还迁移过它的本机数据），记录名就是那台电脑的 IP / 主机名。
    /// 只找到一个局域网地址才用（端口用默认的 8409）并存成本机设置；找不到或不止一个就不猜，连不上页里自己填。
    static func recoverIfNeeded(_ done: @escaping () -> Void) {
        let saved = UserDefaults.standard.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard saved.isEmpty, !ShotMode.isOn else { done(); return }
        WKWebsiteDataStore.default().fetchDataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes()) { records in
            let names = Set(records.map { $0.displayName }).filter(isLAN)
            if names.count == 1, let host = names.first {
                UserDefaults.standard.set("http://\(host):8409/", forKey: key)
                NSLog("Board2Shell: recovered server address from web data: %@", host)
            }
            done()
        }
    }

    private static func isLAN(_ s: String) -> Bool {
        let p = s.split(separator: ".").compactMap { Int($0) }
        if p.count == 4, s.split(separator: ".").count == 4 {
            return p[0] == 10 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && (16...31).contains(p[1]))
        }
        return s.hasSuffix(".local")
    }
}
