# 安装说明

这个包给 DeepSeek Harness（DSH）加四个岗位预设，以及配套的账本、团队状态和岗位配置工具。

仓库：<https://github.com/cl145FPV/dsh-team-hierarchy>

## 环境要求

| 项 | 要求 |
| --- | --- |
| DSH | **0.2.2-rc.3**（vendor 里的 schemastery 是从这个版本复制的，版本差太远可能让配置字段失效） |
| Node | 20 以上（DSH 自带即可） |
| 网络 | 从仓库安装需要能访问 github.com；本地目录安装不需要 |

## 安装

### 方式一：从仓库安装（推荐）

```bat
dsh plugin --profile desktop add github:cl145FPV/dsh-team-hierarchy
```

装完**完全退出 DSH**（托盘右键退出，不是只关窗口），再启动。

Host 半区有代码，只装不重启不会加载。

这种方式装的好处是可以从仓库更新，见下一节。

### 方式二：DSH 插件页

左侧 **插件** → **添加插件** → 选「安装第三方插件」，填：

```
github:cl145FPV/dsh-team-hierarchy
```

装完同样要完全退出重开。

### 方式三：本地目录（不推荐）

下载仓库或解压压缩包到本地目录后：

```bat
dsh plugin --profile desktop add link:D:\dsh-team-hierarchy
```

这种方式**不会**从仓库更新，改了源码也不会自动生效。适合自己改着玩。

## 更新

```bat
dsh plugin --profile desktop remove dsh-team-hierarchy
dsh plugin --profile desktop add github:cl145FPV/dsh-team-hierarchy
```

然后完全退出重开。

也可以直接在本地仓库里 `git pull` 再重装。

## 首次配置

1. 新建会话 → 预设选「**项目经理**」
2. 打开 设置 →「团队岗位」，给小组长 / 普工 / 技术员配 provider 和模型

配法：
- provider 和模型**要么都填、要么都留空**（留空 = 继承上级）
- provider 列表自动从本机 `llm` 服务读取；如果列表是空的，先在 设置 → 模型 里配一个
- 配完点保存，下一次派活生效

不配也能用，三个岗位全部继承上级模型。

## 验证装好了

新建「项目经理」会话，问它：

> 看看岗位配置

应该返回一张表，列出三个岗位当前配置，以及这台机器上可用的 provider 和模型。

再派一个小活：

> 派个组长在项目目录建一个 hello.txt，内容随便

正常的话它应该：调 `delegate_to_foreman` → 组长起来 → 干完 → PM 调 `team_status` 确认没有还在跑的 → 汇报完成。

## 卸载

```bat
dsh plugin --profile desktop remove dsh-team-hierarchy
```

然后完全退出重开。

项目目录下的 `.dsh-team/` 是账本和配置残留，想清干净就手动删。

## 已知限制

- **改 Host 代码必须重启**，改 Client 代码（`client.js`）刷新页面即可。
- **岗位模型配置只影响新派出去的子会话**，已经在跑的不变。
- **串行的小任务不要用三层**：三层只在并行时省时间，单线程任务会比直接干慢将近一倍。项目经理会先分诊并提醒你。
- vendor 的 schemastery 与 DSH 0.2.2-rc.3 对应。如果安装后设置页出现「配置服务还没就绪」，大概率是版本不匹配。

## 许可

MIT，见 [LICENSE](LICENSE)。
