## ① 状态面板（悬浮球形态）

### 目标

在会话标题栏看到整个团队此刻在干什么。改成悬浮球之后，它在任何页面都可见、可拖到顺手的位置，不占标题栏空间。

### 形态

**悬浮球**（收起态）

固定在屏幕一角的小圆球，可以按住拖动，松手位置记下来（localStorage），下次打开还在原地。

球上直接显示一个数：`2/5`（在跑的 / 总下级数）。有战线阻塞时球变琥珀色，有下级报错变红。

**展开面板**（点击球）

不是系统窗口，是浮在页面上的一个面板（`shell.overlay` 本身就在最上层）：

```
团队状态                                     ×

● 项目经理    ctx 18.9k / 128k   ███░░░░░░░  15%
────────────────────────────────────────────
● lead-A      跑着   03:12   42k tok   重写登录模块
○ lead-B      空闲   12:40   88k tok   导出配置
  ● tech-C    跑着   01:05   15k tok   查 csc 参数
○ worker-D    空闲   02:18    9k tok   写 README
────────────────────────────────────────────
账本  7 条战线 · 5 done · 1 running · 1 blocked
最近更新  flow5 · 16:57  "四条链路全通"
```

每行点一下可以跳到那个子会话（第二版做）。

### 为什么挂 `shell.overlay`

| 候选 | 结论 |
| --- | --- |
| `conversation.session.header.actions` | 标题栏里的行内按钮，**不能 free 定位、不能拖** |
| `conversation.input.dock` | 输入框上方，跟着输入区走，也不能拖 |
| **`shell.overlay`** | 「整框浮动层，在所有列之上、在它们的滚动容器之外」——**可拖、可浮、不随滚动** |

代价：`shell.overlay` 是 **root scope**，组件拿不到 session props，**不知道当前是哪个会话**。这一点决定了下面的数据通道设计。

### 技术路径

**数据从哪来**（因为拿不到 session context）：

方案是把团队快照写进 Host 的配置，悬浮球只读配置。

| 数据 | 来源 |
| --- | --- |
| 子会话列表与状态 | PM 调 `team_status` 时，`tools.js` 顺手把结果序列化写进 Host Config 的 `teamSnapshot` 字段（volatile JSON） |
| 各子会话 token / 耗时 | 同上，`team_status` 已经能拿到 activity；token 要额外从 `subagents.listDescendants` 拿不到——**这部分第一版先不做**，只显示状态和任务 |
| PM 自己的上下文 | PM 每次调工具时把 session 的 token 压力一并写进快照 |
| 账本汇总 | `tools.js` 在 `ledger_update` 后重新算一遍写进 `ledgerSummary` |

**新增两个 Host Config 字段**（都 volatile，和 `catalogJson` 一样由 Host 写、Client 读）：

- `teamSnapshot`：`{ at, pm: {...}, members: [...], lanes: {...} }`
- `ledgerSummary`：`{ total, done, running, blocked, latest }`

**悬浮球组件**：
- `ctx.slots.inject('shell.overlay', ...)` 注册，`scope: root`
- 组件自己渲染 fixed 定位的球，`pointerdown` 拖拽，直接改 `style.left/top`（这是组件自己的 DOM，不违反"不许写外部 DOM"）
- 点击判定：按下到抬起的位移小于 4px 才算点击，避免拖完误触
- 点击后展开面板，面板也在同一组件内渲染（`position: fixed`）

### 取舍

- **不是系统级窗口。** 要在 Electron 里开独立 BrowserWindow 得改 Host 侧的窗口管理，那是 DSH 本体层面的事，插件做不到。浮层是上限。
- **数据是快照，不是实时。** PM 每调一次工具才更新一次。PM 空闲时球上的数字不会动。这是 root scope 拿不到 session 数据的代价。
- **多团队会话混在一起。** 如果同时开两个项目经理会话，`teamSnapshot` 只有一份（后写的覆盖）。第一版只支持单团队，符合实际用法。

### 验收

- 开一个项目经理会话，派两条战线 → 球上显示 `2/2`，展开能看到两个组长
- 拖动球到任意位置，刷新页面后位置还在
- 组长收工后 PM 调一次 `team_status`，球上的数字变成 `0/2`
