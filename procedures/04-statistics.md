# 04 · Statistics

Run `node procedures/stats.mjs <runs> --pairs <planned comparisons>`. It implements the following.

1. **Per arm:** pass^1 = mean over tasks of the per-task pass rate, with a 95% **cluster bootstrap** interval (resample
   tasks with replacement, 10,000 times). pass^k = share of tasks where every trial passed.
2. **Per planned comparison (paired):** arms run on the same tasks, so compare per-task pass rates: the mean difference,
   its bootstrap 95% interval, and a two-sided **sign-flip permutation test** on the per-task differences.
3. **Multiple comparisons:** Holm correction over the planned comparisons. Exploratory comparisons are reported without
   a verdict.
4. **Decision at alpha 0.05** after correction. Report the interval whatever the verdict; the interval is the result.
5. **Question probes** (the probe pipeline): decision-fact error per arm with a bootstrap interval resampling probes;
   paired comparisons on per-probe error. Blind head-to-heads: sign test on non-tied pairs (as `blind-compare` does).
6. **Never:** per-conversation intervals as the headline; one-sided tests chosen after seeing the direction; dropping a
   task after seeing its result; reporting a subset without saying it is one.

Seeds: `--seed` makes the bootstrap and permutation reproducible; report it.
