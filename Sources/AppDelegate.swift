import UIKit
import AVFoundation
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 点通知时系统会打开 App；设代理是为了 App 开着时到点也照样弹出横幅。
        UNUserNotificationCenter.current().delegate = self
        TouchClock.install()   // 诊断：记触摸开始 / 结束时间（只旁听）
        // MainBeat（主线程卡顿诊断）只在草稿纸开着时跑：InkLayer.openUI / closeUI
        MainWatch.start()      // 云端测试模式才有：主线程存活看门狗（压力测试判"触摸晚到"时用）
        if !ShotMode.isOn { DailyReminder.sync() }

        // 配音在静音模式下也要能出声。失败了也不影响别的功能。
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
        } catch {
            NSLog("Board2Shell: audio session category failed: \(error)")
        }
        return true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        completionHandler()
    }
}
