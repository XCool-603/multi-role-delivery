# 多角色组队交付（multi-role-delivery）

给 DSH 用的一个技能：**你说任务，它自己组队干活，产品验收通过后才交付给你。**

```
接单拆解 → 多角色并行干活 → 产品独立验收 → 返工直到通过 → 统一交付
```

## 它解决什么

一个人干活的默认模式是：一件事做完再做下一件，而且没人检查。这个技能把它换成：

- **自动分配**：你说任务，不说角色。它拆解完自己决定需要哪些角色、谁跟谁并行。
- **并行干活**：互不依赖的工作流同时开工，不是排队。
- **产品把关**：一个独立代理专门挑毛病，必须读盘上的真实产物、真跑命令，每条问题都要带证据。
- **返工到通过**：验收不通过就按责任路由回去修，只重跑受影响的部分，直到通过。连续两轮问题数没下降就停下来找你，不无限烧。
- **统一交付**：一句话结论 + 交付物清单 + 分工回顾 + 验收证据 + 已知限制。

## 安装

先 clone，再用 junction 挂到 DSH 技能目录（不要复制文件，复制会让仓库和已装副本逐渐不同步）：

```powershell
git clone https://github.com/XCool-603/multi-role-delivery.git C:\Work\multi-role-delivery

New-Item -ItemType Junction `
  -Path "$env:DSH_HOME\skills\multi-role-delivery" `
  -Target "C:\Work\multi-role-delivery\skills\multi-role-delivery"
```

`$DSH_HOME` 默认是 `~/.dsh`。装好后技能会在会话的技能目录里立刻出现，无需重启。

> junction 依赖 clone 下来的目录存在，删掉或移动它技能就会失效。想更新就 `git pull`，改动即时生效，不用重装。

## 用法

直接说任务就行，触发词包括"多角色""组队""分工""并行""让产品检查""验收后交付"等。例如：

> 帮我把这个项目整理成一份对外介绍文档，多角色分工做，产品检查通过再给我。

它会：

1. 建 `.dsh-team/<task-slug>/` 任务目录
2. 写 `plan.md`：验收标准、工作流拆解、角色卡
3. 用 `workflow` 工具并行跑各角色，产物落在 `work/<role>/`
4. 独立验收代理逐条核对，报告落在 `review/round-N.md`
5. 不通过就返工，通过后统一交付

## 目录结构

```
skills/multi-role-delivery/
├── SKILL.md                      # 流程规范（技能本体）
└── templates/
    └── team-workflow.js          # workflow 工具编排骨架
```

`templates/team-workflow.js` 是可直接套用的编排脚本：并行调度、验收门、返工循环、平台期保护、结果汇总都写好了。把它作为 `workflow` 工具的 `script` 传入，`args` 传 `{ task, taskDir, criteria, roles, maxRounds }`。

## 设计取舍

- **角色数限制 2–6 个。** 超过就合并同质工作流；少于 2 个说明不需要组队，直接干，不硬凑角色表演。
- **验收者必须独立于产出者。** 自己验自己等于没验。
- **只认盘上的证据。** 子代理的自述不算数，必须读文件、跑命令。
- **平台期保护。** "返工到通过"是无条件的目标，但连续两轮阻塞项没减少就说明方向错了，这时找人比继续烧更有价值。
- **任务目录保留。** 以后要追查"当时怎么验的"靠它。

## License

MIT
