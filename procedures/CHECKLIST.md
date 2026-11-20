# Study checklist

Before
- [ ] Every dataset labelled build, develop or reserve; reserve split by case, combination, seed and time as applicable (12)
- [ ] Key source written: outside authority, or computed from reserved records only (12 §3)
- [ ] Reserve file created by script, hashed in PLAN.md, named off-limits in every agent brief (12 §4)
- [ ] Arms named (12 §5); bare model included
- [ ] PLAN.md: question, arms, one primary measure, ≤ 3 planned comparisons, numeric predictions, stopping rule, exclusions
- [ ] Tasks written blind by a separate author; in/out-of-scope labelled; held-out split if a skill will be revised
- [ ] Answer key computed by code, reproduces official worked examples, audited independently
- [ ] Gold passes 100%, empty passes 0%
- [ ] Controls: baseline, usual practice, strong control, deployed setting
- [ ] `power.mjs` on a pilot or earlier run; task count justified (or detectable effect stated)
- [ ] Pilot run, every transcript read, harness fixed, pilot discarded
- [ ] Commit; hashes, model ids, CLI version and command recorded in PLAN.md

During
- [ ] Fixes found on develop data only, each dated with its reason; the reserve scored once; any later change spends it (12 §4–6)
- [ ] No changes to tasks, grader, prompts or arms; no early stopping; crashes re-run, never scored

After
- [ ] Failures read and classified (model / simulator / grader / harness)
- [ ] `stats.mjs` with the planned pairs and a fixed seed
- [ ] SUMMARY.md: headline with interval, caveats first, every prediction, in/out of scope, limits, reproduce
- [ ] Raw runs kept; nothing overwritten
