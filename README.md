# Skillpio

Skillpio writes a Claude skill from what the model gets wrong.

A skill works best when it holds only what the model doesn't already know. Skillpio works in that order:
1. It tests the model on the topic first.
2. It writes a skill that covers only the gaps it found.
3. It checks that the skill fixed those gaps and didn't break anything the model already got right.

The final score comes from a sealed test set that was written blind and is scored once.

## What's here

| Path | What it is |
|---|---|
| `skillpio/SKILL.md` | The maker skill. Claude follows it to build, test and hand over a new skill. |
| `skillpio/RESEARCH_SPEC.md` | How to gather facts and write test questions (probes). |
| `skillpio/WRITING_RULES.md` | How to write the skill once the gaps are known. |
| `skillpio/scripts/skillpio.mjs` | The command-line tool the maker runs (probes, grading, reports, comparisons, scope). |
| `procedures/` | The test method: preregistration, test sets, sample size, statistics, arms and controls, harness checks, freezing, reporting, sealed reserves. |
| `procedures/power.mjs` | Works out how many probes a study needs. |
| `procedures/stats.mjs` | Paired bootstrap intervals, sign-flip permutation tests and Holm correction. |

## Needs

- Node 20 or later.
- The `claude` CLI, logged in (`claude auth status`). Skillpio runs the probes through it headless.
- Other models also work: set `SKILLPIO_TARGET_CMD` to any command that reads a prompt on stdin and prints the answer,
  for example `codex exec -`, `gemini -p` or `ollama run <model>`. See `skillpio/SKILL.md`.

## Install

Copy the `skillpio/` folder into your Claude skills folder:

```bash
cp -R skillpio ~/.claude/skills/skillpio
```

Keep `procedures/` somewhere you can find it. The maker points to it for the statistics, and its two scripts run with
plain Node.

## Use

In Claude Code, from your project folder, ask for a skill:

> Make a skill for <library, API, tool or topic>.

Claude follows `skillpio/SKILL.md` and works in `./skills/<name>/`:

1. Research and check the facts.
2. Measure the bare model.
3. Write the skill and verify it.
4. Check that the skill loads when it should, and only then.
5. Score the sealed reserve once.
6. Write `SCOPE.md`, which lists what the skill is good at and where it is known to fail.

You can also run the tool by hand:

```bash
node skillpio/scripts/skillpio.mjs <command> <skill-name>
```

## Cost

A full build with the default statistical design takes about 3,000–5,000 model calls. The train loop alone takes about
150–1,000. To roughly halve the cost, use Sonnet as the grader (`SKILLPIO_ASSESSOR=claude-sonnet-5-5`). The grading is
then less strict.

## Licence

Apache License 2.0. See `LICENSE` and `NOTICE`.
