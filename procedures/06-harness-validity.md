# 06 · Harness validity

Most surprising failures we have seen were the harness, not the model. Before reading any result:

1. **Pilot**: run 3–6 conversations per arm on a few tasks, read every transcript, fix the harness, discard the pilot.
2. **Known artefacts to check each time:**
   - The CLI injects the real date: the business date must be given to agent and simulator.
   - Hidden thinking can exhaust the output budget and the CLI resumes mid-answer: stitch the stream, raise the budget.
   - An answer that is only an attempted tool call (no tools available): re-run, don't score.
   - Validators can be wrong: test them on recorded passes and failures, both directions.
   - Official sites can block fetch tools; a fact check that "can't reach" a page is not a failed fact.
   - The simulated user can go off script (it may insist on something false). Keep it: it is realistic pressure;
     but count such conversations and report the number.
3. **Error classes**: a conversation that crashes (CLI error, timeout) is re-run up to twice and logged; it is never
   scored as a fail. A conversation that completes is always scored, however odd.
4. **Read failures before results**: for each arm, read at least one failed transcript per task and classify it as model,
   simulator, grader or harness. Grader or harness problems found after the run go in the change log and the affected
   tasks are reported both ways.
