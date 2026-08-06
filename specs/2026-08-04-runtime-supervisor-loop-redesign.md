# Runtime Supervisor Loop Redesign

日期：2026-08-04（2026-08-05 四状态收敛版）

## 1. 产品目标

Taskforce 只解决一个问题：持续观察多个终端 coding agent 实际在怎样工作，并
由 Chief 在恰当时机输入、重启或确认完成。

它不是工程设计方法、角色系统、patch integration framework、模型发现服务或
通用工作流平台。

## 2. 原则

1. worker CLI 与 Chief 是两条独立运行线。
2. CLI 在 cmux TUI 中持续工作，不等待 Chief tick。
3. 内置 `--wait` 每 10–20 秒执行一次短 tick，每次都把当前末屏交给 Chief 判断。
4. 每个 tick 都读取所有 running surface，包括内容未变化的 surface。
5. 每次定时读屏都交给 Chief；屏幕变化、事实事件或 send 后确认可以提前返回。
6. 固定产物只能补充证据，不能阻塞屏幕监督。
7. 状态只描述事实，判断全部交给 Chief。

## 3. 单次 tick

```text
读取 previous latest_observation_batch
  → 消费与其 batch_id 绑定的 Chief actions
  → 执行 send/relaunch/complete
  → 检测 result/question/CLI exit 等事实事件
  → 启动 pending 节点
  → 读取所有 running cmux surface
  → 写入当前 next latest_observation_batch
  → 立即退出
```

必须先消费上一轮 action，再创建下一轮 observation。监督器内部不得包含长期
Shell `while + sleep` 或 Chief 判断循环；内置 `--wait` 只负责本地读屏与事实变化
检测，不调用模型、不制造决策。`--once` 保留为诊断入口。

## 4. 四个状态

```text
pending → running → completed
pending/running → cancelled
```

仅有：`pending`、`running`、`completed`、`cancelled`。

- 启动过程是 `launch_phase` 元数据，不是 launching 状态。
- Thinking、编码、测试、授权菜单和问题都是 running。
- worker failed/blocked 声明和 CLI exit 是 observation event，节点仍 running。
- 不存在 blocked、launching 或 failed 生命周期状态。

如果 Chief 等待用户提供凭据或产品决策，节点继续 running 并持续被读取，不需要
后续“恢复状态”。

## 5. Observation

```json
{
  "node_id": "node-a",
  "task_id": "task-a",
  "task_goal": "...",
  "task_boundaries": "...",
  "task_done_when": "...",
  "node_status": "running",
  "screen_changed": false,
  "screen_hash": "...",
  "current_screen": "compact terminal tail",
  "last_action": {
    "action": "continue",
    "reason": "Normal progress"
  },
  "immediate_events": []
}
```

屏幕变化时保留最多 4000 字符末屏，未变化屏幕提供最多 1200 字符。每次定时读屏
都调用 Chief；screen hash 只描述变化，不能跳过语义判断。不提供
`no_response` 定时事件。长时间 Thinking 或没有文件产出不能触发 relaunch。

## 6. 四个动作

| Action | 行为 |
|---|---|
| `continue` | 不输入，继续观察 |
| `send` | hash 一致时向准确 surface 发送文本或一个 TUI 按键 |
| `relaunch` | 更换当前 attempt，可选新 CLI/model |
| `complete` | Chief 核对目标与实现后完成节点 |

活跃工作默认使用 `continue`。Thinking、Write/Edit 执行、流式输出、测试、调试、
部分实现、耗时、屏幕未变化或未来文件尚未出现，都不能成为催促、重复任务或要求
“立即开始”的 send 理由。仅在可见输入请求、具体目标/边界偏航，或明确无法继续且
需要指导的失败时使用 send。

不区分 correct/respond：自然语言纠偏和 TUI 菜单回答都是 `send`。`send`
必须在文本 `input` 和单个官方 TUI `key` 之间二选一。不区分
restart/reassign/retry：需要更换 attempt 时都是 `relaunch`。任务拆分属于显式
工作流规划。

## 7. Send 与权限判断

```json
{
  "node_id": "codebuddy",
  "action": "send",
  "reason": "移动到仅信任当前项目目录的选项",
  "expected_screen_hash": "...",
  "key": "down"
}
```

dispatcher 必须在发送前重新读取 surface，并对完整捕获屏幕计算 hash：

- 与 `expected_screen_hash` 一致：文本使用 `cmux send`，按键使用 `cmux send-key`；
- 不一致：返回 `stale_screen`，不发送任何内容。

官方按键限定为 `enter`、`tab`、`escape`、`backspace`、`delete`、`up`、
`down`、`left`、`right`。菜单数字默认只是标签。每次 review 只发送一个菜单按键；
导航后重新读屏、确认高亮项，再使用新 screen hash 发送 `enter`。

cmux 返回成功只表示 `input_delivered`；是否生效由下一次屏幕确认。send 后沿用
同一个 node、surface、CLI process、run directory 和 attempt。

Chief 默认可以批准项目范围内的安全读写、测试、普通命令和范围明确的“信任本
项目”。凭据、产品权威、系统/全局访问、危险或不可逆操作、外部承诺才询问用户。
询问期间使用 continue，节点保持 running。

## 8. Relaunch

Chief 根据屏幕与进程事实自行决定 relaunch，不要求任何 blocked 前置状态，也不
使用固定重试次数。运行时：

1. 每个 attempt 在 `exec` worker 前记录 `agent.pid`；
2. PID 存活或存活状态未知时拒绝 relaunch，不发送中断；
3. 保持原节点、surface、run 为 running；
4. 只有旧 PID 已退出或节点尚无 active attempt 时接受 relaunch；
5. 记录 previous run/surface/CLI/model 与 Chief reason/instruction；
6. 将同一节点排为 pending，通过正常启动路径创建新 attempt；
7. 新 worker 首先检查当前工作区，避免覆盖已有成果。

慢 Thinking、屏幕无变化、暂时没有文件产出、持续流式输出和 `stale_screen` 都
不是 relaunch 依据。运行时不会为了重新派生 CLI 而关闭存活 worker。

## 9. 完成判断

`result.json` 的 worker 状态仍可为 completed、failed、blocked，但它们只是证据。
空白或其他值产生 `invalid_result`。

收到 completed candidate 时，Chief 必须比较 task goal、done_when、result、
validation、实际实现和当前屏幕。只有确认真实完成后才返回 complete。

## 10. 启动链

```text
supervisor_loop
  → prepare_terminal_launch
  → cmux workspace create --command <internal launcher.sh>
  → agent_runner --prepare
  → source tui_exec.sh
  → exec <CLI TUI>
```

内部 launcher 用于在 cmux PTY 环境中写入 launch evidence，再用 `exec` 替换为
真实 CLI。它不是用户入口。

## 11. 证据

```text
.taskforce/state/workflows/<workflow-id>/
  latest_observation_batch.json
  last_consumed_batch.json
  decisions.jsonl
  interventions.jsonl
  recoveries.jsonl

.taskforce/runs/<workflow-id>/<node-id>/<attempt-id>/
  launch.json
  agent.pid
  prompt.txt
  command.json
  tui_exec.sh
  result.json
  validation.json
  interventions.jsonl
```

latest observation 在上一批 action 消费并产生下一次 review 后覆盖，last consumed batch 在应用 action 时
更新。长期证据只记录 send/relaunch/complete、interventions 与 recoveries，不
累积屏幕历史或重复 continue。

## 12. 验收场景

1. 两个独立 `--once` 之间 action A 在 observation B 前消费；
2. 正常长 Thinking 不产生 relaunch；
3. 权限菜单由 Chief 使用单个 TUI key 原地回答，导航与确认之间重新读屏，节点与 attempt 不变化；
4. screen hash 变化时 send 被拒绝；
5. Chief 等待用户时节点持续 running；
6. CLI exit 只产生事件，不影响其他节点状态；
7. relaunch 无 blocked 前置条件并保留紧凑交接说明，但存活 worker 不可被替换；
8. invalid result 不完成节点；completed result 必须经 Chief 复核。
9. `continue` 后屏幕无变化时，下一个定时 tick 仍创建 observation 并交给 Chief。
10. 同一 workflow 的第二个 supervisor 被拒绝，未消费 observation 不会被覆盖。
11. `continue` 误判交互菜单后，下一个 15 秒 tick 重新发出同一末屏。
12. 正常 Thinking/Write/测试/调试只产生 continue，不发送催促或任务复述。
