# Taskforce

**一个 Skill，让你在 Codex CLI、Claude Code、OpenCode 等主流 coding CLI 中，
用自然语言运行受监督的 Agent loop。**

你指定要启动的 CLI、任务、依赖关系和可选 model；Taskforce 在 cmux 中运行这些
Worker，持续读取真实终端，并在需要时处理权限、纠正方向和复核结果。

> **一个 Skill · 主流 coding CLI 可用 · 多 Worker · 持续语义监督**

[English](README.md)

## 快速开始

### 1. 准备环境

- Codex CLI、Claude Code、OpenCode，或其他支持 Agent Skills 和本地命令的环境；
- [cmux](https://cmux.com/) 并开启 Automation socket access；
- PATH 中至少一个 Worker CLI：`opencode`、`codex`、`claude` 或 `codebuddy`；
- Node.js 18+ 和一个 Git 项目。

运行 Taskforce 的 CLI 和 Worker CLI 可以相同，也可以不同。

### 2. 安装 Skill

例如，全局安装到 Codex：

```bash
npx skills add lhanyun/taskforce \
  --skill taskforce --agent codex --global
```

使用其他环境时，将 `codex` 替换为 `cursor`、`opencode` 或 `claude-code`。项目级
安装只需在项目根目录执行并去掉 `--global`。

### 3. 描述你的 loop

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
ID。未指定 model 时使用 CLI 默认值。无需手写 workflow JSON、profiles 或轮询脚本。

## Taskforce 会做什么？

```text
理解明确的任务与依赖
  → 在 cmux 中启动 Worker CLI
  → 每 10～20 秒读取所有真实 TUI
  → 继续、回答菜单、纠偏或恢复已退出的 Worker
  → 检查目标、实现和验证结果
```

Worker 在两次检查之间独立持续运行。固定产物只能补充证据，不能暂停读屏或自动结束
任务。

## 核心优势

| 普通方式 | Taskforce |
|---|---|
| 学习新的 Agent 控制平台 | 在原有 coding CLI 中安装一个 Skill |
| 手工打开和切换多个终端 | 用自然语言启动串行或并行 loop |
| 等 Agent 最终回复 | 每 10～20 秒观察实际 TUI |
| 权限菜单等待人工发现 | 检查范围后在原 TUI 中操作 |
| 纠偏时重启并丢失上下文 | 向原 surface 发送具体指导 |
| CLI 退出或声明完成就结束 | 检查真实实现和验证证据后完成 |

Taskforce 的重点不是替用户选择 Agent，而是把用户指定的 CLI 运行起来，并持续观察
它们实际在怎样工作。

## 运行中的判断

```text
Thinking / 编码 / 测试
  → continue，不催促

出现项目范围内的权限菜单
  → 检查命令与范围 → 逐键操作 → 重新读屏确认

实现偏离目标或边界
  → 向同一个 TUI 发送具体纠正

Worker 声明完成
  → 检查目标、代码和测试 → complete
```

Thinking 时间、屏幕无变化和暂时没有文件产出都不是 relaunch 理由。运行时不会为了
relaunch 关闭仍然存活的 Worker。

## 极简运行模型

```text
pending → running → completed
pending/running → cancelled
```

只有四个监督动作：

| 动作 | 含义 |
|---|---|
| `continue` | 不输入，继续观察 |
| `send` | 向当前 surface 发送文字或一个 TUI 按键 |
| `relaunch` | 旧 Worker 已退出后创建新 attempt |
| `complete` | 核对目标和真实实现后完成 |

菜单操作每次只发送一个按键，并在发送前校验完整 screen hash。屏幕已变化时返回
`stale_screen`，不会把旧选择发送给新菜单。

## 项目边界

Taskforce 不提供工程方法论、角色系统、模型路由、补丁集成或通用工作流平台。它只
负责 coding CLI 的运行时观察与引导。

你仍然可以保留原来的 CLI 使用习惯，包括已有的 Skills、项目指令、模型配置、权限
设置和工程流程。Taskforce 不改变 Worker CLI 的工作方式，只在外层负责启动、读屏
和必要的运行时干预。

## 开发

```bash
cd skills/taskforce
npm test
```

完整协议见[运行时规格](specs/2026-08-04-runtime-supervisor-loop-redesign.md)和
[监督决策协议](skills/taskforce/references/chief-protocol.md)。贡献前请阅读
[CONTRIBUTING.md](CONTRIBUTING.md)。
