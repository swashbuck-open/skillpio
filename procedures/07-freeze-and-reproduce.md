# 07 · Freeze and reproduce

Before the scored run:
- Commit the plan, tasks, environment, grader, skills, corpus and runner. Record the commit hash in the plan.
- Record: model ids (agent, simulator, grader), CLI version, skill file hashes (`shasum -a 256`), corpus size, the exact
  command line, date, concurrency.

During and after:
- Keep every conversation as JSON (transcript, tool log, end state, grade). Never overwrite a scored run; a new run gets
  a new folder.
- Generated reports are regenerated from raw data; written conclusions live in a separate file (`SUMMARY.md`) so a
  regeneration can't overwrite them.
- Cost and time per arm go in the results.

Reproduce = check out the commit, run the recorded command, run `stats.mjs`; the new intervals should overlap the old.
