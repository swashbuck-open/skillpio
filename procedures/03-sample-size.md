# 03 · Sample size

**The unit is the task.** Trials of the same task share almost everything, so they are not independent. When most tasks
are all-or-nothing (0/3 or 3/3), three trials per task carry little more information than one.

**Size by tasks.** Run `node procedures/power.mjs <pilot-runs> --pair X-Y --m <planned comparisons>` on a pilot or an
earlier study to estimate the spread of per-task differences, then pick the task count for the smallest difference that
would change a decision. Expect far more tasks to detect a 10-point difference than a 20-point one.

**Trials.** Use 3 per task as the default: enough to estimate pass^k and catch flaky tasks; going higher rarely helps
the task-level test. Use 5 when the study is about reliability (pass^k) itself.

**Budget check before committing.** Conversations = tasks × trials × arms. At about 30 s and a few cents per conversation
with Haiku as agent and Sonnet as simulator, 60 tasks × 3 × 4 arms = 720 conversations ≈ 2 hours at 6 in parallel.

**If you can't afford the size**, say so in the plan, run it anyway as an indication, and report the detectable effect
size ("this study can detect differences of about 25 points"); never report "no difference" as "the same".
