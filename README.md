# 讲解版 iPad 外壳 App（Board2Shell）

## 这是什么

一个很薄的 iPad App，里面只有一个全屏网页窗口，打开的是你电脑上跑的"讲解版"（地址在 App 里填，例如 `http://192.168.1.10:8409/`）。和直接用 Safari 打开相比，多了三样东西：

- 真全屏：没有地址栏、没有状态栏，底部横条自动隐藏。
- Apple Pencil 双击（Pencil Pro 还有"捏一下"）会在笔和橡皮之间切换。网页自己拿不到这个动作，只有 App 能拿到，再转告网页（调用网页里的 `window.B2PencilDoubleTap()`）。
- 听课时屏幕不熄灭。

这种"原生 App 里面套一个网页"的做法，一般叫 **WebView 套壳**（搜：`WKWebView wrapper app`）。

App 本身不存任何课程内容，电脑上的讲解版没开，App 就只会显示"连不上"。

## 第一步：在 GitHub 上编出 ipa

ipa 就是 iPhone/iPad 的安装包。我们没有 Mac，所以借 GitHub 免费提供的 Mac 机器来编（这叫 **GitHub Actions**，一种自动构建服务）。

1. 把这个文件夹（`board2-ios`）的全部内容放进一个 GitHub 仓库（私有仓库也可以），推到 `main` 分支。
2. 推上去后会自动开始编译。也可以手动触发：打开仓库网页 → 顶部 **Actions** → 左边选 **Build unsigned IPA** → 右边 **Run workflow** → 绿色按钮 **Run workflow**。
3. 等它变成绿色对勾（一般 3–8 分钟）。点进这次运行，页面最下面 **Artifacts** 区域有 **Board2.ipa**，点它下载。
4. 如果变成红叉：点进去看 **Build (unsigned)** 和 **Show build log tail on failure** 这两步的输出，Artifacts 里也会有一份 `xcodebuild-log`。把报错发给 Claude 改。

编出来的 ipa 是"未签名"的，不能直接装，要用下一步的 Sideloadly 用你的 Apple ID 签个名。

## 第二步：用 Sideloadly 装到 iPad

Sideloadly 是一个免费的 Windows/Mac 工具，用你自己的 Apple ID 给 ipa 签名并装到设备上（这件事叫 **侧载**，英文 sideload）。

### 2.1 电脑上的准备（只做一次）

1. **装网页版的 iTunes 和 iCloud，不要用微软商店版。** Sideloadly 官网明确要求 Windows 上用"网页版（web version）"的 iTunes 和 iCloud；如果电脑上已经装了微软商店（Microsoft Store）版，先卸载再装。下载地址在 Sideloadly 官网首页有链接（Apple 官方的 iTunes 64 位安装包：`https://www.apple.com/itunes/download/win64`）。
   - 背景：2024 年起 Apple 在 Windows 上把 iTunes 拆成了"Apple 设备（Apple Devices）"等几个商店 App。Sideloadly 的说明里只认网页版 iTunes + iCloud，没有说 Apple Devices 应用可以代替。所以按它说的装网页版最稳。
2. 下载 Sideloadly：官网 `https://sideloadly.io/` ，选 Windows 64 位（SideloadlySetup64.exe）。写这份说明时（2026-11）官网显示的版本是 v0.71.0。

### 2.2 iPad 上的准备

1. 用数据线把 iPad 接到电脑，iPad 上弹"要信任此电脑吗"，点**信任**，输锁屏密码。
2. 建议先打开一次 iTunes，确认它能认出 iPad（Sideloadly 的 FAQ 说认不出设备时就是这么排查的）。

### 2.3 安装

1. 打开 Sideloadly。上面"iDevice"一栏应该能看到你的 iPad。
2. 把 `Board2.ipa` 拖进 Sideloadly 左边的方框。
3. "Apple account" 填你的 Apple ID（免费的就行）。
4. 点 **Start**，按提示输入 Apple ID 密码；如果要两步验证码，iPad/iPhone 上会弹出，填进去。
   - 密码只会发给 Apple。Sideloadly 默认用它的"Remote Anisette"服务，会把你的 IP、系统版本、Sideloadly 版本发给 Sideloadly 的服务器（这是它 FAQ 里写的）。介意的话在 Advanced Options 里换成 Local Anisette。
5. 等进度走完显示 Done。

### 2.4 第一次打开前，iPad 上要点两个地方

1. **打开开发者模式**（iPadOS 16 起需要）：设置 → 隐私与安全性 → 拉到最下面 → 开发者模式 → 打开 → 按提示重启 → 重启后再确认一次"打开"。
   - 这个开关通常要等你装过一个侧载 App 之后才会出现。所以顺序是：先用 Sideloadly 装，再去这里打开。
2. **信任你的 Apple ID**：设置 → 通用 → VPN与设备管理 → 点你的 Apple ID 邮箱 → 信任。
3. 回到桌面点"讲解版"。第一次会弹"想要查找并连接到本地网络上的设备"，**一定点允许**。点了"不允许"会一直连不上，要去 设置 → 隐私与安全性 → 本地网络 → 把"讲解版"打开。

### 2.5 免费 Apple ID 的限制

- **7 天后过期**：到期后 App 打不开（闪退）。重新用 Sideloadly 用同一个 Apple ID 再装一遍就行，App 里的数据一般会保留（网页的学习记录存在电脑上，不受影响）。Sideloadly 也有自动续签功能，但需要电脑开着且 iPad 和电脑在同一网络。
- **同时最多 3 个侧载 App**。
- **每 7 天最多注册 10 个 App ID**。频繁换 ipa、换 Bundle ID 会撞上，等几天或换个 Apple ID。

### 关于 Bundle ID

工程里写的 Bundle ID 是占位的 `com.example.board2shell`。Sideloadly 用免费账号签名时会把它改成跟你账号绑定的一个 ID，这是正常的，不用管。

## 平时怎么用

1. 先在电脑上把讲解版开起来，iPad 和电脑连同一个 Wi-Fi。
2. 点开 iPad 上的"讲解版"。
3. 电脑没开或网络不通时，App 会显示"连不上"页面：有"服务器地址"输入框、"重试"按钮和失败原因。把电脑开好后点"重试"。

### 改服务器地址

电脑的局域网 IP 变了（比如换了路由器），就要改地址：

- 连不上时，在"连不上"页面直接改地址，点"重试"。地址会记住。
- 页面正常时，**三根手指同时按住屏幕 2 秒**，会弹出"服务器地址"页面。改完点"重试"；不改就点"返回"。
- 地址可以只写 `192.168.1.10:8409`，App 会自动补上 `http://`。

### 每日复习提醒（1.1 起）

三指按住屏幕 2 秒打开设置页，地址框下面有"每日复习提醒"开关。第一次打开会弹系统的"允许通知"，点允许；之后选时间（默认 21:00）。每天到点 iPad 弹一条本机通知，点它打开 App。关掉开关就不再提醒。

- 只用本机定时通知，不经过电脑，也不需要联网。
- 之前点过"不允许"：开关会自己弹回关，并提示去 设置 → 通知 → 讲解版 打开。
- App 过期（7 天没续签）后通知还会照常弹，但点开会闪退，要先用 Sideloadly 重装。（未在真机上验证）
- 提醒的文字由 Gemini 写，提示词在 `board2/design/gemini/pack/ios-remind_p1_提示词.txt`。

### 离线可用（1.2 起）

- 页面不再直接开 `http://电脑:8409/`，而是开 `b2://board2/`，由 App 转给电脑（`Sources/OfflineProxy.swift`）。连得上时照常；每次读到的页面、图、声音、题目文件顺手存进 iPad（Application Support/offline/）。
- 电脑关着或不在同一个 Wi-Fi：看过的题从 iPad 上存的打开，顶上挂一条"没连电脑……"的字。没看过的题打不开，会弹提示。
- 连不上时的答题、看过、标记等记录先排队，连上后按顺序补发；问答、报修直接提示"没发出去"。
- 每 8 秒试一次电脑回来了没有，回来了就补发并弹一下提示。
- 第一次装上 1.2：会把旧地址下网页存在本机的东西（答题记录、草稿暂存、昼夜设置等）搬到新地址，只搬一次，不覆盖新地址上已有的。
- 已知限制：只存"看过的"；书页图要点开看过才有。没有做"一次下载全部题目"。

### 原生笔迹草稿纸（1.3 起）

- 新写的字由 PencilKit 画（`Sources/InkLayer.swift`），延迟更低；纸、透明度、工具条、双指平移缩放、每题一份仍由网页 `kit/draft.js` 负责。
- 旧的 v2 草稿（电脑上 `data/draft/<题号>.json`）只读，照原样显示在新字下面，App 不改也不删它；橡皮、撤销、清空只管新字。
- 新字存 PencilKit 格式：iPad 上 `ink/<题号>.drawing`；连得上时另存到电脑 `data/draft/pk_<题号>.json`（走原来的 POST /draft，不覆盖旧文件）。两边都改过时合并，不丢笔画。
- 网页侧配合改动：`board2/kit/draft.js` v6。在 Safari / 电脑浏览器里一切照旧。
- 1.8 起按"备忘录"的方式正规使用 PencilKit：草稿纸打开时画布盖在最上面自己接触摸——笔写字；手指默认只挪纸、双指缩放
  （工具条"更多"里打开"允许手指书写"后手指也写）。写字、橡皮、撤销都是 PencilKit 自带的。
  工具条还是网页原来那条（笔、橡皮、颜色、撤销、清空、透明度、缩放比例、更多、收起），它告诉 App 用哪个工具；工具条和它展开的小弹层那块，画布让给网页，点工具条第一下就生效、纸上不留笔画。
  清空在工具条第一层（Safari 里也一样），点一次变红并提示"再点清空整张纸"，4 秒内再点才清；App 里新笔迹和垫底的旧笔迹一起清，撤销能恢复（本次打开期间）。
  开关还有一颗 App 自己的按钮（放在网页草稿纸按钮原来的位置，一直点得到；网页没反应时 App 自己存盘收起）。
  打开时手指不穿透到下面的题，要点选项先收起草稿纸；问答面板、抽屉这些"纸上面的层"让给网页。
- 网页 `kit/draft.js` v10、`kit/draft.css` v6：在 App 里画纸、工具条和旧 v2 笔迹（跟着画布的取景窗走），不碰纸上的触摸。
  上线时先换 draft.js、draft.css，再换 index.html（index.html 先换的话会去要还不存在的新版本）。
- 笔迹诊断日志：画画手势开始 / 结束、工具条每次点击（网页收到和 App 收到的时间）、工具变化、笔画数变化、画布开关、挪纸缩放、触摸落在哪个视图上，
  每 8 秒 POST 到电脑 `/inklog`，落在 `board2/data/inklog/ink.log`（超过 2MB 轮换，留 3 份旧的）。不记题目内容。
- 云端模拟器里用真拖动、真点按测草稿纸（`UITests/ShotsUITests.swift` 的 `testInk`，横竖屏各一整套），结果 `inktest.json`，不过就红；
  模拟器测试没过时安装包叫 `Board2-untested.ipa`，过了才另发 `Board2.ipa`。

### 原生界面的样子（1.4 起）

- 颜色、三档动效时长（0.12 / 0.2 / 0.3 秒）和缓动曲线照网页 `kit/shell.css`、`kit/theme.css`，昼夜两套跟着网页走（`Sources/Design.swift`）。
- 设置：讲解页选题抽屉顶上的小图标里有一个"设置"（App 注进网页的，Safari 里没有）；三指按住 2 秒也能打开。是一张居中卡片，背后压暗，× 关掉回到原处不重载。里面：电脑地址、每日复习提醒、已存的题（数量、大小、清除要点两次）、版本号。
- 连不上：同样的卡片，只说人话原因和下一步，技术码收在"详细信息"里。
- 离线：画面区左上角先弹一条说明，3 秒后收成小圆点，点圆点再展开；连上电脑自动消失。
- 启动：先是和网页同色的底，网页摆好后淡入。启动画面（系统控制、不能按昼夜换）固定用夜间底色 #151515；网页设成白天时，启动那一下会从深色换到浅色。
- 界面上的字全由 Gemini 写，汇总在 `Sources/Copy.swift`。

### 云端模拟器截图（1.2 起）

push 后 Actions 里多一个 `simulator` 任务：在 iPad 模拟器里用 `ci/fixture/`（一道 2009 年示例题）和 `ci/stub_server.py`（假服务）跑起 App，按启动参数（`-b2shot` 等，见 `Sources/ShotMode.swift`）截主要画面（深浅 × 横竖），再连得上 / 连不上各自检一次。结果在 artifact `shots` 里。平时在 iPad 上不带这些参数，不生效。

## 双击 Pencil 没反应，怎么排查

按顺序看：

1. **网页那边有没有这个函数**：App 双击时只做一件事——执行 `window.B2PencilDoubleTap && window.B2PencilDoubleTap()`。网页如果还没提供 `B2PencilDoubleTap`，双击就什么都不会发生。可以先在电脑浏览器的控制台里输入 `typeof window.B2PencilDoubleTap`，应该是 `"function"`。
2. **页面是不是加载完了**：在"连不上"/"服务器地址"页面上，双击会被故意忽略。
3. **系统设置**：设置 → Apple Pencil → "轻点两下"（或"连按两次"）。App 不管这里选了什么都会执行切换，但如果选的是"关闭"，系统可能根本不把双击交给 App。改成任意一个非"关闭"的选项试试。
4. **笔型号**：只有 Apple Pencil 第二代和 Apple Pencil Pro 支持双击；"捏一下"只有 Apple Pencil Pro 有。第一代和 USB-C 款没有这个动作。
5. **只会切一下又切回来？** App 只在根视图上挂了一个 Pencil 监听（`UIPencilInteraction`），没有在网页视图上再挂第二个，并且加了 0.25 秒的防抖，所以理论上一次双击只执行一次。如果还是一下切两次，多半是网页侧也绑定了别的事件，请检查网页代码。
6. **完全没反应、网页函数也确认存在**：可能是 `UIPencilInteraction` 在这台 iPad 上没收到回调。可以让 Claude 改一版：把监听改挂到 `webView` 上（`ShellViewController.swift` 里的 `setUpPencil()`，把 `view.addInteraction(pencil)` 改成 `webView.addInteraction(pencil)`），注意只能二选一，两处都挂会一次双击触发两次。
7. **用 Mac 调试**：App 开了 `isInspectable`（iPadOS 16.4+），手边有 Mac 的话，可以用 Mac 上 Safari 的"开发"菜单连上 iPad 看网页的控制台。

## 一些设计说明（给以后改代码的人）

- **全屏**：隐藏状态栏、底部横条自动隐藏，网页铺满全屏包括刘海和圆角区域，安全区由网页的 `viewport-fit=cover` 自己处理。底部边缘的系统手势会延后一下，减少画到屏幕底部时误触回桌面。
- **http 明文**：`Info.plist` 里 `NSAppTransportSecurity` 打开了 `NSAllowsLocalNetworking`（局域网地址）和 `NSAllowsArbitraryLoadsInWebContent`（网页窗口里的一切 http 兜底）。
- **缩放**：App 往网页的 viewport 里补了 `maximum-scale=1, user-scalable=no`，禁止页面整体捏合缩放和双击放大；网页自己处理的双指手势不受影响。如果网页本来就写了这两项，不会改动。
- **自动恢复**：网页进程崩了会自动重载；从后台回到前台时，如果之前是"连不上"状态或页面变成空白，会自动重载。没有下拉刷新。
- **自动播放**：配音不需要先点一下才能播；静音模式下也会出声。
- **iPadOS 26 的窗口模式**：`UIRequiresFullScreen` 在 iPadOS 26 里已被 Apple 标为过时（未核实它在新窗口模式下是否还生效）。如果你在 iPad 上打开了"窗口化 App"之类的多任务模式，App 可能能被缩成小窗；切回"全屏 App"模式即可。

## 文件清单

- `project.yml`：XcodeGen 工程描述（XcodeGen 是根据这个文本文件生成 Xcode 工程的工具，省得手写工程文件）。
- `Sources/`：Swift 源码。`ShellViewController.swift` 是主体。
- `Resources/Info.plist`：App 的配置（名称、权限说明、http 许可等）。
- `Resources/Assets.xcassets/`：App 图标（1024×1024 一张）和启动画面底色。
- `.github/workflows/build.yml`：GitHub Actions 编译脚本。

## 参考来源（2026-11-22 查）

- Sideloadly 官网（Windows 需要网页版 iTunes/iCloud、版本 v0.71.0、免费账号 7 天）：https://sideloadly.io/
- Sideloadly FAQ（认不出设备的排查、开发者模式、信任描述文件、3 个 App / 每周 10 个 App ID、Anisette）：https://sideloadly.io/faq
- Sideloadly 官方 GitHub 下载说明：https://github.com/SideloadlyiOS/Sideloadly-Download
- GitHub macOS runner：`macos-latest` 已指向 macOS 26，macos-14 于 2026-11-02 退役：https://github.com/actions/runner-images/issues/14167
- actions/checkout 当前大版本 v7：https://github.com/actions/checkout
- actions/upload-artifact 当前大版本 v7（`archive: false` 可直接上传单个文件不套 zip）：https://github.com/actions/upload-artifact
- XcodeGen 工程描述语法：https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md
- 无签名 ipa 的通行做法（XcodeGen + `CODE_SIGNING_ALLOWED=NO` + Payload 打包）：https://github.com/letsdo1t/ios-swiftui-app-template 、 https://dev.to/oivoodoo/build-unsigned-ios-ipa-to-install-via-sideloadly-236f
- `pencilInteractionDidTap` 在实现了新回调后不再被调用（头文件注释转述）：https://docs.rs/objc2-ui-kit/latest/aarch64-apple-ios-macabi/objc2_ui_kit/trait.UIPencilInteractionDelegate.html
- Pencil 双击在自定义弹出方式下收不到回调的讨论：https://developer.apple.com/forums/thread/129093
- 未核实：Apple Devices 应用（微软商店）能否代替网页版 iTunes 给 Sideloadly 用；iPadOS 26 窗口模式下 `UIRequiresFullScreen` 的实际效果。
