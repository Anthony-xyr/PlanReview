# PlanReview - 个人计划与时间复盘助手

<div align="center">

一款基于 Electron 的桌面应用,帮助你高效管理个人计划、实时追踪时间投入,并通过 AI 深度复盘优化时间利用效率。

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Version](https://img.shields.io/badge/version-0.3.0-orange)

</div>

## ✨ 核心特性

### 📝 速记收集
- **悬浮窗快速输入** - 置顶悬浮窗,随时记录灵感
- **全局快捷键** (Windows `Alt+Shift+Space` / macOS `Option+Shift+Space`) - 任何场景下快速唤起
- **AI 智能解析** - 自动提取日期、估时、类别、标签
- **纠正与习惯学习** - AI 理解错了可以「纠正」，确认后记住你的写法，以后照着解析
- **游戏模式** - 全屏时自动隐藏悬浮窗

### ⏱️ 时间轴管理
- **计划与实际对照** - 双列时间轴可视化对比
- **拖拽式排程** - 直观的拖拽操作安排任务
- **实时计时 + 事后补录** - 灵活的时间记录方式
- **冲突检测** - 自动提示时间冲突和可用时段

### 🎓 课表导入
- **多格式支持** - 截图、PDF、Excel 均可识别，包括教务系统导出的中文 PDF
- **AI 智能解析** - 自动换算具体上课时间
- **预览确认** - 导入前可编辑校对

### 🔔 智能提醒
- **到点轻提醒** - 三选一操作(结束/延长/拆分)
- **延长影响分析** - 显示对其他计划的影响
- **睡眠窗口强提醒** - 保护睡眠时间
- **自习室收尾流程** - 引导记录下一步

### 📊 复盘分析
- **每日快速复盘** - 2-3 分钟确认记录
- **每周深度复盘** - AI 生成统计图表和改进建议
- **个人画像** - 长期积累的时间使用规律
- **AI 排程建议** - 基于画像的智能排程

### 🎨 界面
- **深色模式** - 跟随系统，也可以固定为浅色或深色
- **类别管理** - 自定义类别的名称、颜色和顺序，按类别查看和修改任务

### 🎯 找回机制
- **下次查看日** - 到期自动浮现
- **随机推送** - 每日从待办中抽取提醒
- **收件箱整理** - 积压时自动提示

## 🚀 快速开始

### 环境要求

- Windows 10/11，或 macOS 13+
- 从源码构建需要 Node.js 22.13.0 或更新的 22.x 版本，也支持 24.x 和 26+。CI 使用 22.x。

### 安装

#### 方式一: 下载安装包 (推荐)

前往 [Releases](https://github.com/Anthony-xyr/PlanReview/releases) 页面下载对应平台的文件。

**Windows**

1. 下载 `PlanReview-Setup-x.x.x.exe`
2. 运行安装程序
3. 首次运行时 Windows SmartScreen 会提示"未知发布者",点击"更多信息" → "仍要运行"

**macOS**

1. 下载 `PlanReview-x.x.x-arm64.dmg`（Apple Silicon）或 `PlanReview-x.x.x-x64.dmg`（Intel）
2. 打开 dmg，把 `PlanReview.app` 拖进「应用程序」（Dock 和菜单栏里显示的名字是「计划与复盘」）
3. 没有 Apple 开发者签名，首次打开会被 Gatekeeper 拦住。macOS 15 Sequoia 及更新版本（包括 macOS 26）
   右键「打开」已经不再有效：先点弹窗里的「完成」，再到 **系统设置 → 隐私与安全性**，在安全区域点
   「仍要打开」。也可以直接在终端执行：
   `xattr -dr com.apple.quarantine /Applications/PlanReview.app`
   macOS 14 及更早版本则可以在「应用程序」里右键 →「打开」。

#### 自动更新

**0.2.0 及更早版本需手动安装一次 0.3.0**，以后可在「设置 → 软件更新」检查更新或关闭自动检查。
Windows 在后台下载正式更新；可选择「重启并更新」，或稍后在下次正常退出时安装。更新不替换记录数据库，安装前会尝试保留一份备份。
Mac 只检查并提示前往发布页手动下载；开发版不会联网检查。

#### 方式二: 从源码构建

```bash
# 克隆仓库
git clone https://github.com/Anthony-xyr/PlanReview.git
cd PlanReview

# 安装依赖
npm install

# 开发模式运行
npm run dev

# 构建生产版本
npm run build

# 打包当前平台的安装包
npm run dist

# 或者只打指定平台
npm run dist:win   # Windows：dist/PlanReview-Setup-x.x.x.exe
npm run dist:mac   # macOS：dist/PlanReview-x.x.x-<arch>.dmg
```

macOS 打包时需要 Xcode Command Line Tools（`xcode-select --install`），dmg 由系统自带的
`hdiutil` 生成。产物是当前 Mac 的架构：Apple Silicon 出 arm64，Intel 出 x64。

`koffi` 是 Windows 专用的可选依赖。macOS 上安装依赖时如果看到它的安装脚本失败并提示
`reify failed optional dependency ... koffi`，可以忽略：应用在 macOS 上不会加载它。

构建前要确保环境里没有 `NODE_ENV=production`：它会让 `npm ci` 跳过 devDependencies，
只装运行时依赖，后面 `npm run build` / `dist` 会失败。PowerShell 用
`Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue`，bash 用 `unset NODE_ENV`。

Electron 44 不在 `npm ci` 阶段下载二进制（它的包里没有 postinstall），首次
`npm run dev` 或 electron-builder 会按需下载。离线环境可以手动执行
`node node_modules/electron/install.js`，必要时先设置 `ELECTRON_MIRROR`。

### 首次配置

1. **设置 AI 服务** (可选,用于速记解析、课表导入、周复盘)
   - 打开设置 → AI 配置
   - 填写 OpenAI 兼容的 API 信息(Base URL、API Key、模型名)
   - 支持主流服务商(OpenAI、DeepSeek、通义千问等)
   - 可以为速记解析、课表识别、排时间、周复盘分别设置推理强度(Low / Medium / High)

2. **配置时间偏好**
   - 设置一天起点时间(默认 5:00)
   - 设置睡眠窗口(默认 23:00-07:00)
   - 配置课程表和常用学习时间

3. **自定义类别与标签**
   - 在「类别」页点「管理类别」，创建适合自己的类别(如学习、项目、生活)
   - 设置标签体系

## 📖 使用指南

### 基本工作流

1. **收集** - 通过悬浮窗或快捷键快速记录想法
2. **整理** - 在收件箱中完善任务信息
3. **安排** - 拖拽任务到今日时间轴
4. **执行** - 点击开始计时,专注工作
5. **复盘** - 每日/每周查看分析报告,持续改进

### 快捷键

- Windows：`Alt+Shift+Space`
- macOS：`Option+Shift+Space`
- 可以在设置里改成自己的组合键；macOS 上按 `Command`/`Option` 录制的组合键会自动保存为
  `Command+...`/`Option+...`
- 悬浮窗可拖动到任意位置

### 数据存储

- Windows：`%APPDATA%\plan-review\plan-review.db`
- macOS：`~/Library/Application Support/plan-review/plan-review.db`
- 开发版和安装版共用同一数据库
- 卸载软件不会删除数据

### 平台差异（macOS）

- **菜单栏图标**：macOS 使用单色模板图标，跟随系统深浅色自动反色；计时中会变成实心图标。
- **托盘交互**：macOS 点击菜单栏图标直接弹出菜单（第一项是打开主窗口）；Windows 左键直接打开主窗口。
- **全屏隐藏**：macOS 不申请屏幕录制/辅助功能权限，而是利用系统的全屏桌面（Space）隔离：
  标准的原生全屏（绿色按钮、Safari/QuickTime 全屏、多数游戏）会进入独立桌面，悬浮窗默认不跟过去；
  睡眠强提醒或主动唤出时，悬浮窗会临时显示在全屏内容上。提醒结束、手动隐藏或开始/停止本次计时后恢复默认策略。
  关掉设置里的「全屏应用时隐藏悬浮窗」后，悬浮窗或顶部计时条可跟进全屏桌面；遮盖全屏期间 Dock 图标会暂时隐藏。
  **无边框全屏**（覆盖整屏但不新建 Space 的部分游戏/网页视频）仍在同一桌面，悬浮窗会保留，
  macOS 侧不会自动隐藏；要精确检测这类窗口需要屏幕录制权限和额外原生代码。
  Windows 使用系统通知状态接口检测全屏状态。
- **开机自启**：macOS 的登录项不接收启动参数，用系统的 `wasOpenedAtLogin` 判断，自启时只显示悬浮窗、不弹主窗口。
  需要把 `PlanReview.app` 放在「应用程序」里再勾选，系统会把它登记为登录项；放在 Downloads 等位置可能被 macOS 拒绝。
- **单实例**：两个平台都用 `requestSingleInstanceLock`，重复启动会唤回已有窗口。
- **系统版本**：安装包的 `LSMinimumSystemVersion` 是 13.0，Electron 44 的框架 `minos` 也是 13.0，
  所以在 macOS 13 及以上（含 macOS 26 Tahoe）都能运行。当前只在 macOS 15.7 上实测过；macOS 26 未实测。

## 🛠️ 技术栈

- **桌面框架**: Electron 44.7
- **前端**: React 19.3 + TypeScript 7.0
- **构建工具**: electron-vite + Vite 8.3
- **数据库**: SQLite
- **AI 集成**: OpenAI 兼容 API
- **其他依赖**: 
  - xlsx - Excel 解析
  - pdfjs-dist - PDF 处理
  - koffi - Windows 原生 API 调用（可选依赖，只在 Windows 上加载；macOS 不需要）

## 📁 项目结构

```
PlanReview/
├── src/
│   ├── main/           # Electron 主进程
│   │   ├── ai/        # AI 相关功能
│   │   ├── db/        # 数据库层
│   │   └── index.ts   # 主进程入口
│   ├── renderer/       # React 渲染进程
│   │   ├── components/ # UI 组件
│   │   └── float/     # 悬浮窗
│   ├── preload/        # 预加载脚本
│   └── shared/         # 共享类型和工具
├── resources/          # 应用资源(图标等)
└── electron-builder.yml # 打包配置
```

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request!

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 提交 Pull Request

## 📝 开发计划

- [x] M1: 基础数据模型与任务管理
- [x] M2: 今日时间轴与计时功能
- [x] M3: 悬浮窗与提醒系统
- [x] M4: AI 接入与智能解析
- [x] M5: 找回机制与每日复盘
- [x] M6: 周复盘与个人画像
- [x] 界面视觉优化与深色模式(v0.2.0)
- [ ] 移动端支持(基于 Capacitor)
- [ ] 云端同步功能

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情

## 🙏 致谢

感谢所有为本项目提供建议和反馈的用户!

---

<div align="center">

**如果觉得这个项目有帮助,请给个 ⭐️ Star 支持一下!**

</div>
