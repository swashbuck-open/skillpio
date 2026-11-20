# 01 · Pre-register

Write `<study>/PLAN.md` and commit it **before** the first scored run. It must contain:

1. **Question** in one sentence, and the population it generalises to (which bot, which kind of task).
2. **Arms**, each defined exactly (model id, system prompt file, skill file and its hash, retrieval on/off and index).
3. **Primary measure**, one only. For Skillpio studies: task pass rate (end state exactly right), or decision-fact error
   for question probes. Everything else is secondary and labelled so.
4. **Planned comparisons**, few (ideally ≤ 3), each as "arm X vs arm Y, expected direction". Unplanned comparisons may be
   reported but are labelled exploratory and get no significance claim.
5. **Predictions** with numbers where possible ("B under 70%"), so a result can contradict them.
6. **Sample size**: tasks and trials, with the `power.mjs` output that justifies them (03).
7. **Stopping rule**: the run ends when the planned conversations are done. No peeking-and-stopping, no extra trials
   because a result is close.
8. **Exclusions**: what counts as a harness error and is re-run (06), decided now.
9. **Change log**: any change after the plan is committed, dated, with whether it happened before or after seeing data.

A pilot (06) may change the harness; it may not change hypotheses after its results are seen, and its conversations are
discarded.
