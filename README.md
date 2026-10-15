# @local/reverse-skill-tools

把 [`@dhicoc/dsh-reverse-skill`](https://github.com/dhicoc/dsh-reverse-skill) 这个技能包里的**全部 88 个 SKILL.md**，逐一封装成**原生 DSH 工具**（`defineTool` + `ctx.tools.register`）。

- 数据驱动：递归扫描上游包的 `skills/` 与 `CTF-Sandbox-Orchestrator/`（含嵌套子技能，如 `pentest-tools/src-hunter`、`reverse-engineering/dsl-vm-reverse`）。
- 工具名 = 技能名转 snake_case（`ida-reverse` → `ida_reverse`、`ctf-sandbox-orchestrator` → `ctf_sandbox_orchestrator`）。
- 工具描述 = 技能自身的 `description`。
- 调用任一工具，返回该技能 `SKILL.md` 的完整正文（去掉 YAML 头），模型直接内联获得方法论并照做。

## 安装

```bash
dsh plugin add link:<本目录绝对路径>
```

或直接写进 profile 的 `dependencies` + `dsh.profile.bundles`。装完后**重启/刷新 Harness**，88 个原生工具即生效。

## 结构

- `lib/index.js` — 发现 + 解析 + 注册工具（唯一入口，`exports["."]`）。
- `cordis.patch.yml` — bundle 补丁，把上游包根目录通过 `!!js` + `baseUrl` 解析后作为 `config.upstreamRoot` 注入。
- 依赖 `@dhicoc/dsh-reverse-skill`（同 profile 内已安装），`@deepseek-ai/dsh-tools` 为可选 peer（由 Harness 运行时提供）。

## 安全提示

技能包本身为安全研究 / CTF / 逆向工程类（`contentPolicy.class: dual-use`）。仅在有合法授权时使用其中的渗透、逆向、免杀等技能。