import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene,
               willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = DiagWindow(windowScene: windowScene)
        window.overrideUserInterfaceStyle = Theme.style   // 一开始就用网页上次的昼夜套，避免先亮后暗
        window.backgroundColor = Theme.background
        window.rootViewController = ShellViewController()
        self.window = window
        window.makeKeyAndVisible()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        // 听课时不熄屏。每次回到前台都重新设一遍，系统有时会把它复位。
        UIApplication.shared.isIdleTimerDisabled = true
    }

    func sceneWillResignActive(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = false
    }
}

/// 草稿纸开着（或云端截图模式）时，把每一下触摸落在哪个视图上记进笔迹诊断日志：真机上"点不动"时能看出触摸被谁收走了。
final class DiagWindow: UIWindow {
    override func sendEvent(_ event: UIEvent) {
        if event.type == .touches, InkDiag.shared.touchLogging || ShotMode.isOn, let ts = event.allTouches {
            for t in ts where t.phase == .began {
                let p = t.location(in: self)
                let kind = t.type == .pencil ? "pencil" : (t.type == .direct ? "finger" : "other")
                let v = t.view.map { String(describing: type(of: $0)) } ?? "nil"
                InkDiag.shared.log("touch \(kind) \(InkDiag.pt(p)) view=\(v)")
            }
        }
        super.sendEvent(event)
    }
}
