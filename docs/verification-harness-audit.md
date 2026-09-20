# 外部验证 Harness 审计

本文记录工作区自有 `vibe-verification.json` 验证器的当前边界、已经验证的事实和仍然开放的通用问题。它描述 harness 能保证什么，不替外部脚本证明测试集充分或领域逻辑正确。

## 当前实现

| 边界 | 当前行为 | 证据 |
| --- | --- | --- |
| 清单发现 | 从当前电路目录向上寻找最近的 `vibe-verification.json`；要求 `vibe-logisim.verification/v1`，最多 32 项；`cwd` 必须位于清单目录内；超时为 1–600 秒。 | `circuit-plugin-contract.py` 的 workspace verifier 测试。 |
| 结果身份 | 结果绑定 project、revision、circuit、artifact SHA 和 runtime profile，并记录清单原始字节 SHA、规范化 recipe SHA。`list_verifications` 也返回这两个摘要。 | `verification-hardening.py::test_result_carries_manifest_and_recipe_identity_hashes`。 |
| 材料包 | 运行前核对冻结 artifact、JAR 和资料资源，再复制到一次性目录；`${artifact}`、`${source}`、`VIBE_LOGISIM_SOURCE` 都指向该 disposable 输入。用户源文件不作为验证器输入路径。 | `test_artifact_mutation_cannot_be_reported_as_passed` 确认验证器改写输入后不能通过，且源文件不变。 |
| 运行生命周期 | POSIX 下验证器运行在独立 session；超时先终止进程组，必要时强制终止，并回收 stdout/stderr。 | `test_timeout_returns_unknown_and_reaps_verifier_process_tree` 通过 `/proc` 检查子进程退出。 |
| 完整性 | 运行后核对 materialized artifact、清单和源文件摘要；任一变化都降级为 `unknown`，不把结果当作电路反例。 | `VerificationService.run` 的完整性分支；异常输入测试。 |
| 状态解释 | `exit-code` 的 0/非 0 映射为 `passed`/`failed`；`json-status` 必须输出合法状态，且非零退出码即使输出 `passed` 也只能是 `unknown`；超时是 `unknown`。 | `test_nonzero_json_verifier_cannot_claim_passed`。 |

## 仍然存在的边界

1. **验证器代码的身份仍不完整。** 结果绑定 manifest 和 recipe，但命令引用的 Python/Java 脚本、外部工具、解释器和工作区依赖没有自动形成 `oracleSha256` 文件清单。相同 recipe 下替换脚本，harness 目前只能知道命令没变，不能证明 oracle 字节没变。

2. **外部脚本仍有工作区权限。** `cwd` 是清单目录内的真实目录，脚本可以读取或修改其他工作区文件。harness 保护了当前源文件、清单和 disposable 输入的“不能悄悄改变后仍声称通过”边界，但没有把任意工作区写入变成沙箱，也没有假装自己提供了 OS 级隔离。

3. **执行状态与领域 verdict 需要由消费端采用分层字段。** 结果现在同时提供 `execution: completed|timed-out|identity-changed|failed-to-start` 与 `verdict: passed|failed|unknown`，并保留顶层 `feedback.status` 兼容旧投影。UI 和模型可以区分“电路被 oracle 判错”和“oracle 没有形成可靠结论”。

4. **输出在进程结束后才截断。** 返回给模型的 stdout/stderr 有 16 KiB 上限，但运行期间仍由 pipe 收集全部输出。恶意或失控的验证器可以制造过大的内存压力；后续应采用运行期间有界收集并保留 `truncated` 标记。

5. **验证器的领域充分性不属于 harness。** harness 可以证明某个版本的输入包确实被某条命令运行并返回某个合法状态，不能证明脚本覆盖了所有输入、期望本身没有写错，或课程要求已经被完整表达。那需要外部 oracle 自己提供覆盖说明和独立材料。

## 下一步判断标准

通用能力继续演进时，优先满足以下可复核问题：

- 结果能否回答“究竟哪一份 oracle 代码和依赖产生了这个 verdict”；
- 超时、启动失败、身份变化能否与“电路确定失败”分层表达；
- 失控脚本能否在有限资源内结束，且不会修改产品工作区；
- 一个自由的模型/用户轨迹能否在最后选择运行验证，而不被强制变成每次修改都验证的状态机；
- 课设、个人回归脚本和其他电路是否都只需替换材料与 oracle，而不需把领域规则写进插件。

## 运行证据

```text
python3 -m unittest -v apps/desktop/test/circuit-plugin-contract.py
Ran 4 tests ... OK

python3 -m unittest -v apps/desktop/test/verification-hardening.py apps/desktop/test/verification-execution-contract.py
Ran 10 tests ... OK
```

这两组测试证明当前实现的材料包、结果身份、进程组超时和非零 JSON 状态边界；它们不证明外部验证器的领域逻辑正确，也不证明有限测试集等于课程任务的完整验收。
