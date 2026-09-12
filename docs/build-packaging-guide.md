# 日迹 Android 与 Windows 桌面体验版打包指南

本文用于以后在 Windows 开发机上重新构建日迹 v0.10.x 的 Android debug APK 和 Windows Electron portable 体验版。

当前技术结构：

- Web 前端：React + Vite。
- Windows 桌面端：Electron（内置 Chromium）+ FastAPI sidecar + SQLite。
- Android：Capacitor + Android WebView + `@capacitor-community/sqlite`。
- 两端数据库相互独立，通过逻辑 JSON 数据包手动迁移数据。

JSON 数据包 schema_version 为 0.10.0，包含时间块及属性；仍接受 0.6.0 旧包并跳过旧实际日程。

## 你需要的知识

不要求全部精通。第一次打包前，至少应理解下面这些概念：

1. **PowerShell 与基本命令行**
   - 会切换目录、设置环境变量、阅读命令退出码和错误输出。
   - 学习：[PowerShell 官方文档](https://learn.microsoft.com/powershell/)

2. **Node.js、npm、React 与 Vite**
   - npm 安装前端及打包依赖；Vite 把 React 源码构建为 `frontend/dist` 静态资源。
   - 学习：[Node.js 入门](https://nodejs.org/en/learn/getting-started/introduction-to-nodejs)、[React 学习文档](https://react.dev/learn)、[Vite 入门](https://vite.dev/guide/)、[Vite 生产构建](https://vite.dev/guide/build)

3. **Electron 的主进程、渲染进程和应用打包**
   - 日迹桌面端由 Electron 打开 Chromium 窗口，并启动独立 FastAPI sidecar。
   - 学习：[Electron 官方介绍与教程](https://www.electronjs.org/docs/latest/)、[Electron 第一个应用](https://www.electronjs.org/docs/latest/tutorial/tutorial-first-app)

4. **Python 虚拟环境、FastAPI 和 PyInstaller**
   - FastAPI 提供桌面端本地 API；PyInstaller 把 Python 后端及依赖封装为 `riji-sidecar.exe`。
   - 学习：[Python venv](https://docs.python.org/3/library/venv.html)、[FastAPI 官方教程](https://fastapi.tiangolo.com/tutorial/)、[PyInstaller 使用指南](https://pyinstaller.org/en/stable/usage.html)

5. **Capacitor、Android WebView 与原生插件**
   - Capacitor 把 Vite 构建结果复制进 Android 工程；页面运行在系统 WebView 中，通过插件访问 SQLite、文件和分享能力。
   - 学习：[Capacitor 官方文档](https://capacitorjs.com/docs)、[Capacitor SQLite 插件](https://github.com/capacitor-community/sqlite)

6. **Android SDK、ADB、Gradle 和 JDK**
   - SDK Platform/Build Tools 用于编译，ADB 用于连接和安装到手机，Gradle 驱动 Android 构建，当前工程要求 JDK 21。
   - 学习：[Android sdkmanager](https://developer.android.com/tools/sdkmanager)、[Android Platform Tools / ADB](https://developer.android.com/tools/releases/platform-tools)、[Microsoft OpenJDK 21](https://learn.microsoft.com/java/openjdk/download)

7. **SQLite、UUID 和 JSON 数据迁移**
   - 每台设备使用自己的 SQLite；UUID 用于识别跨数据库的同一实体；JSON 导入是合并操作，不是实时同步。
   - 学习：[SQLite 官方文档](https://www.sqlite.org/docs.html)、[JSON 介绍](https://developer.mozilla.org/docs/Learn_web_development/Core/Scripting/JSON)

## 一、准备仓库和基础环境

以下命令都在仓库根目录执行：

```powershell
cd D:\cs\task
git branch --show-current
```

打包前确认自己位于准备发布的分支，不要误在 `main` 上直接开发。

建议环境：

- Windows 10/11 x64。
- Python 3.11 或更高版本。
- Node.js 22 或更高版本。
- npm。
- Android 构建额外需要 JDK 21、Android SDK Platform 36、Build Tools 和 Platform Tools。

检查版本：

```powershell
python --version
node --version
npm --version
java --version
```

如需新建 Python 虚拟环境：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
```

## 二、打包 Windows 桌面体验版

### 2.1 一条命令构建

```powershell
cd D:\cs\task
.\scripts\build-desktop.ps1 -PythonPath ".\.venv\Scripts\python.exe"
```

如果没有显式传 `-PythonPath`，脚本会依次寻找：

1. `backend/.venv/Scripts/python.exe`
2. `backend/.codex-venv/Scripts/python.exe`
3. `.venv/Scripts/python.exe`
4. 系统 `python`

Electron 下载不稳定时可指定镜像：

```powershell
.\scripts\build-desktop.ps1 `
  -PythonPath ".\.venv\Scripts\python.exe" `
  -ElectronMirror "https://npmmirror.com/mirrors/electron/"
```

### 2.2 脚本实际执行的流程

1. 按 `backend/requirements-desktop.txt` 安装桌面后端依赖。
2. 用 PyInstaller 把 `backend/desktop_sidecar.py` 构建为：

   ```text
   backend/dist/riji-sidecar.exe
   ```

3. 执行 `npm install` 和 `npm run build`，生成 Vite 前端资源。
4. electron-builder 将 Electron 主进程、前端资源和 sidecar 一起打入 Windows x64 portable。
5. 先在带时间戳的临时目录构建，成功后复制到稳定路径：

   ```text
   release/desktop/riji-desktop-0.10.0.exe
   ```

### 2.3 运行与验证

直接双击：

```text
release/desktop/riji-desktop-0.10.0.exe
```

至少检查：

- 能打开主窗口。
- 首页、项目、待办、日程和今日总结可访问。
- 新建数据后关闭并重新打开，数据仍存在。
- 设置页可以导出 JSON，并能预览、确认导入。
- 关闭桌面程序后，sidecar 不应继续长期占用后台。

桌面数据库通常位于：

```text
%APPDATA%\日迹\data\riji.db
```

sidecar 日志位于 Electron 的应用日志目录。启动失败时，错误对话框会显示实际日志路径。

### 2.4 桌面构建常见问题

**Electron 下载失败**

使用 `-ElectronMirror`，或检查代理和 npm 网络配置。

**稳定路径的 EXE 被占用**

先正常关闭所有日迹窗口，再确认任务管理器中没有日迹体验包残留，然后重新执行构建。不要按模糊名称批量结束其他程序。

**PyInstaller 缺少模块**

先确认使用了正确虚拟环境，再执行：

```powershell
.\.venv\Scripts\python.exe -m pip install -r .\backend\requirements-desktop.txt
```

**Windows SmartScreen 警告**

当前产物是未正式代码签名的体验版，出现未知发布者提示属于已知限制。正式发布前应购买或配置 Windows 代码签名证书。

## 三、打包 Android 体验版

### 3.1 安装 Android 构建环境

推荐安装：

- JDK 21。
- Android Studio，或者 Android SDK Command-Line Tools。
- `platform-tools`
- `platforms;android-36`
- `build-tools;36.0.0`

如使用命令行工具，`sdkmanager.bat` 通常位于：

```text
<Android SDK>\cmdline-tools\latest\bin\sdkmanager.bat
```

安装组件并接受许可证：

```powershell
$sdk = "C:\Android\Sdk"
$sdkmanager = "$sdk\cmdline-tools\latest\bin\sdkmanager.bat"

& $sdkmanager --sdk_root=$sdk --licenses
& $sdkmanager --sdk_root=$sdk `
  "platform-tools" `
  "platforms;android-36" `
  "build-tools;36.0.0"
```

本仓库当前开发机还可以直接使用已经放在仓库下、但被 Git 忽略的工具：

```text
.android-sdk
.jdk-21
.downloads\gradle-dist
```

这些目录不会提交到 Git；换电脑后需要重新安装或重新复制。

### 3.2 一条命令构建

使用仓库内工具：

```powershell
cd D:\cs\task

.\scripts\build-android.ps1 `
  -AndroidSdk ".\.android-sdk"
```

使用系统安装路径：

```powershell
.\scripts\build-android.ps1 `
  -AndroidSdk "C:\Android\Sdk" `
  -JavaHome "C:\Program Files\Microsoft\jdk-21"
```

如果系统 Gradle Wrapper 下载不稳定，可以显式指定 Gradle：

```powershell
.\scripts\build-android.ps1 `
  -AndroidSdk "C:\Android\Sdk" `
  -JavaHome "C:\Program Files\Microsoft\jdk-21" `
  -GradlePath "C:\Gradle\gradle-8.14.3\bin\gradle.bat"
```

### 3.3 脚本实际执行的流程

1. 检查 Android SDK 路径。
2. 检查 JDK，并拒绝低于 21 的版本。
3. 执行 `npm install`。
4. 执行 `npm run android:sync`：
   - Vite 构建 React 前端。
   - Capacitor 把 `frontend/dist` 同步到 Android 工程。
   - 更新 SQLite、Filesystem 和 Share 插件配置。
5. 以单工作线程执行 Gradle `assembleDebug`，减少开发机资源竞争。
6. 生成并复制 APK：

   ```text
   frontend/android/app/build/outputs/apk/debug/app-debug.apk
   release/android/riji-android-0.10.0-debug.apk
   ```

### 3.4 安装到实体手机

开启开发者选项和 USB 调试，连接手机后执行：

```powershell
$adb = ".\.android-sdk\platform-tools\adb.exe"

& $adb devices
& $adb install -r ".\release\android\riji-android-0.10.0-debug.apk"
```

`adb devices` 应显示：

```text
设备序列号    device
```

如果显示 `unauthorized`，解锁手机并接受 USB 调试授权。

也可以把 APK 复制到手机，在文件管理器中打开，并允许该文件管理器“安装未知应用”。

### 3.5 Android 验证清单

至少跑通：

1. 创建项目，填写 DDL、颜色和描述。
2. 在项目下创建待办，设置 DDL、提醒天数、分类、状态和备注。
3. 编辑待办并完成它。
4. 创建属于该项目的计划日程。
5. 在今日总结看到完成记录并保存日志。
6. 强制结束应用或划掉后台，再次打开确认数据仍存在。
7. 导出 JSON 到下载目录或分享给自己。
8. 选择该 JSON，检查预览数量并确认合并导入。

查看日志：

```powershell
& $adb logcat -c
& $adb logcat | Select-String "com.riji.app|Capacitor|SQLite|AndroidRuntime"
```

### 3.6 Android 构建常见问题

**提示 JDK 版本不足**

确认 `java --version` 和传给脚本的 `-JavaHome` 都指向 JDK 21。

**找不到 Android SDK**

传入 `-AndroidSdk`，或设置：

```powershell
$env:ANDROID_HOME = "C:\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
```

**许可证未接受**

```powershell
& "C:\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" --licenses
```

**`INSTALL_FAILED_UPDATE_INCOMPATIBLE`**

手机已有相同包名但签名不同的版本。先从旧版导出 JSON；确认备份后再卸载。卸载会清除应用内部数据库：

```powershell
& $adb uninstall com.riji.app
& $adb install ".\release\android\riji-android-0.10.0-debug.apk"
```

**Gradle 内存、文件移动或缓存问题**

当前脚本已经使用 `--no-daemon --no-parallel --max-workers=1`。仍失败时，确认磁盘空间、杀毒软件拦截和 Gradle 缓存目录权限。

## 四、数据同步现在做到哪一步

### 结论

当前已经做到**不同设备、不同底层数据库之间的手动 JSON 迁移**，不只是电脑与电脑互传。

已经验证的路径是：

```text
Android 本地 SQLite
  → 导出 JSON
  → Windows FastAPI + SQLite 导入
  → Windows 再导出 JSON
  → Android 预览并合并导入
```

因此目前能力可以这样理解：

| 场景 | 当前状态 |
| --- | --- |
| Windows 电脑 A → Windows 电脑 B | 支持，通过 JSON 文件手动迁移 |
| 浏览器/FastAPI 版 → Windows Electron 版 | 支持，只要数据包为 `schema_version: 0.6.0` |
| Windows 桌面端 → Android | 支持，已完成往返验证 |
| Android → Windows 桌面端 | 支持，已完成往返验证 |
| Android 手机 A → Android 手机 B | 数据协议支持；通过文件分享/保存后导入，建议在实体手机上再做一次兼容性验证 |
| 自动后台同步 | 不支持 |
| 登录账号同步 | 不支持 |
| 多端实时同步和冲突协商 | 不支持 |

### 当前“同步”的准确名称

它更准确地叫：

- 数据导出/导入。
- 手动迁移。
- 手动备份与恢复的基础版本。

它还不能叫真正的多端同步，因为系统没有：

- 账号或设备身份。
- 云端同步服务。
- 自动上传、拉取和增量同步。
- 删除墓碑。
- 多端并发修改后的完整冲突解决。
- 端到端加密和同步状态页面。

### JSON 当前覆盖范围

数据包覆盖：

- 项目。
- 待办。
- 计划日程。
- 实际时间块及属性分类。
- 每日总结。
- 日志模板。
- 计时会话。
- 重复规则。

核心实体使用 UUID。关系字段在数据包内也使用 UUID，在目标设备写入 SQLite 时重新映射为该设备自己的整数 ID。

合并规则：

- 相同 UUID：导入包内容优先。
- 本地存在、但数据包里没有的实体：保留；同日期重叠的时间块由导入包覆盖。
- 每日总结还会按日期识别旧数据冲突。
- 导入前显示各实体的新增和更新数量。
- Android 导入在一个外层事务中执行，失败时回滚。

默认不导出：

- AI API Key。
- ZJU 密码。
- Pintia Cookie。
- Session。
- token。
- 其他敏感凭据。

### 实际迁移步骤

源设备：

1. 设置 → 数据导入导出。
2. 点击“导出 JSON”。
3. 把文件保存到可靠位置。
4. 通过数据线、局域网传输、网盘或聊天工具传给目标设备。

目标设备：

1. 设置 → 数据导入导出。
2. 点击“选择 JSON 导入”。
3. 查看 `schema_version` 及新增/更新数量。
4. 确认文件来源和预览数量正确。
5. 点击“确认合并导入”。
6. 刷新页面并检查项目、待办、日程和今日总结。

导入前仍建议先导出目标设备自己的备份。当前是体验版，不应把唯一一份重要数据只保存在一个设备中。

## 五、体验版限制

测试版暂不可完整体验的功能、Android v0.6 边界和已知限制已经集中记录在：

- [`docs/v0.6-packaging.md`](./v0.6-packaging.md) 的“Android v0.6 已知限制”和验收记录。

这里不重复展开。与打包直接相关的限制是：

- Android APK 使用 debug 签名，不是应用商店发布包。
- Windows portable 尚未正式代码签名。
- 没有自动更新机制。
- 尚未覆盖完整实体手机型号矩阵。
- Android 与桌面数据相互独立，只能通过 JSON 手动迁移。

## 六、每次打包后的交付检查

```powershell
git branch --show-current
git status --short

Get-FileHash ".\release\android\riji-android-0.10.0-debug.apk" -Algorithm SHA256
Get-FileHash ".\release\desktop\riji-desktop-0.10.0.exe" -Algorithm SHA256
```

记录：

- 当前 Git 分支和提交。
- Node、Python、JDK、Android SDK 版本。
- APK/EXE 的 SHA-256。
- 实际测试手机型号和 Android 版本。
- 是否完成冷启动持久化。
- 是否完成一次 JSON 导出、预览和导入。
- 本次新增的已知问题。

不要提交以下本机构建内容：

```text
.android-sdk/
.android-avd/
.jdk-21/
.downloads/
.gradle-cache/
backend/build/
backend/dist/
release/
```
