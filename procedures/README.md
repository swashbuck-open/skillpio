# Procedures: how we run Skillpio experiments

*Adopted 16 October 2026. Every study follows these; a deviation is allowed only if it is written in the study's plan
before the run, with the reason.*

The aim is engineering-grade evidence: results another person can re-run from the repo and get the same answer within
the stated intervals, and claims that survive the obvious objections (the author wrote both the skill and the test; the
harness caused the failures; the difference is noise).

| # | Procedure | One-line rule |
|---|---|---|
| 01 | [Pre-register](01-preregister.md) | Fix the question, arms, primary measure, comparisons and sample size before any run |
| 02 | [Build the test set](02-test-set.md) | Written blind by a separate author, answer key audited by another, gold and empty checks pass |
| 03 | [Sample size](03-sample-size.md) | Size by tasks, not trials; use `power.mjs` on a pilot |
| 04 | [Statistics](04-statistics.md) | Task is the unit; paired comparisons; cluster bootstrap and permutation; Holm across planned comparisons |
| 05 | [Arms and controls](05-arms-and-controls.md) | Always a no-skill baseline, a usual-practice control and a strong control; same budget and harness |
| 06 | [Harness validity](06-harness-validity.md) | Pilot first and discard it; check every failure class for artefacts before reading results |
| 07 | [Freeze and reproduce](07-freeze-and-reproduce.md) | Commit and hash everything before the run; keep every raw answer |
| 08 | [Report](08-report.md) | Effect sizes with intervals, every pre-registered test including nulls, caveats first |
| 12 | [Reserved answers](12-reserved-answers.md) | Every datum is build, develop or reserve; the reserve is sealed and scored once; the key never comes from build material |

[CHECKLIST.md](CHECKLIST.md) is the one-page version to tick through for each study.

Tools: [stats.mjs](stats.mjs) (the standard analysis) and [power.mjs](power.mjs) (tasks needed). Both read a τ-style runs
folder (`<runs>/<arm>/<task>_t<trial>.json` with `pass`); the probe pipeline's per-fact verdicts follow the same rules
with the fact, not the task, as the unit where facts are independent.
