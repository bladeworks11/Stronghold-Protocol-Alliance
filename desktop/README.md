# 卫戍协议：盟约 · 桌面客户端

把游戏包成一个独立窗口程序（Electron 44）：双击就进游戏，不用开浏览器、不用记地址。

## 目录里有什么

```
client/
├─ main.js              主进程：窗口 + 本地反向代理（素材本地化、HTTP/WebSocket 转发）
├─ config.json          服务端地址（server 一行）——换 IP/域名只改这里
├─ offline.html         连不上服务器时的页面（主进程每 5 秒自动重试）
├─ icon.png / icon.ico  由标题画面那枚点阵徽记生成（build/make-icon.py）
├─ build/
│  ├─ make-icon.py        重新生成图标（改颜色/尺寸用）
│  └─ build-portable.ps1  打包成可直接发的文件夹（可选含素材、可选 zip）
└─ assets/ fonts/       ← 只有 -WithAssets 打包时存在（public/assets、public/fonts 的副本）
```

## 素材与插件的自动更新（`sync.js`）

安装包里带没带素材都能用，但服务器换了素材/插件时不该要求玩家重装。客户端启动后（开窗之后，不挡首屏）
向服务器要一份清单：

```
GET <server>/sync/manifest.json        # 服务端 server/http/syncManifest.js，gzip + ETag
```

清单内容是「服务器当前每个素材文件的 16 位内容哈希 + 每个已加载插件对外文件的全量 SHA-256 + Spine 模型分组」。
客户端拿它和自己记录过的版本比对，然后：

* **缺的** → 下载（素材 `/assets/~<hash>/…`、字体 `/fonts/~<hash>/…`、插件 `/p/<id>/<hash8>/…`），校验哈希后
  写入 `<userData>\content\…`（先写临时文件再改名，写一半断电不会留下坏文件）；
* **改过的** → 哈希不同就重下覆盖；**服务器上已经删掉的** → 从缓存里清掉；
* **清单没变** → 304，一个字节都不下。

安装包里自带的素材/插件**不会**被复制进缓存：打包时生成 `bundle-index.json`（`build/make-bundle-index.mjs`）
说明包里每个文件的哈希，对得上就不再下载，所以升级安装包后只补真正变过的那部分；没有这份清单的旧包，客户端
会对包内文件懒校验一次并把结果记在 `<userData>\bundle-check.json`。

Spine 模型的骨架、atlas 和贴图共用一个「模型哈希」（成员哈希再哈希），所以清单额外带 `models` 分组；
客户端认出这种地址就用本地副本，不会把每个模型文件都当成"新内容"重下。

想看同步状态：`<userData>\sync-status.json`（进度/结果）与 `<userData>\sync.json`（已具备的文件与 ETag）。
只同步一次就退出（打包机、运维检查用，参数 `--content-sync`）：

```powershell
"$env:SP_SERVER" = "http://112.124.47.122"; .\"Stronghold Protocol.exe" --content-sync
```

## 固定端口与「记住昵称」

客户端内置的本地代理**固定监听 `127.0.0.1:47812`**（占用时顺延 47813…，可用 `config.json` 的 `port` 或环境变量 `SP_PORT` 覆盖）。

为什么要固定：页面 origin 里带端口，**端口一变就等于换了站点**——游戏存在 `localStorage` 里的
代号（`sp.name`）、设置、以及已导入素材的 `Cache Storage` 全都按 origin 存，端口随机就会每次"失忆"
（表现就是每次打开都要重新输昵称）。改成固定端口后，昵称、设置、进入状态都会跨启动保留。

实测：连续启动两次，`proxy` 都是 `http://127.0.0.1:47812`，`localStorage` 里的探针值第二次仍能读回。
### 每次启动都停在标题页

游戏用 **sessionStorage** 的 `sp.entered` 记录“这个标签页已经过标题页”，有它就会跳过标题页直接进大厅。
浏览器里这没问题（关标签页就没了），但桌面客户端的 Chromium profile 是持久的，这个标记可能被恢复。

客户端的约定是**每次启动都停在标题页**（代号保留、自动预填，按一下「开始」即可）。为此加了 `preload.js`：
它在页面脚本之前把这个标记清掉（只动 `sp.entered`，昵称 `sp.name` 和别的存储一概不碰）。

实测（重建后的绿色版连跑两次）：

```
第 1 次: proxy=http://127.0.0.1:47812  titleShown=True  enteredFlag=[]  savedName=[测试代号]
第 2 次: proxy=http://127.0.0.1:47812  titleShown=True  enteredFlag=[]  savedName=[测试代号]
```

`titleShown` 由页面元素判断，`savedName` 是 `localStorage` 里的代号——跨启动都在，标题页每次都出现。
## 工作原理（为什么不直接开浏览器地址）

客户端进程里跑一个**只监听 127.0.0.1 的反向代理**，窗口打开 `http://127.0.0.1:<随机端口>/`：

| 请求 | 处理 |
|---|---|
| `/assets/…`、`/fonts/…`、`/media/…` | 打包了素材就直接读本地文件（`/assets/~<hash>/…` 的哈希段会被剥掉）；本地没有就转发 |
| 其它一切（HTML/JS、`/data/*.json`、`/packs`、`/api/profile`） | 原样转发给真正的服务器，状态码/头/流都保留 |
| `/ws`（WebSocket 升级） | 用 upgrade 透传，对局照常联机 |

这样页面和代理同源，游戏的绝对路径、CSP、账号同步、断线重连都不用改；也不用碰 Chromium 的网络层
（Electron 44 里 `protocol.handle('http')` 会让主页面直接加载失败，已弃用该方案）。

素材地址是带内容哈希的（`/assets/~<hash>/…`），所以：
- 本地有 → 命中磁盘，不发网络请求；
- 服务器更新了素材 → 地址里的哈希变了，本地找不到 → 自动回落成网络请求，不会 404。

## 开发时直接跑

```powershell
cd client
npm install                 # 首次（Electron 走国内镜像：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
npx electron .              # 打开窗口
npx electron . --devtools   # 带开发者工具
npx electron . --smoke      # 自检：加载页面、确认游戏启动、把结果写进 smoke-result.json 后退出
```

## 打包（发给朋友的那种）

```powershell
cd client

# 1) 轻量版：约 370 MB（zip 约 150 MB），素材首次从服务器下载并缓存在本机
powershell -ExecutionPolicy Bypass -File build\build-portable.ps1 -Zip

# 2) 含素材版：约 1.28 GB（zip 约 785 MB），进游戏不再下载素材
powershell -ExecutionPolicy Bypass -File build\build-portable.ps1 -WithAssets -Zip -OutDir dist-assets
```

产物：

```
dist\Stronghold Protocol\           轻量版绿色文件夹（另有一个 .lnk 快捷方式带 --no-sandbox）
dist\Stronghold Protocol.zip        轻量绿色版 zip（151 MB）
dist-assets\Stronghold Protocol\    含素材版（913 MB 素材在内）
dist-assets\Stronghold Protocol.zip 含素材绿色版 zip（785 MB）
dist-installer\Stronghold-Protocol-Setup-0.3.0.exe        单文件安装器 · 轻量（152 MB）
dist-installer\Stronghold-Protocol-Setup-0.3.0-full.exe   单文件安装器 · 含素材（767 MB）
```

## 发法一览

| 形态 | 大小 | 说明 |
|---|---|---|
| 单文件安装器 `...Setup-0.3.0.exe` | 152 MB | 双击就装：选目录 → 解压 → 快捷方式 + 控制面板条目；素材首次从服务器拉 |
| 单文件安装器 `...Setup-0.3.0-full.exe` | 767 MB | 同上，913 MB 素材在包内，进游戏不再下载素材 |
| 绿色版 zip · 轻量 | 151 MB | 解压 → `PLAY.bat` 直接跑，或 `INSTALL.bat` 装到本机 |
| 绿色版 zip · 含素材 | 785 MB | 同上，素材在包内 |

两个安装器都是**按用户安装、不需要管理员**（装到 `%LOCALAPPDATA%\Programs\Stronghold Protocol`），
不带启动器、**不依赖 NSIS、全程不使用 `%TEMP%`**：

* 安装器自身 = 一个 C# 小程序（`installer\Installer.cs`）+ Deflate 压缩的负载 + 16 字节页脚（`SPPKG001` + 偏移）；
  运行时直接把自己的负载解压到安装目录，所以不会碰临时目录，也不会重蹈 NSIS 的
  `Error writing temporary file`。
* 收尾（桌面/开始菜单快捷方式、控制面板条目）交给 `powershell.exe` 执行。
* 卸载入口是安装目录里的 `卸载.bat`（同样是走可信进程树），控制面板的「卸载」也指向它。
* 打包：`build\pack-installer.ps1`（详见下文）。

### 安装器界面

* 「安装到」+ 浏览，默认 `%LOCALAPPDATA%\Programs\Stronghold Protocol`；
* **自动建子文件夹**：选 `E:\`、`E:\Games`、`D:\Games\` 都会装到 `<所选目录>\Stronghold Protocol`，
  不会把几十个文件散在你选的那个目录（或盘根）里；已经指向 `…\Stronghold Protocol` 的路径不会被套成两层。
* 选了不允许写入的位置（盘符根目录、系统目录常被安全软件/组策略保护）会弹一条说明，建议改用默认目录或普通文件夹；
* **「创建桌面快捷方式」勾选框**（默认勾上；开始菜单里总会建一个，卸载项也在那儿）；
  * 命令行对应 `/NODESKTOP`；
* **预计占用 / 目标磁盘剩余**：体积直接从负载页脚读取（未压缩字节数），不够时会红字提示；
* 进度条 + 已写入文件数 + 文件名；装完可直接勾选启动。

### 关于「自动补完」

装完后安装器把收尾交给 `powershell.exe` 做一次；被这台机器的策略拦掉时，会再用 `ShellExecute`
让已在运行的 shell 跑一次补完脚本（约 3 秒内轮询注册表判断是否成功），仍不成功才提示「还需要一步」，
弹窗里给一个「打开安装目录」（确定）按钮，并给出 `完成安装.bat` 的完整路径。**双击它一次**即可补齐。

注意：`ShellExecute` 这条路在「连同子进程一起限制」的机器上同样会被拦（实测本机如此），
所以那种机器上仍需要点一次；普通机器上第一次 `powershell` 就过，弹窗根本不会出现。

早期版本在失败后还会尝试 `explorer.exe` 拉起补完脚本，结果在这类受限机器上 explorer 自己起不来，
弹出「Explorer.exe - 应用程序错误 0xc0000142（DLL 初始化失败）」。该做法已移除——
安装器现在不会再启动任何 explorer 进程（实测安装前后 explorer 进程数不变）。

实测本机（Kaspersky + 深信服终端管控）需要点一次 `完成安装.bat`；
在普通家用机器上一般第一次就过，不会看到任何提示。

### 快捷方式「消失」的几种情况

安装目录里现在有一个 **`修复快捷方式.bat`**：双击它就会把桌面图标、开始菜单项、控制面板条目重新建一遍
（它就是把收尾脚本再跑一次，强制建桌面图标）。任何外部原因删掉了快捷方式，点一下即可恢复。

我们软件里会删快捷方式的地方只有两处：

| 触发 | 行为 |
|---|---|
| 运行 `卸载.bat`（或控制面板「卸载」） | 删桌面图标 + 开始菜单组 + 注册表 + 安装目录 |
| ~~重装时没勾「创建桌面快捷方式」~~ | **以前会删掉已有的桌面图标，现在已改成只"这次不建"，绝不删除** |

如果你遇到"装完有、过一会儿没了"，通常是外部原因：杀软把指向未签名程序的快捷方式清掉、
手动整理桌面、或者桌面被 OneDrive 重定向（安装器写的是 shell 的真实桌面路径，卸载也是——这一条以前是硬编码
`%USERPROFILE%\Desktop`，已修）。个别情况下只是资源管理器没刷新，按 F5 或在桌面右键「刷新」即可。
### 如果装完没有桌面图标（并出现了「完成安装.bat」）

有些机器（实测这台：Kaspersky 环境）把「未签名程序的写入」限制在受保护位置（桌面、开始菜单、`%TEMP%`、注册表），
连它派生的子进程也受限。这时安装器会**正常装好文件**，但提示「部分步骤未完成」，并在安装目录留下：

* `完成安装.bat` —— 双击一次，补建快捷方式和控制面板条目（由 cmd 拉起，是受信任的进程树）；
* 补完之后就能用桌面/开始菜单图标启动，`卸载.bat` 也能用；
* 也可以完全不管它，直接用安装目录里的 `PLAY.bat` 启动游戏，功能一模一样。

### 旧版 NSIS 安装包（已归档）

之前那版 NSIS 安装包（107 MB / 669 MB）在系统 `%TEMP%` 被拦的机器上会报
`Error writing temporary file`（实测 `/SOLID lzma` 与 `zlib` 都一样，说明是 NSIS 启动器机制，脚本改不掉）。
新写的手写安装器彻底不碰 `%TEMP%`，所以 NSIS 版已移到 `.build-installer\legacy\` 归档，不再作为交付物。
## 重新打安装器

```powershell
# 1) 先出绿色版（安装器的负载就是它）
powershell -ExecutionPolicy Bypass -File build\build-portable.ps1                                        # 轻量
powershell -ExecutionPolicy Bypass -File build\build-portable.ps1 -WithAssets -Zip -OutDir dist-assets    # 含素材

# 2) 打包成单文件安装器（会先编译 installer\Installer.cs 和 Uninstaller.cs）
powershell -ExecutionPolicy Bypass -File build\pack-installer.ps1 `
  -SourceDir "dist\Stronghold Protocol" -OutFile "dist-installer\Stronghold-Protocol-Setup-0.3.0.exe"

powershell -ExecutionPolicy Bypass -File build\pack-installer.ps1 `
  -SourceDir "dist-assets\Stronghold Protocol" -OutFile "dist-installer\Stronghold-Protocol-Setup-0.3.0-full.exe"
```

负载格式（`installer\Installer.cs` 与 `build\pack-installer.ps1` 两处要一起改）：

```
exe = [csc 编出的安装器] + [Deflate 流：每条 = int32 路径长度 + UTF-8 路径 + int64 大小 + 内容] + ["SPPKG001" + int64 负载偏移]
```

轻量 152 MB（369 MB 负载，约 12 秒）；含素材 767 MB（1.28 GB 负载，约 95 秒）。

打包脚本会：复制 Electron 运行时 → 放入本项目文件 →（可选）把 `public/assets`、`public/fonts` 复制进
`resources\app` → 改名成 `Stronghold Protocol.exe` → **用 rcedit 把图标和版本信息写进 exe** →
写 `PLAY.bat`、`README.txt`、`BUILD.txt` → 生成带图标的快捷方式 →（可选）打 zip。

## 签名（Authenticode）

两个安装包当前是**自签名**的（`signing\stronghold-codesign.cer`，CN=Stronghold Protocol，2029 年到期）：

| 情况 | 表现 |
|---|---|
| 机器上装了这张证书（双击 `signing\信任证书.bat`） | 安装包和客户端显示「已验证的发布者：Stronghold Protocol」 |
| 没装证书（例如朋友的机器） | 和未签名一样：显示「未知发布者」；自签名不会让它**更糟**，但也不能消除提示 |

生成 / 签名 / 让本机信任：

```powershell
# 生成（已有则复用）自签名代码签名证书，导出 signing\*.cer + *.pfx
powershell -ExecutionPolicy Bypass -File build\make-cert.ps1

# 本机信任（装进「受信任的根」+「受信任的发布者」）
certutil -user -addstore Root "signing\stronghold-codesign.cer"
certutil -user -addstore TrustedPublisher "signing\stronghold-codesign.cer"

# 签名（必须在打包之后：负载一变签名就失效）
powershell -ExecutionPolicy Bypass -File build\sign-installers.ps1 -Files "dist-installer\*.exe"

# 或者打包时直接签
powershell -ExecutionPolicy Bypass -File build\pack-installer.ps1 `
  -SourceDir "dist\Stronghold Protocol" -OutFile "dist-installer\Stronghold-Protocol-Setup-0.3.0.exe" -Sign
```

要让**朋友的机器**也不弹「未知发布者」，只有两条路：

1. **买正式的代码签名证书**（CA 签发，DigiCert/Sectigo/SSL.com 等，约 ¥1500–4000/年）。2023 年后私钥必须放在硬件
   token / 云 HSM 里，签名时用厂商工具或 `signtool sign /f cert.pfx /p *** /tr http://timestamp.digicert.com /td sha256`。
   拿到证书后把 `-Pfx` 指向它即可，其它流程不变：`build\sign-installers.ps1 -Files "..." -Pfx cert.pfx -PfxPassword ***`。
2. **Azure Trusted Signing**（微软的云签名服务，约 $9.9/月，需要企业/个人身份验证），CI 里调 API 签名，签出来的
   证书被 Windows/SmartScreen 普遍信任。

另外两点实测结论：

* 签名**不会**改变这台机器上 Chromium 渲染沙箱被拦的问题（签过名的客户端 exe 不加 `--no-sandbox` 仍然启动失败），
  所以 `PLAY.bat` 还得留着；
* 签名后安装器的页脚位置会变化（Authenticode 签名块追加在文件末尾），安装器已改成从尾部往前扫 `SPPKG001`
  定位负载，实测签名前后都能正常安装。
## 两种启动方式（`README.txt` 里也写了）

- **`PLAY.bat`（推荐）**：带 `--no-sandbox` 启动。
- `Stronghold Protocol.exe`：标准启动（启用 Chromium 渲染沙箱）。

为什么要有 `PLAY.bat`：有些机器（杀软、组策略、部分虚拟桌面）会拦掉 Chromium 的渲染沙箱，双击 exe 会**一闪就退**。
实测本机（装 Kaspersky）就是这样：连最小的 Electron 例子都起不来，加 `--no-sandbox` 就正常。
`PLAY.bat` 里那个开关就是为这类机器准备的；在正常机器上用它也完全没问题。

## 快捷方式图标（踩过的两个坑）

装完的桌面/开始菜单快捷方式，`IconLocation` 现在指向 **exe 本身**（构建时已用 rcedit 把图标写进 exe 资源），
而不是 `resources\app\icon.ico`。原因是实测这台机器的外壳：

| IconLocation 写法 | 效果 |
|---|---|
| `<安装目录>\resources\app\icon.ico,0` | **白纸图标**（无论 .ico 是 PNG 条目还是传统 DIB 条目） |
| `<安装目录>\.\Stronghold Protocol.exe,0`（带 `\.\`） | **白纸图标** |
| `<安装目录>\Stronghold Protocol.exe,0`（干净路径） | ✓ 正常显示 |

所以两处都改了：`_finish.ps1` 里图标改用 `$exe`，并在脚本开头用 `[IO.Path]::GetFullPath($Dir).TrimEnd('\')`
把 `完成安装.bat` 传进来的 `%~dp0.` 规范化（否则 IconLocation 里会留下 `\.\` 段）。
`icon.ico` 仍然打进包里（rcedit 用它写 exe 资源、便携版 `-WithIcon` 之类还会用到），只是不再作为快捷方式的图标来源。
## 图标

`icon.png`（512）、`icon-256.png`、`icon.ico`（16/24/32/48/64/128/256）由 `build/make-icon.py` 生成：
大尺寸用标题画面那枚 13×14 点阵瞭望塔（含 4 颗薄荷色"眼睛"），
32px 以下自动换成 2×2 合并的粗点阵，否则缩到任务栏大小会糊成一团。

窗口图标由 `BrowserWindow({ icon })` 设置；桌面/开始菜单的图标来自 `.lnk` 的 `IconLocation`。
Windows 资源管理器里直接看 exe 的图标仍是 Electron 自带的（要彻底改需要 rcedit 之类的工具改 exe 资源，暂未做）。

## 小提示

- 窗口大小/位置会记住；`F11` 全屏、`Ctrl+R` 重载、`F12` 开发者工具。
- 重复双击只会把已有窗口叫到前面（单实例）。
- 服务器地址变了：改 `config.json` 的 `server`，重启客户端（也可用环境变量 `SP_SERVER`）。
- 连不上服务器时显示离线页，主进程每 5 秒重试，恢复后自动进入。
- 游戏在服务端更新时**不需要**重发客户端；只有素材大改才需要重新打 `-WithAssets` 的包。
