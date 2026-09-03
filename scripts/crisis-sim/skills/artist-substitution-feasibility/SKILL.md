# artist-substitution-feasibility

- **Skill ID**: `artist-substitution-feasibility`
- **版本**: `0.1.0`（SemVer：0.x 为初版，规则集任何不兼容变更升 minor，修复升 patch）
- **契约**: `juchang-skill-checklist-verdict@1`
- **状态**: 已注册可用（registered, usable）。注意区分：演练叙事里的 "Skill 候选"（`skill-candidate-artist-substitution`，library `skills-policies` 集合）指**从本次案例提炼新洞察的晋升门禁**，与本 Skill 这个既有能力不冲突。

## 用途

对「艺术家临时替补/换曲」类方案做**确定性条件核对**：读取场景 preset 与虚拟闭源库 JSON，按固定规则集逐项判定 checklist 的成立（holds）/ 不成立（fails）/ 未知（unknown），并给出每项判定的真实依据引用（preset factId / optionId / stakeholderId 或 library recordId，附实际匹配到的原文短句）。

它不替人做艺术判断，不输出"建议执行某方案"；它只回答：每条前置条件在当前材料下是否成立。

## 输入

| 参数 | 说明 |
|---|---|
| `--preset <path>` | 场景 preset JSON（`juchang-crisis-scenario-preset@1`），如 `app/src/data/crisis-sim/2014-east-art-center.preset.json` |
| `--library <path>` | 虚拟闭源库 JSON（`juchang-synthetic-private-library@0.1`） |
| `--out <path>` | 可选。verdict JSON 落盘路径（仅限 `output/crisis-sim/**`） |

两个输入文件的真实 sha256 会被计算并写入 verdict 的 `inputs[]`，供回执与审计追溯。

## 输出

`juchang-skill-checklist-verdict@1` JSON（stdout 必出；`--out` 时同内容落盘）：

- `skill`: `{ skillId, version, contract }`
- `runtime`: `deterministic-script`（本 Skill 零模型调用）
- `inputs`: 输入文件路径 + sha256
- `generatedAt`: 真实执行时刻（UTC ISO）
- `items[]`: 逐项 `{ itemId, question, verdict: holds|fails|unknown, basis: string[], matched: string }`——`matched` 是规则真实匹配到的原文短句，不得为空字符串
- `counts`: `{ holds, fails, unknown }`
- `overallVerdict`: 由 items 推导（见规则集），当前版本为 `substitution_not_feasible_now` / `substitution_conditionally_possible`

### Checklist（v0.1.0 固定九项）

| itemId | 问题 | 判定规则摘要 |
|---|---|---|
| `named-substitute-candidate-exists` | 存在具名替补钢琴家候选？ | preset 方案 A knownBlockers 命中"人选/候选"类阻断且闭源库无钢琴替补记录 → fails |
| `artist-consent-confirmed` | 候选艺术家本人同意已确认？ | library 候选记录命中"本人意愿…需现场确认" → unknown |
| `inviting-party-permission-obtained` | 原邀请方许可已取得？ | 许可规则记录存在且无任何许可授予证据 → fails |
| `rehearsal-completed` | 与指挥/乐团已完成合排？ | 合作史记录命中"未合排" → fails |
| `mahler-roster-recallable` | 马勒七缺员可在剩余时间召回？ | 排班记录命中"缺少…无法…召回" → fails |
| `decision-deadline-confidence-high` | 决定截止时间为高置信？ | deadline confidence ≠ high → unknown |
| `broadcast-risk-eliminated` | 直播永久记录风险已消除？ | 传播记录命中"永久记录" → fails |
| `economic-authority-named` | 具名经济授权人已确认？ | 授权记录要求具名人类且 board 状态为待核实 → unknown |
| `fallback-route-viable` | 兜底路线（缩短节目+退款）艺术/技术上可行？ | 方案 D 为 prepare_only 且阻断均非艺术/技术类 → holds |

规则全文以 `check.mjs` 内 `RULES` 数组为唯一权威实现；本表为对应文档。

## 调用条件

- 适用：evidence_guard / entity_matcher 在评估「替补、换曲、补演」类方案前做条件核对；Leader 复核方案矩阵时回读。
- 前置：两个输入 JSON 存在且 schema 合法；否则脚本非零退出（见失败处理）。
- 不适用：任何需要艺术可接受性判断、人际谈判、公开措辞选择的环节——这些在 preset `humanDecisionBoundary.humanCapabilities` 中明确属于人。

## 依赖

- Node.js ≥ 22（仅用 `node:crypto` / `node:fs` / `node:path` 标准库；零第三方依赖，零网络访问）
- 输入 fixture：`app/src/data/crisis-sim/2014-east-art-center.preset.json`、`app/src/data/crisis-sim/virtual-private-library.json`

## 失败处理

| 失败 | 行为 |
|---|---|
| 输入文件缺失 / JSON 非法 / schema 不符 | 打印 `[FAIL] 原因` 到 stderr，exit 1，**不产出任何 verdict** |
| 某规则的预期数据结构缺失（如某 option 不存在） | 该项 verdict=unknown，basis 注明 `structure-missing`，不静默跳过 |
| `--out` 路径越出 `output/crisis-sim/` | 拒绝写入，exit 1 |

脚本绝不"猜"结果：规则未命中时 verdict 只能是 unknown 或 fails，永远不会把缺失证据报告为成立。

## 安全边界

- 只读两个输入 JSON；不读写任何其他路径（`--out` 白名单除外）。
- 不访问网络、不读环境变量、不触碰任何密钥。
- 不能批准、发布、退款、外发消息、写生产系统；authority manifest 见同目录 `authority.json`。
- 输出为内部核对材料；对外引用须由具名人类决定。

## 复用价值

规则集与输入 schema 解耦：任何符合 `juchang-crisis-scenario-preset@1` + `juchang-synthetic-private-library@0.1` 的场景（如 stage-malfunction preset）可直接复用同一核对器。从单案例提炼的**新**洞察仍须走 Skill Candidate 晋升门禁（requiresSecondCase），本 Skill 的既有能力身份不豁免新洞察的晋升要求。

## SemVer

- `0.1.0`：首版，九项 checklist，契约 `juchang-skill-checklist-verdict@1`。
- 变更纪律：规则集变更必须同步升版本并更新本文件；verdict 中 `skill.version` 与包版本一致，供 evidence 的 `skillInvocations[].version` 如实引用。
