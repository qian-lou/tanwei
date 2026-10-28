<p align="center">
  <img src="apps/desktop/packaging/icon.svg" width="112" alt="探微图标" />
</p>

<h1 align="center">探微（Tanwei）</h1>

<p align="center">
  源码开放、仅限非商业使用的 JVM Runtime Workbench
</p>

探微是一款面向 Java 开发者和生产支持团队的桌面诊断工具。它把 JVM 目标发现、在线诊断、
性能分析、长时任务与诊断证据组织在同一个工作台中，并通过类型化 Action 和分级策略控制
诊断成本与运行时风险。

> 当前版本为 `0.3.0`，处于积极开发阶段。核心诊断闭环已经可用，协议和扩展 API 在
> `1.0.0` 前仍可能调整。

## 为什么选择探微

- **Local-first**：工作区、审计、案例和诊断制品默认保存在本机。
- **源码可审阅**：允许在非商业目的下使用、研究、修改和分发。
- **一体化工作台**：从目标接入、实时观测到制品归档，不需要在多个工具间切换。
- **结构化诊断**：Host 与 Agent 使用版本化 Protobuf/gRPC 和 Action Contract 通信，
  不向目标 JVM 透传任意文本命令。
- **风险可控**：操作按 R0—R4 分级，高成本或修改类操作需要预检、限额和确认。
- **证据优先**：结果经过 Host 校验、哈希和原子落盘后，才能成为可跨会话引用的制品。

## 核心能力

- 本机 JVM、SSH、Kubernetes 与 mTLS 持久 Relay 目标接入
- CPU、Heap、GC、线程、锁、类加载、JIT、PerfCounter 与运行时配置检查
- 方法观测、源码行探针、调用快照、Monitor 与跨类 Trace
- async-profiler、JFR、Heap Dump、火焰图与 Heap 对象分析
- MBean、JUL、Logback、Log4j 1.x/2 检查与受控修改
- 活动任务、诊断审计、不可变制品、案例和签名诊断模板

实际可用能力取决于目标 JDK、连接方式、Agent 能力声明和本机/团队策略。

## 快速开始

### 环境要求

| 依赖 | 要求 |
| --- | --- |
| Node.js | `22.12.0 ≤ 22.x < 23` 或 `≥ 24`；`.nvmrc` 使用 `22.22.3` |
| npm | `≥ 11.6.2` |
| Rust | `≥ 1.90`，通过 rustup 安装；桌面 Host 使用 Tauri 2 |
| Protobuf | `protoc`，用于生成 Rust gRPC 绑定 |
| JDK | 推荐 JDK 21，需包含 `jlink`、`javac` 和 `include/jvmti.h` |
| Maven | 推荐 3.9+ |
| Native 工具链 | macOS：Xcode CLT；Linux：GCC/Clang；Windows：MSVC Build Tools |

Linux 还需 WebKitGTK 4.1、GTK 3、librsvg、OpenSSL 和 AppIndicator 开发包；Windows 需
WebView2 Runtime。Node.js 只用于前端与构建工具，安装后的应用不运行 Node.js 或 Electron。
macOS 最低为 13.3：现有 Tailwind 4 界面需要 Safari/WKWebView 16.4 的 CSS 能力。

生产 JVM 模块以 Java 8 字节码为基线；CI 覆盖 JDK 8、11、17、21、25，以及 macOS
arm64/x64、Linux x64 和 Windows x64。

### 从源码启动

```bash
nvm use
npm ci
npm run build:jvm
npm run dev
```

首次连接目标前必须完成 `build:jvm`。之后只有 JVM 或 Native 代码变化时才需要重新构建。
开发模式会同时启动 Vite 和 Tauri；React 页面通过受限命令调用 Rust Host，请不要单独打开生成的 HTML。
可通过 `TANWEI_JAVA_HOME` 指定开发模式使用的完整 JDK（含 `java`、`javac`、`jfr`）；未设置时从
`PATH` 查找这些工具。打包后的应用始终使用内置 Java 运行时。

启动后，在“目标”页刷新本机进程，选择可 Attach 的 JVM 并连接。目标进程通常需要与探微
属于同一系统用户，且未启用 `-XX:+DisableAttachMechanism`；JDK 8 目标还需要其所属完整
JDK 的 `lib/tools.jar` 可读。否则可使用远程接入方式。

## 构建与验证

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动桌面开发环境 |
| `npm run build` | 构建 Plugin SDK、Native/JVM 组件和桌面应用 |
| `npm run package` | 构建当前平台的正式应用与安装包，不包含测试接口 |
| `npm test` | 运行元数据、UI、类型、单元与 JVM 测试 |
| `npm run package:test` | 生成带原生 WebDriver 的当前平台测试包，仅供测试 |
| `npm run test:e2e` | 对 `package:test` 生成的测试包运行真实 Attach E2E |
| `npm run test:soak:smoke` | 对 `package:test` 生成的测试包运行 45 秒稳定性冒烟 |
| `npm run test:host` | 运行 Rust 协议、生命周期、策略与存储测试 |
| `npm run contracts:verify` | 校验 TypeScript 与 Rust 使用的 Action 目录一致 |

正式构建不会编译测试 WebDriver 或测试命令。`apps/desktop/tests/reference` 中的旧纯
TypeScript 测试仅用于迁移契约对照，不进入应用产物。原工作区 `tanwei.sqlite` 和制品目录
沿用原位置；首次从 Electron 版本升级需完整安装 Tauri 版本。

完整本地验证：

```bash
npm run verify
```

`verify` 会依次运行完整测试、当前平台目录包和真实 Attach E2E。

### 发布

推送到 `main` 或创建 Pull Request 会触发跨 JDK、跨平台验证。发布采用与 `writer-agent` 相同的分发方式：
macOS 使用探微独立的固定自签名证书，Windows 普通打包，Linux 提供 AppImage 和 Debian 包；
所有平台仍要求 Tauri 自动更新签名。此流程不依赖 Apple Developer 账号、Apple 公证或 Windows 官方代码签名证书。

提交并推送版本代码、确认 CI 通过后，运行以下命令触发四平台构建：

```bash
gh workflow run release.yml --ref main -f tag=v0.3.0
```

工作流校验发布版本，执行平台测试、更新签名验签和正式应用启动检查。
全部平台成功后才创建不可变 Git 标签和 GitHub Release，上传安装包、`latest.json` 和 `SHA256SUMS.txt`。
也支持通过与产品版本一致的 `v*` 标签触发；已有标签不能指向不同提交或被覆盖。

在仓库 **Settings → Secrets and variables → Actions → Repository secrets** 配置：

| 范围 | Secret | 内容 |
| --- | --- | --- |
| Tauri 更新 | `TAURI_SIGNING_PRIVATE_KEY` | 更新私钥文件的完整内容 |
| Tauri 更新 | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 更新私钥的加密密码 |
| Tauri 更新 | `TANWEI_UPDATER_PUBLIC_KEY` | 对应 `.pub` 文件内容 |
| macOS 自签名 | `MACOS_CERTIFICATE` | 探微固定自签名 `.p12` 文件的 Base64 内容 |
| macOS 自签名 | `MACOS_CERTIFICATE_PASSWORD` | `.p12` 密码 |
| macOS 自签名 | `MACOS_CERTIFICATE_SHA256` | 证书 DER 内容的 SHA-256 指纹 |

```bash
npm run release:signing:check -- --repo qian-lou/tanwei
```

检查只读取 Secret 名称，实际有效性由签名、验签和平台构建确认。私钥、密码和证书备份放在仓库外，
后续版本持续使用同一对更新密钥和同一张 macOS 证书，不要在每次构建时重新生成。

首次配置 macOS 证书可运行 `node scripts/generate-macos-certificate.mjs <仓库外的空目录>`；
该命令要求通过环境变量 `MACOS_CERTIFICATE_PASSWORD` 提供至少 24 个字符的密码，不会输出密码或私钥。
构建仅在临时钥匙串中导入证书，并在完成后恢复原有钥匙串和证书信任设置。

自签名不等于系统默认信任：macOS 未做 Apple 公证，Windows 未做受信任 Authenticode 签名，
安装时可能出现来源验证提示。Tauri 更新签名独立保留，用于防止更新包被篡改。
发布说明见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。

## 架构

```mermaid
flowchart LR
  UI["系统 WebView / React"] --> IPC["Tauri 类型化 IPC"]
  IPC --> HOST["Rust Host / 会话与策略"]
  HOST --> STORE["SQLite + Artifacts"]
  HOST --> SESSION["Target Session"]
  SESSION --> ACCESS["Attach / SSH / Kubernetes / mTLS Relay"]
  ACCESS --> AGENT["Tanwei Agent"]
  AGENT --> JVM["目标 JVM"]
```

React 负责交互；Rust Host 负责连接生命周期、授权、持久化和制品校验；Agent 在目标
JVM 内再次校验 Action、能力与输入预算。领域模型见 [`CONTEXT.md`](CONTEXT.md)。

## 项目结构

```text
.
├── apps/desktop/          # Tauri + Rust + React 桌面应用
├── packages/plugin-sdk/   # 声明式签名扩展 SDK
├── jvm/                   # Agent、Protocol、Relay 与集成测试
├── contracts/             # 协议兼容契约
├── scripts/               # 构建、打包、发布与验证脚本
└── tests/e2e/             # 打包应用 E2E
```

## 安全边界

- 不开放任意 Shell、OGNL、Telnet/HTTP 文本命令或插件代码注入。
- 风险等级由共享 Action 描述符和 Host Policy 决定，Renderer 不能自行降级。
- 高风险操作由 Agent 重新验证输入边界、目标身份和预检指纹。
- Plugin SDK 只允许贡献已存在的 R0/R1 声明式模板，不加载插件 JavaScript 或 Native 代码。

扩展格式与签名示例见
[`packages/plugin-sdk/README.md`](packages/plugin-sdk/README.md)。

## 参与贡献

欢迎通过 Issue 报告 Bug、提出功能建议或补充诊断场景，也欢迎提交 Pull Request。

提交改动前请：

1. 对较大的功能或架构调整先创建 Issue，说明使用场景、边界和预期行为。
2. 保持改动聚焦，并为行为变化补充测试或可复现证据。
3. 运行 `npm test`；涉及桌面完整链路时，再运行 `npm run package:test` 和
   `npm run test:e2e`。
4. 在 Pull Request 中说明风险、验证结果以及兼容性影响。

项目优先接受边界明确、可取消、可审计且不会绕过 Action Policy 的诊断能力。
提交的贡献将按本项目相同的非商业许可证提供。

## 许可证

探微采用 [PolyForm Noncommercial License 1.0.0](LICENSE)。你可以为个人学习、研究、实验
及其他非商业目的使用、修改和分发本项目；商业用途不在授权范围内，必须事先取得权利人的
另行授权。

由于许可证限制商业使用，本项目属于**源码开放（source-available）**，而不是 OSI 定义的
开源软件。随项目分发的第三方组件继续适用其各自许可证，详见
[第三方许可证说明](licenses/THIRD_PARTY_NOTICES.md)。
