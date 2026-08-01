# @tanwei/plugin-sdk

探微的 P2 扩展 SDK。它只生成声明式、Ed25519 签名的 JSON 清单，不提供
Renderer/Main 代码注入，也不允许插件携带 JavaScript、Native 库或任意命令。

插件可贡献已经存在于探微 Action Policy 中、且风险等级为 R0/R1 的诊断模板。
Host 在安装和每次执行前都会重新验签、校验 Action Schema，并应用本机与团队策略。

```ts
import {
  PLUGIN_API_VERSION,
  definePlugin,
  signPluginManifest,
} from "@tanwei/plugin-sdk";

const manifest = definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "runtime-basics",
  name: "Runtime Basics",
  version: "1.0.0",
  description: "Safe read-only runtime checks.",
  publisher: "Example Team",
  templates: [
    {
      id: "jvm-info",
      name: "JVM Info",
      description: "Read JVM identity.",
      actionId: "jvm.info",
      parameters: {},
    },
  ],
});

const signed = signPluginManifest(manifest, process.env.SIGNING_KEY_PEM!);
```

团队策略包使用 `defineTeamPolicy` 与 `signTeamPolicyPackage`。策略只能降低最大风险
等级或禁用精确 Action ID，不能授予本机策略未开放的能力。

## 许可证

`@tanwei/plugin-sdk` 采用
[PolyForm Noncommercial License 1.0.0](LICENSE)，仅授权非商业用途。
