# P1b 报告：真实 Skill 调用 trace 补真（复赛一票否决缺口闭环）

- 运行日期：2026-09-02（UTC）
- 运行 ID：`p1b-dsh-local-20260902T1818Z`
- dispatchId：`cloud_crisis-sim-2014-east-art-center_p1b-dsh-local-20260902t1818z`
- 结论：**真实 Skill 包已建、真实执行、真实入证**。`skillInvocations` 不再省略：evidence_guard 岗通过 pwsh 真实执行确定性核对器，输出/包/权限清单三类哈希全部在组装时从真实文件重算，且被新增测试断言 ⑮ 独立重导复核。DRY-RUN 与 `--write` 均四门绿灯。

## 一、Skill 包结构

`scripts/crisis-sim/skills/artist-substitution-feasibility/`

| 文件 | 内容 |
|---|---|
| `SKILL.md` | 复赛口径全项：用途 / 输入 / 输出（契约 `juchang-skill-checklist-verdict@1`）/ 固定九项 checklist 规则表 / 调用条件 / 依赖（Node ≥22 标准库，零第三方零网络）/ 失败处理（规则未命中只能 unknown/fails，绝不报成立）/ 安全边界 / 复用价值 / SemVer 0.1.0 |
| `check.mjs` | 可执行核对器：真实读 preset + library JSON，计算两输入 sha256，按 `RULES` 数组逐项判定并附**真实匹配到的原文短句**（`matched` 字段取自数据本身）；`--out` 白名单限定 `output/crisis-sim/**`；零模型、零网络、零环境变量 |
| `authority.json` | 权限清单（`juchang-skill-authority@1`）：mayRead/mayWrite/forbidden 白名单，其 sha256 作为 `authoritySha256` 入证 |

试跑实测（2026-09-02T18:17:43Z，exit=0）：九项判定 = holds 1（fallback-route-viable）/ fails 5 / unknown 3，overallVerdict = `substitution_not_feasible_now`。

**治理口径**：本 Skill 是「已注册可用」的既有能力；演练故事里的 Skill **候选**（`skill-candidate-artist-substitution`，晋升门禁 `requiresSecondCase`）仍指新洞察的晋升流程，两者不冲突。测试 ⑩（candidate 保持未晋升）与 ⑮（既有 Skill trace 诚实）同绿。

## 二、运行证据路径（p1b 真实重跑）

全部在 `output/crisis-sim/run-p1b-dsh-local-20260902T1818Z/`：

- `dispatch.json`（真实合同函数生成）· `check-results.json`（四任务 check_task 全 effective=true）· `leader-review.json` · `human-decision-brief.md`（九节决策包）· `runtime-evidence.json`
- `tasks/…-01/` material_intake：11 facts / 4 conflicts / 10 unknowns
- `tasks/…-02/` evidence_guard：**真实执行** `node check.mjs --out …/skill-verdict.json`（exit=0，generatedAt=2026-09-02T18:25:07.786Z，晚于指挥端 18:17 试跑——Worker 独立真实调用）；receipt 含 `skillTrace`；交付物逐项引用九项判定
- `tasks/…-03/` entity_matcher：13 facts / 4 conflicts / 9 unknowns（allowed-private-hit 演示）
- `tasks/…-04/` approval_guard：10 facts / 3 conflicts / 10 unknowns（approve 拒绝演示 approval_denied_named_human_required）
- 编排脚本：`build-dispatch.mjs` / `validate-receipts.mjs` / `assemble-evidence.mjs`

### skillInvocations 如实填写（evidence 内，评估器零 issue 通过）

| 字段 | 值 | 来源 |
|---|---|---|
| `skillId` / `version` / `contract` | `artist-substitution-feasibility` / `0.1.0` / `juchang-skill-checklist-verdict@1` | 技能包真实身份 |
| `status` / `claimableAsFreshEvidence` | `succeeded` / `true` | check.mjs 真实 exit=0 且 verdict 校验通过 |
| `digest` | verdict 输出文件真实 sha256 | 组装时重算 |
| `bundleSha256` | 技能包三文件 {名:哈希} 稳定序列化的真实 sha256 | 组装时重算，测试 ⑮ 独立重导一致 |
| `authoritySha256` | authority.json 真实 sha256 | 组装时重算，测试 ⑮ 独立重导一致 |
| `invokedAt` | verdict.generatedAt（脚本真实执行时刻） | Worker 执行产出 |
| `runtime` / `executor`（扩展字段） | `dsh-local-session` / evidence_guard 子智能体经 pwsh 调用 | 诚实标注 |
| `inputSha256` / `outputPath` / `overallVerdict` / `counts`（扩展字段） | 两输入文件 sha256 / verdict 相对路径 / 真实判定结果 | verdict 本体 |

## 三、新回放 fixture

- 路径：`app/src/data/crisis-sim/verified-replay-cloud-crisis-sim-2014-east-art-center-p1b-dsh-local-20260902t1818z.json`
- 命令：`node scripts/crisis-sim/export-verified-replay.mjs <evidence> --dispatch <dispatch.json> --write`，exit=0
- 门禁：issues=0 · state=ready_for_human_review · canEnterHumanReview=true · 四项安全计数全零
- 摘要：rawExportSha256=`18c1fb5bcef07fb6382648e89ac13dafcbca50899d14c015de740e148662d786`；fixtureSha256=`bbdcad403506d83212a7be278cc796dae07e648eb72ac33f997fbe1e17a66f5d`；redactions=0
- 旧运行（p1，run-p1-dsh-local-20260902T1415Z）产物与 evidence 原样保留在 output/crisis-sim/，未改动；p1 当时为 DRY-RUN，从未写过 fixture，无旧回放文件受影响。

## 四、测试结果

`npm run test:crisis-sim`：**17/17 全绿**（346ms），含新增：

- ⑮ skillInvocations 诚实且含真实哈希：技能包三文件真实存在且自洽；check.mjs 静态断言无网络/环境变量访问；回放 fixture 的 `bundleSha256`/`authoritySha256` 与当前真实技能包重算值逐字节一致；`digest` 与真实 verdict 文件 sha256 一致；`runtime === "dsh-local-session"` 来源标注在场；`invokedAt` 可解析。
- 既有 ⑩（Skill Candidate 保持候选未晋升）不受影响，治理口径不漂移。

## 五、诚实声明（不变）

p1b 与 p1 同为**真实模型调用的 live agent run**，载体仍是 **DSH 本地会话子智能体编排**（evidence 顶层 `provenance.runtime = "dsh-local-session"`）；Skill 调用 trace 是**确定性脚本的真实执行**（零模型），不是模拟返回，也不是手写 receipt。未连接 CloudStudio/Matrix/TeamHarness 的事实不变。
