# Research spec (step 1 of the Skillpio loop)

You are building the **ground truth** for one skill. A target model (Claude Sonnet 5.5, no tools,
no web access) will later be asked your probe prompts, and an assessor (Claude Opus 5.5) will grade
its answers against your facts. Only what the target gets wrong ends up in the final skill, so the
quality of everything downstream depends on your facts being **correct, current and sourced**.

Use today's date. Prefer official docs, changelogs, release notes and migration guides over blogs.

**Start from current docs.** If `sources/` holds Context7 files (made by the `docs` step), read them first: they are
snippets of the library's official documentation for its current version, each under a `Source:` line. Cite that
Source URL for any fact you take from a snippet. Use web search after that, for release notes, changelogs, dates and
the common mistakes people report, which docs don't cover.
When sources disagree, say so and prefer the primary source. Note the version / date each fact applies to.

Write exactly these three files into the skill folder you were given:

## 1. `research.md`
Human-readable notes: what the current state of the topic is, what changed recently, and the
common mistakes people report AI coding assistants making on it (forums, GitHub issues, blog posts).
Every claim gets a source URL. Keep it under ~400 lines.

## 2. `facts.json`
```json
[
  {"id": "F01", "fact": "one precise, checkable statement", "importance": "critical|important|nice",
   "recent": true, "source": "https://..."}
]
```
- 20–35 facts. Each must be precise enough that an assessor can say correct / partial / wrong.
- **One claim per fact, and its source must state it.** "v8 needs Node 22 (v7 needed Node 20)" is two facts: if
  the old figure is on another page, make it its own fact with that source. The fact check (step 1b) flags compound facts.
- Cover the core of the topic, not only the new parts: we need to know what the model already knows too.
- Mark `recent: true` for anything changed in roughly the last 18 months (likely past the model's training data).
- Include the specific "trap" facts: things that used to be true and are now wrong (old syntax, renamed APIs,
  removed options, changed defaults, new requirements).
- **Decision facts.** For a business or procedural topic add `"decision": true` to every fact that changes what the user
  does (a date, an amount, a yes or no, which tool or channel), and `"decision": false, "context_reason": "..."` to the
  rest. The report scores decision facts only; context facts are listed but never trigger a revision.
- Sources that refuse fetch tools (ato.gov.au returns 403) are fine: `check-facts` downloads the page with a browser user
  agent and reads the saved copy. Cite the page, not a search summary.

## 3. `probes.json`
```json
[
  {"id": "P01", "set": "train|holdout", "prompt": "...", "facts": ["F01", "F07"]}
]
```
- Train probes: enough that every decision fact is tested at least once (often 40–60). An optional `holdout` set
  here is a develop check for `optimize` and `sweeps`, testing the same facts with different wording. The reserve the
  final score comes from is not written here: a separate author writes it later from `facts.json` only (SKILL.md,
  "Statistical rigour, by default").
- **First decide what the skill is for, and test that** (procedures/02). If it will be used to *do* something (write
  code, change a project, follow a procedure, compute a result), the probes are those tasks, each with a `check` the
  validator can run (build, tests, a computed value, required parts): never knowledge questions about the topic. Only a
  skill whose job is to advise a person is probed with questions. Say in research.md which kind this skill is.
- Mostly **realistic tasks** a developer would give a coding agent ("Set up X in my project", "Write the
  config for Y", "Why does Z fail?"), plus a few direct knowledge questions. Tasks reveal real behaviour better.
- **Never leak the answer** in the prompt. Don't name the new API if the test is whether the model knows it.
  Don't say "in version N, which changed X". Do state the version the user is on, as a real user would.
- Each probe lists the fact ids it can reveal. Every critical fact must be covered by at least one train
  and one holdout probe.
- Prompts must be answerable in text without running anything.
- **Checkable probes.** When the answer is a move list, a computed value or a document with required parts, give the probe
  a `check` object with the instance data and write `validate.mjs` (see SKILL.md). Add "Lines starting with # are
  ignored, so you may use them for notes" to such prompts so a skill can ask for bookkeeping lines without breaking the
  format; `{"kind": "none"}` marks knowledge probes the validator skips.

Validate both JSON files parse (`node -e "JSON.parse(require('fs').readFileSync('facts.json'))"`).
Finish with a 5-line summary: topic state, the riskiest trap facts, any facts you are unsure of.
