import Foundation
import UserNotifications

/// 每日复习提醒：只用 iPad 本机的定时通知（免费 Apple ID 签名做不了远程推送）。
/// 界面上的字由 Gemini 写（board2/design/gemini/pack/ios-remind_p1_提示词.txt）。
enum DailyReminder {

    enum Text {
        static let label = "每日复习提醒"
        static let time = "提醒时间"
        static let status = "每天 {t} 提醒复习"
        static let title = "复习时间到了"
        static let body = "打开讲解版，把今天计划的真题过一遍。"
        static let denied = "通知权限没开，请去 设置 → 通知 → 讲解版 打开。"
    }

    private static let id = "board2.daily-review"
    private static let enabledKey = "reminderEnabled"
    private static let hourKey = "reminderHour"
    private static let minuteKey = "reminderMinute"

    static var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    /// 默认晚上 9 点。
    static var time: DateComponents {
        get {
            let d = UserDefaults.standard
            let h = d.object(forKey: hourKey) == nil ? 21 : d.integer(forKey: hourKey)
            let m = d.integer(forKey: minuteKey)
            return DateComponents(hour: h, minute: m)
        }
        set {
            UserDefaults.standard.set(newValue.hour ?? 21, forKey: hourKey)
            UserDefaults.standard.set(newValue.minute ?? 0, forKey: minuteKey)
        }
    }

    static var timeString: String {
        let t = time
        return String(format: "%02d:%02d", t.hour ?? 21, t.minute ?? 0)
    }

    static var statusText: String {
        return Text.status.replacingOccurrences(of: "{t}", with: timeString)
    }

    /// 打开提醒：先要通知权限，拿到了才排上。completion(true) 表示已打开，false 表示没权限。
    static func enable(completion: @escaping (Bool) -> Void) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error { NSLog("Board2Shell: notification auth failed: \(error)") }
            DispatchQueue.main.async {
                isEnabled = granted
                if granted { schedule() } else { cancel() }
                completion(granted)
            }
        }
    }

    static func disable() {
        isEnabled = false
        cancel()
    }

    static func setTime(_ comps: DateComponents) {
        time = comps
        if isEnabled { schedule() }
    }

    /// App 启动、回到前台、打开设置面板时调：开着的就按存的时间重排一遍（防止被系统清掉）；
    /// 权限在系统设置里被关了就当关掉（开关跟着变回关）。done 在主线程回调。
    static func sync(_ done: (() -> Void)? = nil) {
        guard isEnabled else { done?(); return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral:
                    schedule()
                default:
                    disable()
                }
                done?()
            }
        }
    }

    private static func schedule() {
        let content = UNMutableNotificationContent()
        content.title = Text.title
        content.body = Text.body
        content.sound = .default

        var comps = DateComponents()
        comps.hour = time.hour
        comps.minute = time.minute
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: true)
        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)

        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.add(request) { error in
            if let error = error { NSLog("Board2Shell: schedule reminder failed: \(error)") }
        }
    }

    private static func cancel() {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
    }
}
