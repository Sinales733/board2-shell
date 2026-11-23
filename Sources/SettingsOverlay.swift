import UIKit

/// 设置面板和连不上页：讲解页上面浮起来的一张居中卡片（网页 .fbp 那样的底色、描边、圆角、阴影），
/// 背后压暗（网页 .scrim 的颜色）；连不上又没有页面可看时，背后是纯底色。
/// 关掉只是收起卡片，讲解页不重载。
final class SettingsOverlay: UIView, UITextFieldDelegate {

    enum Mode { case settings, failure }

    /// 点了连接 / 重试：参数是输入框里的地址。
    var onConnect: ((String) -> Void)?
    /// 收起（× 或点卡片外面）。
    var onClose: (() -> Void)?
    /// 清除 iPad 上存的题。
    /// 存了几道、多大（后台算好回调）。
    var cacheStats: ((@escaping (Int, Int64) -> Void) -> Void)?
    /// 清除（后台删好回调）。
    var onClearCache: ((@escaping () -> Void) -> Void)?
    var onToast: ((String) -> Void)?

    private(set) var mode: Mode = .settings
    private(set) var isShown = false
    private var canClose = true

    private let scrim = UIView()
    private let card = UIView()
    private let stack = UIStackView()
    private var centerY: NSLayoutConstraint!

    // 头
    private let titleLabel = UILabel()
    private let closeButton = IconButton(.close, label: Copy.Settings.close)
    // 连不上
    private let reasonLabel = bodyLabel(nil, size: 17, color: Theme.text)
    private let nextLabel = bodyLabel(nil, size: 15, color: Theme.secondaryText)
    private let failBlock = UIStackView()
    private let detailsButton = PressButton(type: .custom)
    private let detailsChevron = ChevronView()
    private let detailsLabel = UILabel()
    private var detailsOpen = false
    // 地址
    private let addrField = B2Field()
    private let connectButton = B2Button(Copy.Settings.connect, kind: .primary)
    private let addrHint = bodyLabel(Copy.Settings.addrHint, size: 13, color: Theme.faint)
    // 提醒
    private let remindBlock = UIStackView()
    private let remindSwitch = UISwitch()
    private let timeRow = UIStackView()
    private let timeButton = PressButton(type: .custom)
    private let wheel = UIDatePicker()
    private var wheelHeight: NSLayoutConstraint!
    private let remindStatus = bodyLabel(nil, size: 13, color: Theme.faint)
    // 已存的题
    private let cacheBlock = UIStackView()
    private let cacheLabel = bodyLabel(nil, size: 15, color: Theme.text2)
    private let clearButton = B2Button(Copy.Settings.clear, kind: .secondary)
    private var sureWork: DispatchWorkItem?
    // 页脚
    private let versionLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        build()
    }
    required init?(coder: NSCoder) { fatalError() }

    // MARK: - 搭

    private func build() {
        isHidden = true
        scrim.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scrim)
        scrim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(scrimTapped)))

        card.backgroundColor = Theme.surface
        card.layer.cornerRadius = 20
        card.layer.cornerCurve = .continuous
        card.layer.borderWidth = 1
        card.layer.shadowRadius = 17
        card.layer.shadowOffset = CGSize(width: 0, height: 10)
        card.translatesAutoresizingMaskIntoConstraints = false
        addSubview(card)

        stack.axis = .vertical
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        // 头：标题 + 右上角 ×（和网页面板的关闭方式一样）
        titleLabel.font = Theme.font(22, bold: true)
        titleLabel.textColor = Theme.text
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(closeButton)
        let head = UIView()
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        head.addSubview(titleLabel)
        NSLayoutConstraint.activate([
            head.heightAnchor.constraint(equalToConstant: 46),
            titleLabel.leadingAnchor.constraint(equalTo: head.leadingAnchor),
            titleLabel.centerYAnchor.constraint(equalTo: head.centerYAnchor),
            titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: head.trailingAnchor, constant: -40)
        ])
        stack.addArrangedSubview(head)
        stack.setCustomSpacing(6, after: head)

        // 连不上：原因 + 下一步
        failBlock.axis = .vertical
        failBlock.spacing = 6
        failBlock.addArrangedSubview(reasonLabel)
        failBlock.addArrangedSubview(nextLabel)
        stack.addArrangedSubview(failBlock)
        stack.setCustomSpacing(22, after: failBlock)

        // 地址：小标题、输入框 + 主按钮并排、说明
        let addrTitle = sectionLabel(Copy.Settings.addr)
        addrField.delegate = self
        addrField.returnKeyType = .go
        connectButton.addTarget(self, action: #selector(connectTapped), for: .touchUpInside)
        connectButton.setContentHuggingPriority(.required, for: .horizontal)
        connectButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        let addrRow = UIStackView(arrangedSubviews: [addrField, connectButton])
        addrRow.spacing = 10
        addrRow.alignment = .center
        stack.addArrangedSubview(addrTitle)
        stack.setCustomSpacing(8, after: addrTitle)
        stack.addArrangedSubview(addrRow)
        stack.setCustomSpacing(8, after: addrRow)
        stack.addArrangedSubview(addrHint)

        // 详细信息（连不上页，默认收起）
        detailsButton.setTitle(Copy.Fail.details, for: .normal)
        detailsButton.titleLabel?.font = Theme.font(13)
        detailsButton.setTitleColor(Theme.faint, for: .normal)
        detailsButton.contentHorizontalAlignment = .left
        detailsButton.contentEdgeInsets = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 22)
        detailsButton.heightAnchor.constraint(equalToConstant: 44).isActive = true
        detailsChevron.translatesAutoresizingMaskIntoConstraints = false
        detailsButton.addSubview(detailsChevron)
        if let tl = detailsButton.titleLabel {
            NSLayoutConstraint.activate([
                detailsChevron.leadingAnchor.constraint(equalTo: tl.trailingAnchor, constant: 4),
                detailsChevron.centerYAnchor.constraint(equalTo: detailsButton.centerYAnchor),
                detailsChevron.widthAnchor.constraint(equalToConstant: 16),
                detailsChevron.heightAnchor.constraint(equalToConstant: 16)
            ])
        }
        detailsButton.addTarget(self, action: #selector(detailsTapped), for: .touchUpInside)
        detailsLabel.font = Theme.mono(12)
        detailsLabel.textColor = Theme.faint
        detailsLabel.numberOfLines = 0
        detailsLabel.alpha = 0
        detailsLabel.isHidden = true
        stack.addArrangedSubview(detailsButton)
        stack.setCustomSpacing(0, after: detailsButton)
        stack.addArrangedSubview(detailsLabel)

        // 每日复习提醒：开关一行、时间一行（点了在下面展开滚轮）、状态小字
        remindBlock.axis = .vertical
        remindBlock.spacing = 10
        remindBlock.addArrangedSubview(hairline())
        let rl = bodyLabel(DailyReminder.Text.label)
        remindSwitch.onTintColor = Theme.accent
        remindSwitch.addTarget(self, action: #selector(remindSwitched), for: .valueChanged)
        let swRow = UIStackView(arrangedSubviews: [rl, UIView(), remindSwitch])
        swRow.alignment = .center
        swRow.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        remindBlock.addArrangedSubview(swRow)
        let tl = bodyLabel(DailyReminder.Text.time, size: 15, color: Theme.secondaryText)
        timeButton.titleLabel?.font = Theme.mono(17, bold: true)
        timeButton.setTitleColor(Theme.text, for: .normal)
        timeButton.backgroundColor = Theme.surface2
        timeButton.layer.cornerRadius = 10
        timeButton.layer.cornerCurve = .continuous
        timeButton.contentEdgeInsets = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
        timeButton.heightAnchor.constraint(equalToConstant: 44).isActive = true
        timeButton.addTarget(self, action: #selector(timeTapped), for: .touchUpInside)
        timeRow.addArrangedSubview(tl)
        timeRow.addArrangedSubview(UIView())
        timeRow.addArrangedSubview(timeButton)
        timeRow.alignment = .center
        remindBlock.addArrangedSubview(timeRow)
        wheel.datePickerMode = .time
        wheel.preferredDatePickerStyle = .wheels
        wheel.locale = Locale(identifier: "zh_CN")
        wheel.tintColor = Theme.accent
        wheel.addTarget(self, action: #selector(timeChanged), for: .valueChanged)
        wheel.clipsToBounds = true
        wheel.alpha = 0
        wheel.isHidden = true   // 收起时不占位（不然 stack 的间距会留一条空）
        wheelHeight = wheel.heightAnchor.constraint(equalToConstant: 0)
        wheelHeight.isActive = true
        remindBlock.addArrangedSubview(wheel)
        remindBlock.addArrangedSubview(remindStatus)
        stack.addArrangedSubview(remindBlock)
        stack.setCustomSpacing(18, after: addrHint)

        // 已存的题
        cacheBlock.axis = .vertical
        cacheBlock.spacing = 10
        cacheBlock.addArrangedSubview(hairline())
        cacheBlock.addArrangedSubview(sectionLabel(Copy.Settings.cache))
        clearButton.addTarget(self, action: #selector(clearTapped), for: .touchUpInside)
        clearButton.setContentHuggingPriority(.required, for: .horizontal)
        let cRow = UIStackView(arrangedSubviews: [cacheLabel, UIView(), clearButton])
        cRow.alignment = .center
        cacheBlock.addArrangedSubview(cRow)
        cacheBlock.addArrangedSubview(bodyLabel(Copy.Settings.cacheHint, size: 13, color: Theme.faint))
        stack.addArrangedSubview(cacheBlock)
        stack.setCustomSpacing(18, after: remindBlock)

        // 页脚：版本号
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        versionLabel.text = Copy.Settings.version.replacingOccurrences(of: "{v}", with: v)
        versionLabel.font = Theme.mono(12)
        versionLabel.textColor = Theme.faint
        versionLabel.textAlignment = .center
        stack.addArrangedSubview(versionLabel)
        stack.setCustomSpacing(22, after: cacheBlock)

        let side = card.widthAnchor.constraint(equalToConstant: 520)
        side.priority = .defaultHigh
        centerY = card.centerYAnchor.constraint(equalTo: safeAreaLayoutGuide.centerYAnchor)
        NSLayoutConstraint.activate([
            scrim.topAnchor.constraint(equalTo: topAnchor),
            scrim.bottomAnchor.constraint(equalTo: bottomAnchor),
            scrim.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrim.trailingAnchor.constraint(equalTo: trailingAnchor),
            card.centerXAnchor.constraint(equalTo: centerXAnchor),
            centerY,
            side,
            card.leadingAnchor.constraint(greaterThanOrEqualTo: safeAreaLayoutGuide.leadingAnchor, constant: 32),
            card.trailingAnchor.constraint(lessThanOrEqualTo: safeAreaLayoutGuide.trailingAnchor, constant: -32),
            card.topAnchor.constraint(greaterThanOrEqualTo: safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 14),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -24),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16),
            // × 在卡片右上角（和网页面板一样），和标题同一行
            closeButton.topAnchor.constraint(equalTo: card.topAnchor, constant: 14),
            closeButton.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -12)
        ])

        NotificationCenter.default.addObserver(self, selector: #selector(keyboard(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        paintColors()
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        paintColors()
    }

    private func paintColors() {
        card.layer.borderColor = Theme.line2.resolvedColor(with: traitCollection).cgColor
        card.layer.shadowColor = Theme.shadow.resolvedColor(with: traitCollection).cgColor
        card.layer.shadowOpacity = Theme.shadowOpacity(traitCollection)
        scrim.backgroundColor = (mode == .failure && !canClose) ? Theme.background : Theme.scrim
        remindSwitch.thumbTintColor = Theme.thumb
        remindSwitch.backgroundColor = Theme.line2
        remindSwitch.layer.cornerRadius = remindSwitch.bounds.height / 2
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        remindSwitch.layer.cornerRadius = remindSwitch.bounds.height / 2
    }

    // MARK: - 打开、收起

    /// 设置面板。
    func showSettings(address: String, animated: Bool = true) {
        mode = .settings
        canClose = true
        titleLabel.text = Copy.Settings.title
        connectButton.setTitle(Copy.Settings.connect, for: .normal)
        failBlock.isHidden = true
        detailsButton.isHidden = true
        detailsLabel.isHidden = true
        addrHint.isHidden = false
        remindBlock.isHidden = false
        cacheBlock.isHidden = false
        versionLabel.isHidden = false
        closeButton.isHidden = false
        addrField.text = address
        setBusy(false)
        refreshReminder()
        refreshCache()
        // 系统设置里可能把通知关了：先核对一遍，开关跟着变
        DailyReminder.sync { [weak self] in self?.refreshReminder() }
        present(animated: animated)
    }

    /// 连不上页。reason 是 Copy.Fail.reasons 的键，detail 是技术码（收在"详细信息"里）。
    func showFailure(address: String, reason: String, detail: String, canClose: Bool, animated: Bool = true) {
        let wasShown = isShown && mode == .failure
        mode = .failure
        self.canClose = canClose
        titleLabel.text = Copy.Fail.title
        connectButton.setTitle(Copy.Fail.retry, for: .normal)
        let apply = {
            self.reasonLabel.text = Copy.Fail.reasons[reason] ?? Copy.Fail.reasons["other"]
            self.nextLabel.text = Copy.Fail.next[reason] ?? Copy.Fail.next["other"]
            self.detailsLabel.text = detail
        }
        if wasShown { UIView.transition(with: failBlock, duration: Motion.mid, options: .transitionCrossDissolve, animations: apply) } else { apply() }
        failBlock.isHidden = false
        detailsButton.isHidden = false
        setDetails(ShotMode.isOn && UserDefaults.standard.bool(forKey: "b2details"), animated: false)
        addrHint.isHidden = true
        remindBlock.isHidden = true
        cacheBlock.isHidden = true
        versionLabel.isHidden = true
        closeButton.isHidden = !canClose
        addrField.text = address
        setBusy(false)
        paintColors()
        if !wasShown { present(animated: animated) }
    }

    func setBusy(_ busy: Bool) {
        connectButton.isEnabled = !busy
        if busy { connectButton.setTitle(Copy.Settings.connecting, for: .normal) }
        else { connectButton.setTitle(mode == .failure ? Copy.Fail.retry : Copy.Settings.connect, for: .normal) }
    }

    private func present(animated: Bool) {
        paintColors()
        superview?.bringSubviewToFront(self)
        isHidden = false
        isShown = true
        guard animated else {
            scrim.alpha = 1; card.alpha = 1; card.transform = .identity
            return
        }
        scrim.alpha = 0
        card.alpha = 0
        card.transform = Motion.offset(16).concatenating(Motion.scale(0.98))
        Motion.animate(Motion.big) {
            self.scrim.alpha = 1
            self.card.alpha = 1
            self.card.transform = .identity
        }
    }

    func hide(animated: Bool = true) {
        guard isShown else { return }
        isShown = false
        endEditing(true)
        sureWork?.cancel(); clearButton.sure = false; clearButton.setTitle(Copy.Settings.clear, for: .normal)
        guard animated else { isHidden = true; return }
        Motion.animate(Motion.mid, {
            self.scrim.alpha = 0
            self.card.alpha = 0
            self.card.transform = Motion.offset(10).concatenating(Motion.scale(0.98))
        }, completion: { if !self.isShown { self.isHidden = true; self.card.transform = .identity } })
    }

    @objc private func closeTapped() { onClose?() }
    @objc private func scrimTapped() {
        if addrField.isFirstResponder { endEditing(true); return }
        if canClose { onClose?() }
    }
    @objc private func connectTapped() {
        endEditing(true)
        onConnect?(addrField.text ?? "")
    }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool { connectTapped(); return true }

    @objc private func detailsTapped() { setDetails(!detailsOpen, animated: true) }
    private func setDetails(_ open: Bool, animated: Bool) {
        detailsOpen = open
        let turn = { self.detailsChevron.transform = open ? CGAffineTransform(rotationAngle: .pi / 2) : .identity }
        guard animated else { detailsLabel.isHidden = !open; detailsLabel.alpha = open ? 1 : 0; turn(); return }
        Motion.animate(Motion.mid) {
            self.detailsLabel.isHidden = !open
            self.detailsLabel.alpha = open ? 1 : 0
            turn()
            self.card.layoutIfNeeded()
        }
    }

    @objc private func keyboard(_ n: Notification) {
        guard isShown, let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let kb = convert(end, from: nil)
        let overlap = max(0, bounds.maxY - kb.minY)
        let cardBottom = card.frame.maxY - centerY.constant
        let lift = overlap > 0 ? max(0, cardBottom - (bounds.height - overlap) + 16) : 0
        centerY.constant = -lift
        Motion.animate(Motion.big) { self.layoutIfNeeded() }
    }

    // MARK: - 提醒

    /// 回到前台核对过通知权限后调：面板开着就重画开关。
    func reminderMayHaveChanged() {
        guard isShown, mode == .settings else { return }
        refreshReminder()
    }

    private func refreshReminder(note: String? = nil) {
        let on = DailyReminder.isEnabled
        remindSwitch.setOn(on, animated: false)
        timeRow.isHidden = !on
        timeButton.setTitle(DailyReminder.timeString, for: .normal)
        var comps = DailyReminder.time
        comps.year = 2000; comps.month = 1; comps.day = 1
        if let date = Calendar.current.date(from: comps) { wheel.setDate(date, animated: false) }
        if !on { setWheel(false, animated: false) }
        remindStatus.text = note ?? DailyReminder.statusText
        remindStatus.isHidden = note == nil && !on
        paintColors()
    }

    @objc private func remindSwitched() {
        Haptics.select()
        paintColors()
        if remindSwitch.isOn {
            remindSwitch.isEnabled = false
            DailyReminder.enable { [weak self] granted in
                guard let self = self else { return }
                self.remindSwitch.isEnabled = true
                Motion.animate(Motion.mid) {
                    self.refreshReminder(note: granted ? nil : DailyReminder.Text.denied)
                    self.card.layoutIfNeeded()
                }
            }
        } else {
            DailyReminder.disable()
            Motion.animate(Motion.mid) {
                self.refreshReminder()
                self.card.layoutIfNeeded()
            }
        }
    }

    @objc private func timeTapped() { setWheel(wheelHeight.constant == 0, animated: true) }
    private func setWheel(_ open: Bool, animated: Bool) {
        wheelHeight.constant = open ? 180 : 0
        if open { wheel.isHidden = false }
        let change = {
            self.wheel.isHidden = !open
            self.wheel.alpha = open ? 1 : 0
            self.timeButton.backgroundColor = open ? Theme.accentSoft : Theme.surface2
            self.timeButton.setTitleColor(open ? Theme.accent : Theme.text, for: .normal)
            self.card.layoutIfNeeded()
        }
        if animated { Motion.animate(Motion.big, change) } else { change() }
    }

    @objc private func timeChanged() {
        let comps = Calendar.current.dateComponents([.hour, .minute], from: wheel.date)
        DailyReminder.setTime(comps)
        timeButton.setTitle(DailyReminder.timeString, for: .normal)
        remindStatus.text = DailyReminder.statusText
    }

    /// 截图用：展开时间滚轮 / 把清除按钮点成"再点清除"的确认样子。
    func shotOpenWheel() { if !timeRow.isHidden { setWheel(true, animated: false) } }
    func shotArmClear() { if clearButton.isEnabled { clearTapped(); sureWork?.cancel() } }

    // MARK: - 已存的题

    func refreshCache() {
        cacheStats? { [weak self] n, bytes in self?.paintCache(n, bytes) }
    }

    private func paintCache(_ n: Int, _ bytes: Int64) {
        if n == 0 && bytes == 0 {
            cacheLabel.text = Copy.Settings.cacheNone
            clearButton.isEnabled = false
        } else {
            let s = ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
            cacheLabel.text = Copy.Settings.cacheStat.replacingOccurrences(of: "{n}", with: String(n)).replacingOccurrences(of: "{s}", with: s)
            clearButton.isEnabled = true
        }
    }

    /// 清除要点两次：第一次变成红描边的"再点清除"，4 秒内再点才清（和网页草稿纸"清空"一样）。
    @objc private func clearTapped() {
        if !clearButton.sure {
            Haptics.tap()
            Motion.animate(Motion.mid) {
                self.clearButton.sure = true
                self.clearButton.setTitle(Copy.Settings.clearSure, for: .normal)
                self.card.layoutIfNeeded()
            }
            sureWork?.cancel()
            let w = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                Motion.animate(Motion.mid) {
                    self.clearButton.sure = false
                    self.clearButton.setTitle(Copy.Settings.clear, for: .normal)
                    self.card.layoutIfNeeded()
                }
            }
            sureWork = w
            DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: w)
            return
        }
        sureWork?.cancel()
        clearButton.sure = false
        clearButton.setTitle(Copy.Settings.clear, for: .normal)
        clearButton.isEnabled = false
        onClearCache? { [weak self] in
            Haptics.done()
            self?.onToast?(Copy.Settings.cleared)
            self?.refreshCache()
        }
    }
}
