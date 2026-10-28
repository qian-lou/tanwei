# 迁移契约参考

这里保留原 Host 的纯 TypeScript 行为与测试，作为 Rust 迁移的回归参考及 golden fixtures 生成输入。它们不参与应用构建或发布，也不依赖 Electron、Node gRPC、SSH 或 Kubernetes 运行时。

实际桌面 Host 位于 `src-tauri/src`，其 SQLite、网络、会话和制品流程由 Rust 测试与原生桌面端到端测试验证。Action 目录统一来自 `src/shared/action-catalog.ts`；不要在参考实现中另建契约。
