# 12 · Reserved answers: one method for every study

*Adopted 23 October 2026 (owner: "formalise the method; no more ad hoc"). It sits on top of 01–08: those say how to
plan, test, size, analyse and report; this one says **which data may touch what**, and **which arms are compared**.
A deviation must be written in the study's PLAN.md before the run, with the reason.*

## 1. Every piece of data has exactly one role

| Role | What it is for | Who may see it |
|---|---|---|
| **Build** | Anything a skill is made from: research sources, facts, probes, worked examples, failures a skill is written from | the skill's author and its optimiser |
| **Develop** | Debugging the harness, the judge or the pipeline; trying ideas | us; results are thrown away |
| **Reserve** | The answers the reported score is computed on, once | nobody, until the scoring script runs |

The reserve is disjoint from build and develop **by every unit that could carry the answer across**: the case, its
combination of input values, its generator seed, and its time period. A skill that has seen a reserved case, seed or
period is not scored on it.

## 2. How to reserve, by kind of data

| Data | Reserve by |
|---|---|
| Records with dates | **Time**: build ≤ cut-off date < reserve |
| Generated cases (sampler, simulator, puzzle generator) | **Seed**: develop, build and reserve seeds are different numbers, fixed in PLAN.md |
| A published rule with an official tool | The tool's answers on reserved cases; the skill may draw on the published rule, never on the reserved answers |
| Public benchmarks whose answers are online | Fresh instances from the generator, or items dated after the model's cutoff |

## 3. Where the key comes from

The key must not come from the skill's build material. Two allowed routes:
1. **An outside authority**: a published rule and its official tool, a third party's tests.
2. **The reserve itself**: when key and build share one source, the key for a reserved case is computed **only from
   reserved records**, never from the build period.

Write the key's source, and the check that it is right, in PLAN.md.

## 4. Sealing the reserve

1. The reserve file is created by a script with its seed or cut-off, hashed, and the hash goes in PLAN.md.
2. No agent, skill author or researcher reads it. Agent briefs name it as off-limits.
3. Test prompts for reserved cases may be written and checked (that is case construction), but their answers are not
   shown to anyone building a skill.
4. The scoring script runs **once** per registered run. Its output is the result.
5. **If anything changes after the reserve has been scored** (skill, prompt, judge, threshold), that reserve is spent.
   A new score needs a new reserve (new seeds, a later period). The old score stays in the report.

## 5. The arms

| Arm | What it adds | Built from |
|---|---|---|
| **Bare model** | nothing | – |
| **Bare Skillpio** | a skill from the standard loop: research → facts → question probes → baseline → write gaps → verify | research sources and probes (build) |
| **Specialised Skillpio** | a skill written from the model's failures on the **task** | build cases only |

The bare model is always run as the baseline. Controls from 05 (usual practice, a strong researched skill, a
length-matched placebo) are added as the question needs.

## 6. Instruments are built on develop data, then frozen

- **Case writers and readers**: built and checked on develop cases; a reserved case is used only if its check passes;
  dropped cases are counted and listed.
- **LLM judges**: calibrated on develop items, read by hand in both directions, then frozen (version in PLAN.md).
- **Optimisers**: every fix is found on develop data, dated and logged with its reason.

## 7. Bars and comparisons are fixed before the reserve exists

PLAN.md states, before any reserved run: the primary measure, at most three planned comparisons (Holm), the success
bar, the sample size and the stopping rule (01–04). A missed bar is reported as missed, not moved.

## 8. Report

Caveats first (08); every arm run, with its reserved score and interval; develop results only as "development, not
evidence"; which reserves are spent; dropped cases; cost and time per answer.
