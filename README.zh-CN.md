<div align="center">

<img src="docs/assets/workflow.svg" alt="Taskforce 监督式 Agent 循环" width="720">

# Taskforce

**一个 Skill，运行受监督的多 Agent 编码循环。**

用自然语言描述你的工作流。Taskforce 在 cmux 中启动编码 CLI，持续读取真实终端，
直到工作真正完成。

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%E2%89%A518-339933.svg)](https://nodejs.org/)

[English](README.md) · [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md)

</div>

---

## 单节点示例

<img src="docs/assets/demo.svg" alt="单节点演示" width="880">

*单个 CLI (opencode) 在 4 个 tick 中的不同状态——编码、权限菜单、
偏离目标、验证完成。Chief 对每个观察做出独立决策。*

告诉你的 coding CLI：

```text
使用 Taskforce。启动 opencode 开发一个坦克大战游戏，包含地图、敌人AI和计分系统。
完成后启动 codex 检查代码和测试，修正发现的问题。持续监督到真实完成。
```

| Tick | 观察到什么 | Chief 决策 |
|---|---|---|
| TICK 1 | opencode 正在编写 Tank.ts，3/5 测试通过 | `continue` — 正常推进，不催促 |
| TICK 4 | opencode 遇到权限菜单，请求写入 Tank.ts | `send key:enter` — 批准项目范围内的写入 |
| TICK 8 | opencode 开始写 Network.ts，偏离了单机版目标 | `send input` — "只实现单机版，不需要网络多人模式" |
| TICK 12 | 全部测试通过，实现与目标一致 | `complete` — 核对目标和实现后完成 |

---

## 多 CLI 串行示例

<img src="docs/assets/demo-multi.svg" alt="多节点演示" width="880">

*串行三 CLI 工作流：codex 做方案设计 → claude 做代码实现 → opencode 做代码审查。
每个节点遇到权限或偏离时，Chief 实时干预。*

```text
使用 Taskforce。启动 codex 编写实时聊天系统的架构设计文档；
完成后启动 claude 按照设计文档实现代码；完成后启动 opencode 审查代码和测试，
修正发现的问题。持续监督整个工作流。
```

| Tick | codex | claude | opencode |
|---|---|---|---|
| TICK 3 | `continue` 编写设计文档 | ○ pending | ○ pending |
| TICK 6 | `send key:enter` 批准写入 | ○ pending | ○ pending |
| TICK 9 | `send input` 纠偏：只写设计 | ○ pending | ○ pending |
| TICK 11 | `complete` 设计文档完成 | `continue` 编写代码 | ○ pending |
| TICK 16 | — | `send key:enter` 批准写入 | ○ pending |
| TICK 19 | — | `send input` 纠偏：使用 socket.io | ○ pending |
| TICK 22 | — | `complete` 实现与设计一致 | `continue` 审查中 |
| TICK 25 | — | — | `continue` 发现竞态条件 |
| TICK 28 | — | — | `complete` 审查完成 |

关键设计点：
- **串行依赖**：claude 依赖 codex 完成，opencode 依赖 claude 完成
- **不同 CLI 各有角色**：codex 做设计、claude 写代码、opencode 做审查——各司其职
- **权限自动审批**：每次写入请求都是项目范围内的，Chief 直接批准
- **跨节点纠偏**：claude 自行实现 WebSocket 而非使用设计文档指定的 socket.io，Chief 纠偏使其回归设计
- **Worker 自行修复**：opencode 发现竞态条件后自行修复，Chief 只需 `continue`

---

## 它做什么

你指定 CLI、任务、顺序和可选模型，Taskforce 处理剩下的一切：

1. **启动** — 在可见的 cmux surface 中启动每个 Worker CLI
2. **观察** — 每 10–20 秒读取所有真实 TUI
3. **决策** — 继续、回答菜单、纠正偏移或恢复已退出的 Worker
4. **验证** — 检查目标、实现和验证结果后才标记完成

Worker 在两次检查之间独立运行。固定产物只能补充证据，不能暂停读屏或自动完成任务。

## 核心优势

| 普通方式 | Taskforce |
|---|---|
| 学习新的 Agent 控制平台 | 在原有 coding CLI 中安装一个 Skill |
| 手工打开和切换多个终端 | 用自然语言启动串行或并行循环 |
| 等 Agent 最终回复 | 每 10–20 秒观察实际 TUI |
| 权限菜单等待人工发现 | 检查范围后在原 TUI 中操作 |
| 纠偏时重启并丢失上下文 | 向原 surface 发送具体指导 |
| CLI 退出或声明完成就结束 | 检查真实实现和验证证据后完成 |

## 快速开始

### 环境准备

- Codex CLI、Claude Code、OpenCode 或其他支持 Agent Skills 的环境
- [cmux](https://cmux.com/) 并开启 Automation socket access
- PATH 中至少一个 Worker CLI：`opencode`、`codex`、`claude` 或 `codebuddy`
- Node.js 18+ 和一个 Git 项目

运行 Taskforce 的 CLI 和 Worker CLI 可以相同，也可以不同。

### 安装

```bash
npx skills add lhanyun/taskforce \
  --skill taskforce --agent codex --global
```

使用其他环境时，将 `codex` 替换为 `cursor`、`opencode` 或 `claude-code`。
项目级安装只需在项目根目录执行并去掉 `--global`。

### 运行

串行执行：

```text
使用 Taskforce。启动 opencode 完成设置页面并运行测试；完成后启动 codebuddy
检查代码和测试，修正发现的问题。持续监督到真实完成。
```

并行执行：

```text
使用 Taskforce。同时启动 codex 实现后端接口、opencode 实现前端页面；两边完成后
启动 claude 做整体审查。持续监督整个工作流。
```

描述中可以包含：CLI、任务、并行或先后关系、完成条件，以及 CLI 支持的精确 model
ID。无需手写 workflow JSON、profiles 或轮询脚本。

## 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│                     监督循环 (SUPERVISOR LOOP)               │
│                                                             │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐             │
│   │ Worker 1 │    │ Worker 2 │    │ Worker 3 │   ...       │
│   │ codex    │    │ opencode │    │ claude   │             │
│   └────┬─────┘    └────┬─────┘    └────┬─────┘             │
│        │               │               │                    │
│        ▼               ▼               ▼                    │
│   ┌─────────────────────────────────────────────┐          │
│   │            cmux surface 采集器               │          │
│   └────────────────────┬────────────────────────┘          │
│                        │                                    │
│                        ▼                                    │
│   ┌─────────────────────────────────────────────┐          │
│   │  Chief: 审查终端尾部 → 对每个节点做出决策      │          │
│   │  continue · send · relaunch · complete      │          │
│   └─────────────────────────────────────────────┘          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 运行中的判断

| 情况 | 动作 |
|---|---|
| Thinking / 编码 / 测试 | `continue` — 不催促 |
| 项目范围内的权限菜单 | 检查命令与范围 → `send key` → 重新读屏确认 |
| 实现偏离目标或边界 | `send input` — 具体纠正到同一个 TUI |
| Worker 自行修复中 | `continue` — 让 Worker 继续修复 |
| Worker 声明完成 | 检查目标、代码和测试 → `complete` |

Thinking 时间、屏幕无变化和暂时没有文件产出 **不是** relaunch 理由。
运行时不会为了 relaunch 关闭仍然存活的 Worker。

## 生命周期模型

```
pending ──→ running ──→ completed
   │           │
   └───────────┴──→ cancelled
```

只有四个监督动作：

| 动作 | 含义 |
|---|---|
| `continue` | 不输入，继续观察 |
| `send` | 校验 screen hash 后发送一个 TUI 按键或文字纠正 |
| `relaunch` | 旧 Worker 已退出后创建新 attempt |
| `complete` | 核对目标和真实实现后完成 |

`send` 统一处理自然语言纠偏与 TUI 菜单回答——二选一携带 `input`（文字）或
`key`（一个按键）。菜单操作每次只发送一个按键，并在发送前校验完整 screen hash。
屏幕已变化时返回 `stale_screen`，不会把旧选择发送给新菜单。`input` 与 `key`
都绑定 `expected_screen_hash`。

## 项目边界

Taskforce **不是**工程方法论、角色系统、模型路由、补丁集成或通用工作流平台。
它只负责 coding CLI 的运行时观察与引导。

你仍然可以保留原来的 CLI 使用习惯——已有的 Skills、项目指令、模型配置、权限设置
和工程流程。Taskforce 不改变 Worker CLI 的工作方式，只在外层负责启动、读屏和必要
的运行时干预。

## 开发

```bash
cd skills/taskforce
npm test
```

完整协议见[监督决策协议](skills/taskforce/references/chief-protocol.md)。贡献前请阅读
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
