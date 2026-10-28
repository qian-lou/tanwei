# 探微 v0.3.0

桌面运行时迁移到 Tauri 2 + Rust，保留原有 React 工作台和 JVM Agent。安装后的应用不再运行 Electron 或 Node.js。

- 提供 macOS Apple Silicon、macOS Intel、Windows x64、Linux x64 安装包。
- Rust Host 承担本机 Attach、SSH、Kubernetes、mTLS Relay、诊断会话、SQLite 工作区和制品管理。
- 保留原有工作区位置、案例、审计和诊断制品。
- 所有自动更新产物使用独立的 Tauri 更新密钥签名，附带更新清单和 SHA-256 校验文件。

macOS 包使用探微固定自签名证书，未经过 Apple 公证；Windows 包不使用受信任 Authenticode 签名。系统可能提示发布者或来源未经验证。

macOS 最低版本为 13.3。首次从 Electron 版本升级请下载安装包完整安装，后续 Tauri 版本使用新的更新通道。
