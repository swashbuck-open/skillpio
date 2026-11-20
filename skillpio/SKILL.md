---
name: skillpio
description: Use when the user wants to make, improve or test a Claude skill about a library, framework, API, tool or fast-changing technical topic, especially "make a skill for X", "Claude keeps getting X wrong", "is my skill still needed", or checking what a model knows about a recent version.
---

# Skillpio: write a skill from what the model gets wrong

A skill should contain only what the model gets wrong. Skillpio measures that first, then writes the skill,
then checks the skill fixed the gaps without breaking anything the model already knew.

Run every command from the user's project folder. Work goes in `./skills/<name>/` unless
`SKILLPIO_SKILLS_ROOT` is set. `SG` below means `node <this skill's folder>/scripts/skillpio.mjs`.

**Other models.** Set `SKILLPIO_TARGET_CMD` to any command that reads a prompt on stdin and prints the answer
(`codex exec -`, `gemini -p`, `ollama run <model>`), and the target runs through it: build a skill for that model.
`SKILLPIO_ASSESSOR_CMD` does the same for the grader. Everything works this way except `verify-triggered`, which
uses Claude Code's own skill loader; `trigger-eval` is the model-neutral check.

**Needs:** Node 20+, and the `claude` CLI logged in (it runs the probes headless). Check with
`claude auth status`. If it says logged out or "OAuth session expired", the user runs `claude auth login`, or
makes a long-lived token once with `claude setup-token` and exports it as `CLAUDE_CODE_OAUTH_TOKEN` for the runs.
Never print the token. Models default to
`claude-sonnet-5-5` as the target and `claude-opus-5-5` as the assessor; override with `SKILLPIO_TARGET` and
`SKILLPIO_ASSESSOR`. The target should be the model that will use the skill: skills are model-specific.

**Cost:** a full build with the statistical design below is about 3,000–5,000 model calls (60–80 reserve probes
answered by four arms, plus the train loop); the train loop alone is about 150–1,000. Before starting, tell the user
that, and that the cheapest setting is Sonnet as assessor (`SKILLPIO_ASSESSOR=claude-sonnet-5-5`, about half the
cost, a less exacting grader).

**Caching is the standard way to load the skill** (owner, 15 Nov 2026). Every call in a build resends the same fixed
text: the skill (verify phases), the tool or no-tools instructions, tool definitions, and the grader's instructions with
`research.md`. Send it as a cached prefix, never as fresh input:
- Order every prompt fixed part first: tools, then system (instructions and skill text); for the grader, its instructions
  and the research notes. Only then the per-probe part (listed facts, request, answer). Nothing that changes per call
  (ids, run numbers, timestamps, a fresh temp-folder path for the skill's files) goes before that point. The skill
  lives in the cached system block, never in the user turn.
- The claude CLI caches its own system prompt, and skillpio's prompts are already ordered for it. Any
  `SKILLPIO_TARGET_CMD` / `SKILLPIO_ASSESSOR_CMD` adapter that calls the Messages API must put `cache_control` at the end
  of the fixed prefix: `{"type": "ephemeral"}`, or `{"type": "ephemeral", "ttl": "1h"}` when calls go through Message
  Batches or start more than 5 minutes apart.
- Check it after the first phase: on every call after the first, `cache_read_input_tokens` should be most of the input.
  Zero reads means something in the prefix changes between calls, or the prefix is under the model's minimum (512 tokens
  on current models, 4,096 on some older ones). Fix that before the big phases. A new skill version is a new prefix;
  its first call writes the cache again.
- Measured on the statistician build (14 Nov 2026): before caching, the grader resent 24M input tokens (about US$48 of
  its US$81); with the cached prefix, about 80% of grader input was read from cache.
  Its tool-using target first wrote the skill's base directory as a new temp folder on every call, which silently
  defeated the cache; a stable path per skill version fixed it (second call: 1,987 of 2,070 tokens read from cache).

## Statistical rigour, by default

Every build gets this design, whether or not the user asks for it. A score from a small test the author has seen
flatters the skill.
The procedures behind each point are in the Skillpio repo's `procedures/` (01 preregister, 03 sample size with
`power.mjs`, 04 statistics with `stats.mjs`, 05 arms, 12 reserved answers).

- **Plan first.** Write `skills/<name>/PLAN.md` before any probe is written or any scored run: the arms, the primary
  measure, the planned comparisons, the sample size and the bar. A change after that is dated in PLAN.md with its reason.
- **Three roles for data.** Build (facts, train probes, everything the skill is made from), develop (debugging; thrown
  away) and reserve (the probes the reported score comes from, once).
- **The reserve is written blind.** A separate agent or `claude -p` call writes it from `facts.json` only, never seeing
  the skill, the train probes or any answers. Keep it in `skills/<name>/reserve.json` with `"set": "reserve"`, calibrate
  it, then seal it: put the sha256 of the reserve probes in `RESERVE.md` and PLAN.md. Don't read the reserve probes or
  answers until the final score, and don't run any arm on it before then, bare included. Keep it out of `probes.json`
  until then, because `verify-injected` defaults to every set.
- **Size it.** Use `power.mjs` for 80% power over the planned comparisons with Holm correction, from the per-probe sd of
  an earlier reserve (with none, assume 0.16–0.20). State the effect it can detect. Expect 60–80 probes for three comparisons.
- **Arms.** Bare model, the new skill, a memory-written control (step 6b), and any existing skill on the topic. Runs
  per probe: bare 5, others 3, unless the power analysis says otherwise.
- **Primary measure and test.** Decision-fact error on the reserve, with the probe as the unit. Per-probe paired
  differences, 95% cluster bootstrap interval (10,000 resamples, fixed seed), sign-flip permutation test, Holm over
  the planned comparisons, two-sided, alpha 0.05. Write the scoring script before scoring and freeze it by sha256.
- **Freeze before scoring.** The skill, the control and the scoring script go in `loop.json` by sha256. The reserve is
  scored once; any change to the skill after that spends it, and the next score needs a new reserve.
- **Report everything.** All arms and all planned comparisons, whatever they show; the detectable effect from the
  observed sd; a missed bar as missed; a null in full. Misses read from the reserve after scoring never go into the skill.

## The loop

0. **Decide what the skill must perform, and test that.** A doing skill (code, upgrades, procedures, calculations,
   documents) is tested by doing the task with a machine check (`validate.mjs`, or a real environment: build, tests,
   end state). Knowledge questions test only skills whose job is advice. Never measure a doing skill with questions
   about it.
1. **Research.** First pull current official docs: `SG docs <name> --lib "<library>" --q "<topic>|<topic>|..."`
   with 4–8 queries covering setup, what changed in the latest version, and the parts people get wrong. It saves
   cited snippets to `skills/<name>/sources/` (Context7, no key needed; check `sources/context7-libraries.md` picked
   the right library, else re-run with `--id`). Then read `RESEARCH_SPEC.md` in this folder and follow it exactly.
   It produces `research.md`, `facts.json` and `probes.json`. Validate both JSON files parse.
   For a business topic, flag the facts that change what the user does (`"decision": true`) and give the rest a
   `context_reason`: the report then scores decision facts only. For a procedural topic (move lists, computed outputs,
   documents that must contain set items) also write `skills/<name>/validate.mjs`: default export
   `(probe, answerText) -> {outcome, detail}`; the pipeline replays every answer with it and shows the grader the verdict.
2. **Check the facts.** `SG check-facts <name>`. Read `facts-check.md`. Fix or drop every fact marked
   unsupported or partly supported. A wrong fact makes the grader punish correct answers and puts errors in the skill.
3. **Calibrate the probes.** `SG run <name> --phase calibrate`. Read `calibration.md`. A probe that fails with the
   answer key in front of the target is a bad probe: reword it or drop it.
4. **Measure.** `SG run <name> --phase baseline --runs 5`, then `SG report <name> --phase baseline`. This is the train
   set only: the sealed reserve is not run until step 9. A `holdout` set in `probes.json` (as `sweeps` and `optimize`
   use) is a develop check, not the reserve.
5. **Write.** Read `WRITING_RULES.md` in this folder, then `report-baseline.md`. Write `skills/<name>/skill/SKILL.md`
   from the "Gaps" section only. Leave out everything under "Already known".
6. **Verify.** `SG run <name> --phase verify-injected --runs 3`, then `SG compare <name>`. Fix regressions first
   (error up with the skill), then gaps still at 25% or more. Re-run verify after each revision, on every probe: an edit
   to one line can break another. Before each revision move the last verify to `runs/verify-injected-iterN` and record
   the iteration in `skills/<name>/loop.json` (what is done, what is open, which iteration the numbers come from).
   Include out-of-scope regression tasks or probes (topics the skill doesn't cover) in every verify, on the deployed
   system; a skill that makes any of them worse is not done. Decide revisions on facts outside their interval, and use 5 runs before a third pass; at 3 runs a fact graded a few
   times swings 0% to 50% by chance. Stop when decision-fact error is under the client's threshold and no decision fact
   got worse. Context facts never trigger an iteration.
   `compare` checks "got worse" for you and prints it at the top of `compare.md`: **READY** (no scored fact rose),
   **NOT READY** (a fact rose by more than chance explains, Fisher p < 0.05: fix it), or **NEEDS MORE RUNS** (a fact rose
   15 points or more but there are too few answers to tell: re-run verify with more `--runs`). It writes the same verdict
   to `loop.json`; never edit `regressions` there by hand. Hand over only on READY.
   Below the verdict, `compare` also lists **context facts that got worse**. They don't block, but they mean the skill
   crowded out something the model used to say. If the fact changes what the user does, it was mislabelled: flag it
   `"decision": true`. Either way, give it one line in its home section and re-verify.
   **When a fact got worse, search for the cause instead of guessing:** `SG optimize <name>` (add `--dry-run` first to
   see the plan and size, `--focus F24` to pick facts, `--gaps` to also work on facts still wrong). It shortlists the
   blocks most likely to blame, removes each in turn to find the culprit, races rewrites of it (cheap first round, more
   runs for the better half), keeps a red line on critical facts, and checks the winner on the holdout probes it never
   saw. It writes `optimized/SKILL.md` and `optimize.md`; it never touches `skill/SKILL.md`. Read `optimize.md` with
   the user, adopt the winner only if recommended, then verify everything and `compare` again.
   **Test the sweeping sentences.** `SG sweeps <name>` finds rules stated without limits, the exceptions the research
   supports (each backed by a checked quote), and adds a fact and two questions per exception: one for training, one
   reserved for the holdout. Run calibrate, baseline and verify on them with `--only <ids>` (it prints the commands),
   then `compare`. A sweep that makes its exception worse is false where it matters: `optimize`. Fixes are preferred at
   the fact's own sentence, then as a new line, then as a repeat elsewhere (penalised; `--repeat-penalty`, default 0.5);
   `SG repeats <name>` lists facts stated in more than one place.
6b. **Measure a control.** Write at least one skill the usual way on the same probes (ask a model for it from memory;
   better, one written after reading the official pages), verify it with the same command, and
   `SG blind-compare <name> --vs <control>`. Without a control, a good score could be any careful author's result.
7. **Check it loads when it should, and only then.** `SG trigger-eval <name>` shows the target a catalogue of skill
   descriptions and asks which it would load, for the probe requests (should load) and for near-miss requests
   (should not; written once to `trigger-negatives.json`, edit them if needed). Aim for 90%+ and under 10%.
   If it misses, `SG tune-description <name> --apply` proposes alternatives, tests them, and applies the best only if
   it also wins on held-out requests. With Claude Code you can also run the real loader:
   `SG run <name> --phase verify-triggered --runs 3`.
8. **Optional checks.**
   - Comparing two versions of a skill (say, long and short): put each in its own work folder with the same probes,
     verify both, then `SG blind-compare <a> --vs <b>`. The grader sees answer pairs in random order without labels.
   - NVIDIA SkillEvaluator: `SG evaluate <name>` runs its keyless static check; `--tier tier3` runs live agent
     trials with and without the skill (needs its provider set up; see its README). Install once:
     `uv tool install --python 3.13 "skillevaluator[all] @ git+https://github.com/NVIDIA/SkillEvaluator.git"`.
     Act on its errors (for example, names must not contain the reserved words "claude" or "anthropic"). Treat its
     low-severity advice to add Purpose, Limitations or Troubleshooting sections as advisory: padding a gap skill
     with general sections works against the point, and its own authors found static scores barely track live results.
9. **Score the reserve, once.** Freeze the skill, control and scoring script (sha256 in `loop.json`), check the
   reserve's hash still matches `RESERVE.md`, add the reserve probes to `probes.json`, and run every arm on them with
   `--set reserve` (bare with `--phase baseline --runs 5`, the others `--phase verify-injected --runs 3`, each in its
   own work folder with the same facts and probes). Set the reserve answers aside before any later train-only
   `compare`. Run the scoring script and write `reserve-result.md`.
10. **Write the scope.** `SG scope <name>` writes `skills/<name>/SCOPE.md` from the test data: the skill's kind (task
   or knowledge), the model it was tested with, its as-of date and version, the topics it is measured good at, usable
   or weak at (error per `facts.json` topic, with and without the skill), the facts it is known to fail with an example,
   topics with too little data, facts never tested, and that it is the bare model outside its topics. It reads the
   latest reserve set in `runs/verify-injected` (`--with`, `--without`, `--set` to change; `--target` and `--kind`
   unless `loop.json` records `target` and `kind`). Put what the data can't say (topics deliberately not covered and
   which skill to use instead, who has reviewed it) in `skills/<name>/scope-notes.md`; it is appended. SCOPE.md stays
   outside `skill/` and is never put into SKILL.md: it is built from the tests, and the test must not shape the skill.
   Re-run it after every scored run.
11. **Hand over.** Tell the user the reserve result first (every arm with its interval, the Holm p of each planned
   comparison, and the effect the study could detect), then the train before and after scores (decision-fact error first,
   when flagged), the iteration the numbers come from, the control's result, the word count, SCOPE.md, and how to install it: copy `skills/<name>/skill/` to
   `~/.claude/skills/<name>/`. Hand over the test set too (facts, probes, validator): maintenance is a full re-verify
   whenever a source or the model version changes, and the test set is what makes that repeatable.

**Test the bot as deployed.** If the skill will run in a bot with retrieval (Copilot Studio, a Foundry agent over an
index), set `SKILLPIO_TARGET_CMD` to an adapter for that bot with retrieval on, and log the retrieved documents after the
answer. Retrieval closes most knowledge gaps when the index is current and none of the "doing" gaps (applying a rule across
a long answer, computing a date, following a procedure). Expect the skill to earn its place on doing; grade those with a
validator, not prose.

Probe runs resume: answers already on disk are skipped. Delete `skills/<name>/runs/<phase>` to redo a phase.

**Long answers.** Hidden thinking counts against the CLI's output budget; the wrapper reads `stream-json`, stitches every
text block and sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000`, so a long answer is never only its tail. If a model still
splits an answer, the record's `resumed` count says so. `claude-haiku-5-5` works despite a model-catalog warning.

## Being honest about the numbers

The scores are probe scores from an LLM grader, not task results. When reporting them, say so. To check the
grader, `SG grade-sheet <name>` makes a sheet for the user to grade by hand with the grader's verdicts hidden,
and `SG agreement <name>` compares the two once the sheet is filled in.
