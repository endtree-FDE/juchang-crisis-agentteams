# 据场 · 2014 东艺危机 AgentTeams 反事实推演（复赛可执行代码包）

一个真实可运行的多 Agent 危机处置推演：**历史证据 + 口述材料 + 合成虚拟闭源库 → 四个 AgentTeams 责任位 → Leader 决策包 → 具名人工决定 → 零真实写入 → 复盘与 Skill 候选 → 第二案例迁移验证**。

## 一分钟跑通（Node ≥ 22.18，零依赖、零模型调用）

```bash
npm test
```

17 项确定性验证全绿即通过：双场景六项 Eval（事实冲突/有资源≠有许可/越权防护/动态截止/闭源库权限/披露纪律）、四角色 DAG、结构化人工审批、Context Broker 四种访问结局、安全计数全零、反冒充门禁、回放导出器拒绝协议模拟、Skill 候选未晋升等。

## 三种运行模式（严禁混称）

| 模式 | 含义 | 证据形态 |
|---|---|---|
| Protocol Simulation | 零模型调用的确定性协议模拟 | `juchang-crisis-protocol-simulation@1` |
| Live Agent Run | 真实四岗 + Leader 模型调用运行 | `evidence/`（含真实 Skill 调用 trace） |
| Verified Replay | 只能由真实运行导出，冻结只读 | `app/src/data/crisis-sim/verified-replay-*.json` |

## 目录地图

- `app/src/lib/crisis-sim/` — 合同、协议模拟器、六项 Eval、Context Broker（RBAC）
- `app/src/data/crisis-sim/` — 双场景 fixture + 合成闭源库 + 两份冻结回放
- `scripts/crisis-sim/skills/artist-substitution-feasibility/` — 真实 Skill 包（SKILL.md + 确定性核对器 + 权限清单）
- `scripts/crisis-sim/export-verified-replay.mjs` — 回放导出器（拒绝任何非真实运行输入）
- `evidence/` — 真实 Live Agent Run 证据（验收链、回执、决策包）
- `docs/gap-analysis.md` — 复赛规则逐条对照分析

## 安全边界

零生产写入、零公开发布、零真实退款、零外发消息（四层计数恒零）；不使用真实合同/订单/联系人/密钥；虚拟闭源库始终标记 `synthetic_private_demo`；高风险动作必须具名人类决定（`executionAuthorized` 恒 false）。

## 许可

MIT
