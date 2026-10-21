# PlanReview - 个人计划与时间复盘助手

<div align="center">

一款基于 Electron 的桌面应用,帮助你高效管理个人计划、实时追踪时间投入,并通过 AI 深度复盘优化时间利用效率。

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Version](https://img.shields.io/badge/version-0.1.0-orange)

</div>

## ✨ 核心特性

### 📝 速记收集
- **悬浮窗快速输入** - 置顶悬浮窗,随时记录灵感
- **全局快捷键** (Alt+Shift+Space) - 任何场景下快速唤起
- **AI 智能解析** - 自动提取日期、估时、分类、标签
- **游戏模式** - 全屏时自动隐藏悬浮窗

### ⏱️ 时间轴管理
- **计划与实际对照** - 双列时间轴可视化对比
- **拖拽式排程** - 直观的拖拽操作安排任务
- **实时计时 + 事后补录** - 灵活的时间记录方式
- **冲突检测** - 自动提示时间冲突和可用时段

### 🎓 课表导入
- **多格式支持** - 截图、PDF、Excel 均可识别
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

### 🎯 找回机制
- **下次查看日** - 到期自动浮现
- **随机推送** - 每日从待办中抽取提醒
- **收件箱整理** - 积压时自动提示

## 🚀 快速开始

### 环境要求

- Windows 10/11
- Node.js 22.11+

### 安装

#### 方式一: 下载安装包 (推荐)

1. 前往 [Releases](https://github.com/Anthony-xyr/PlanReview/releases) 页面
2. 下载最新版本的 `PlanReview-Setup-x.x.x.exe`
3. 运行安装程序
4. 首次运行时 Windows SmartScreen 会提示"未知发布者",点击"更多信息" → "仍要运行"

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

# 打包安装程序
npm run dist
```

### 首次配置

1. **设置 AI 服务** (可选,用于速记解析、课表导入、周复盘)
   - 打开设置 → AI 配置
   - 填写 OpenAI 兼容的 API 信息(Base URL、API Key、模型名)
   - 支持主流服务商(OpenAI、DeepSeek、通义千问等)

2. **配置时间偏好**
   - 设置一天起点时间(默认 5:00)
   - 设置睡眠窗口(默认 23:00-07:00)
   - 配置课程表和常用学习时间

3. **自定义大类与标签**
   - 创建适合自己的任务分类(如学习、项目、生活)
   - 设置标签体系

## 📖 使用指南

### 基本工作流

1. **收集** - 通过悬浮窗或快捷键快速记录想法
2. **整理** - 在收件箱中完善任务信息
3. **安排** - 拖拽任务到今日时间轴
4. **执行** - 点击开始计时,专注工作
5. **复盘** - 每日/每周查看分析报告,持续改进

### 快捷键

- `Alt+Shift+Space` - 全局唤起速记输入
- 悬浮窗可拖动到任意位置

### 数据存储

- 数据库位置: `%APPDATA%\plan-review\plan-review.db`
- 开发版和安装版共用同一数据库
- 卸载软件不会删除数据

## 🛠️ 技术栈

- **桌面框架**: Electron 44.7
- **前端**: React 19.3 + TypeScript 7.0
- **构建工具**: electron-vite + Vite 8.3
- **数据库**: SQLite
- **AI 集成**: OpenAI 兼容 API
- **其他依赖**: 
  - xlsx - Excel 解析
  - pdfjs-dist - PDF 处理
  - koffi - Windows 原生 API 调用

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
- [ ] 界面视觉优化
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
