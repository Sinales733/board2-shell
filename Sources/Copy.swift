import Foundation

/// 原生界面上给人看的字。全部由 Gemini 写（提示词在 board2/design/gemini/pack/ 下：
/// ios-remind_p1（提醒）、ios-offline_p1（离线）、ios-polish_p1（设置面板、连不上页、离线小标记）、ios-polish2_p1（已存的题那一行）），这里只是照抄。
enum Copy {
    enum Settings {
        static let title = "设置"
        static let close = "关闭设置"
        static let gear = "打开设置"
        static let addr = "电脑地址"
        static let addrHint = "平时不用改，换了路由器或地址变了再改。"
        static let connect = "连接"
        static let connecting = "连接中"
        static let cache = "已存的题"
        static let cacheStat = "共 {n} 道题，占用 {s}"
        static let cacheNone = "一道都没存，不占空间"
        static let cacheHint = "电脑关着时靠这些看题，清了要连电脑才能看。"
        static let clear = "清除"
        static let clearSure = "再点清除"
        static let cleared = "已全部清除"
        static let version = "版本 {v}"
    }
    enum Fail {
        static let title = "连不上电脑"
        static let retry = "重试"
        static let details = "详细信息"
        static let reasons: [String: String] = [
            "timeout": "等了很久，电脑一直没有回应。",
            "refused": "电脑开着，但上面的讲解版没打开。",
            "nowifi": "iPad 没连上 Wi-Fi。",
            "notfound": "按这个地址找不到你的电脑。",
            "blocked": "iPad 系统拦住了这次连接。",
            "badaddr": "下面填的地址格式不对。",
            "other": "暂时连不上电脑，原因不太明确。"
        ]
        static let next: [String: String] = [
            "timeout": "确认电脑开着讲解版，再看是不是同一个 Wi-Fi。",
            "refused": "去电脑上把讲解版打开，再点下面的重试。",
            "nowifi": "先去系统设置连上 Wi-Fi，再回来点重试。",
            "notfound": "去电脑上看一下现在的地址，填到下面再重试。",
            "other": "核对一下地址，或在系统设置允许连接后重试。"
        ]
    }
    static let offMark = "展开离线说明"
}
