# Writing rules (step 4 of the Skillpio loop)

You are writing a skill from a measured gap report (`report-baseline.md`). The target model already knows
everything under "Already known". Your job is the gaps, and nothing else.

These rules come from Skillpio's own verify runs and from obra/superpowers `writing-skills`
("no skill without a failing test first"). The report is the failing test.

## Budget

- **Start around 40 words per gap.** Every sentence must change what the target does: if you can't name the gap a
  sentence fixes, cut it. Long skills get skimmed, and SkillsBench found compact skills beat comprehensive ones.
- **But shorter is not free.** A 570-word rewrite of a 1,143-word skill matched it on the 0–10 score and lost a blind
  head-to-head 7 to 31: the longer one made answers raise more relevant pitfalls. When you cut a working skill, keep
  both and run `blind-compare`; keep the short one only if it holds up. Low-importance gaps can move to `references/`
  with one line in SKILL.md saying when to read them.

## Match the form to the failure

Each gap in the report has verdicts. Write it in the form that fixes that kind of verdict:

| What the target did | Write it as |
|---|---|
| **wrong**: used the old API, old default, removed option | The replacement first, then the old form as the thing not to use: "Use `X`. `Y` was removed in v8." |
| **missing**: left out a step it needed | A short recipe or code line, in the order it is done |
| **partial**: right direction, vague or mixed with old info | The one precise detail it lacked (a name, a number, a flag) |
| A recurring claim under "Totally wrong" | One line that states the true version |

## Rules that verification taught us

1. **Always say what TO do.** "X still works" can make a model treat the standard step as optional, and a fact it
   used to get right starts going wrong. Every nuance names the recommended action.
2. **Concrete beats general.** Name commands, APIs, parameters, file names, versions. No advice like
   "check the docs" or "be careful with".
3. **No restating known facts for context.** If the target needs one known fact to make sense of a gap,
   refer to it in a few words; don't explain it.
4. **One example, not several.** If code helps, one short, complete snippet in the user's language.
5. **Name the specific trap, not the habit.** "Track the state carefully" changes little; the exact condition that
   trips the model, plus a line that makes it check that condition, changes a lot.
6. **When the gap is bookkeeping, mandate the artefact.** Numbered steps, a checkpoint line at fixed intervals, a
   running count. Check the probes allow it ("lines starting with # are ignored"), or the skill fights the prompt.
7. **For recent rules, say "state as fact".** Models hedge ("I can't confirm this started") on rules in force for
   months. Give the current figure with its start date, and the old figure as the thing not to say.
8. **Edits interfere.** A sentence about one fact can make a neighbouring fact worse without mentioning it. When a
   verify shows a regression, edit the neighbourhood of the fact, not just the fact, and re-verify everything.
9. **Write to decision facts.** Facts flagged `decision: true` are the skill; a context fact earns a line only if a
   decision depends on it.
10. **A sweeping sentence must be true for every case it reaches, or say its limits.** A blanket rule applies itself
   to the exceptions too, and switches off the model's own search for them. "State these rules as fact" can make it
   overconfident on rules the skill doesn't cover. Scope it, name the exception, or say "check X first". `sweeps`
   tests this; see SKILL.md.
11. **Repeat a fact only when it measures better.** Fix a fact in its own sentence first, then with one new line; a
   second copy elsewhere is a last resort (`optimize` penalises it), and every copy must change when the source does.
12. **Write a rule with several conditions as ordered steps, with the outcome of each branch.** "Condition A met → the
   rule doesn't apply. A not met and B met → it applies unless C." In prose, a model keeps the conditions and flips one
   direction ("unless you fail" for "unless you pass"). If a rule is a decision tree, write the tree; if it must never
   be wrong, make it a gate in code.
13. **A skill moves attention, so it can crowd out what the model used to say unprompted.** A fact the bare model
   stated almost every time can drop sharply once the skill is loaded. When verify warns that a fact got worse, add
   one line for it in its home section, even though it was "already known".

## Frontmatter

```yaml
---
name: lowercase-hyphenated, matching the folder; never containing "claude" or "anthropic" (reserved)
description: Use when ... (the tasks and words that should trigger it). Say WHEN, never HOW.
---
```

The description is read every session to decide whether to load the skill. If it summarises the steps, agents
follow the summary and skip the body. Name the library and version, and the kinds of task.

## After writing

Count the words (`wc -w SKILL.md`) and say how many gaps it covers. Then run verify, and fix regressions
(facts whose error rate went **up** with the skill) before anything else.
