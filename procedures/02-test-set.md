# 02 · Build the test set

**Test what the skill will be expected to perform.** Decide first what the skill is for, and make the test that job.
- A **doing** skill (write or change code, upgrade a project, run a procedure, produce a document or a calculation) is
  tested by **doing the task**: the agent works in a real or realistic environment and a program checks the result
  (it builds, the tests pass, the state is right, the document has its parts). Knowledge questions about the topic are
  not a test of a doing skill: they measure whether it can talk about the job, not whether it does it.
- An **advising** skill (answer a person's question, such as tax, legal or safety advice) is tested by realistic questions
  graded against the answer key, because advice is its job.
- A skill that does both is tested on both, reported separately.
Advice questions can mark a doing skill wrong for a deliberate, correct choice (for example, avoiding an interactive
command an agent can't answer). Only the task, with a program checking the result, can settle that.

**Independence.** The person or agent that writes the tasks must not have seen the skill under test, its facts, or any
result. Brief them on the domain and, if needed, on topics to avoid, nothing more. (When one author writes both, the test is home
ground for the skill.)

**Coverage, stated up front.** Label each task in-scope or out-of-scope for each skill under test, and report the two
subsets separately. A skill that helps in scope and hurts out of scope is a different result from one that only helps.

**Answer key.**
- Computed by code from stated rules (a rules engine), never typed by hand.
- Each rule cited to a primary source; where the source has worked examples, the engine
  must reproduce them exactly.
- Audited by a second independent agent or person who looks for wrong values, ambiguity, and grader unfairness in both
  directions (a correct agent failing on format; a wrong agent passing).
- Self-checks committed with the set: gold actions pass 100%; an empty run passes 0%.

**Graders.** Grade actions by program wherever the outcome is an action or a number. Tolerate formatting (cents rounding,
date and year formats, enum spellings), never substance. Forbid extra writes (no extra pay runs or payments).

**Splits.** Keep a held-out set that is never used to write or revise a skill. Report on held-out tasks for any claim
about a revised skill.

**Size.** See 03. Prefer more tasks over more trials.
