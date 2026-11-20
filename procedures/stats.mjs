#!/usr/bin/env node
// Standard analysis for a τ-style run (procedures/04-statistics.md).
//   node procedures/stats.mjs <runs> [--pairs C-B,D-B,D-E] [--tasks X01,X02] [--boot 10000] [--seed 1]
// Unit of analysis: the TASK (trials within a task are correlated). For each arm: pass^1 with a 95% cluster-bootstrap
// interval (resampling tasks). For each pair of arms run on the same tasks: the mean per-task difference in pass rate,
// a bootstrap 95% interval, and a two-sided paired sign-flip permutation p-value; Holm correction across the pairs.
import fs from "node:fs"; import path from "node:path";
const argv = process.argv.slice(2), dir = argv[0];
const opt = (k, d) => (argv.includes("--" + k) ? argv[argv.indexOf("--" + k) + 1] : d);
const B = +opt("boot", 10000); let seed = +opt("seed", 1);
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const only = opt("tasks", null)?.split(",");
const recs = fs.readdirSync(dir).flatMap((a) => fs.statSync(path.join(dir, a)).isDirectory() ? fs.readdirSync(path.join(dir, a)).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, a, f), "utf8"))) : []).filter((r) => !only || only.includes(r.task));
const arms = [...new Set(recs.map((r) => r.arm))].sort();
const rate = {}; // rate[arm][task] = pass rate over trials
for (const r of recs) { ((rate[r.arm] ||= {})[r.task] ||= []).push(r.pass ? 1 : 0); }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (x) => `${Math.round(x * 100)}%`;
console.log(`${recs.length} conversations, arms ${arms.join(" ")}, unit = task, ${B} bootstrap resamples\n`);
console.log("arm  tasks  trials  pass^1  95% CI (cluster bootstrap)  pass^k (all trials)");
for (const a of arms) {
  const tasks = Object.keys(rate[a]), per = tasks.map((t) => mean(rate[a][t]));
  const boots = Array.from({ length: B }, () => mean(Array.from(tasks, () => per[Math.floor(rnd() * per.length)])));
  const allk = tasks.filter((t) => rate[a][t].every((x) => x === 1)).length;
  console.log(`${a.padEnd(4)} ${String(tasks.length).padEnd(6)} ${String(recs.filter((r) => r.arm === a).length).padEnd(7)} ${pct(mean(per)).padEnd(7)} ${pct(q(boots, 0.025))}–${pct(q(boots, 0.975))}`.padEnd(54) + `${allk}/${tasks.length}`);
}
const pairs = (opt("pairs", null)?.split(",") || arms.flatMap((a, i) => arms.slice(i + 1).map((b) => `${b}-${a}`))).map((p) => p.split("-"));
const res = pairs.map(([x, y]) => {
  const tasks = Object.keys(rate[x] || {}).filter((t) => rate[y]?.[t]);
  const d = tasks.map((t) => mean(rate[x][t]) - mean(rate[y][t])), obs = mean(d);
  const boots = Array.from({ length: B }, () => mean(Array.from(tasks, () => d[Math.floor(rnd() * d.length)])));
  let extreme = 0; for (let i = 0; i < B; i++) { const m = mean(d.map((v) => (rnd() < 0.5 ? -v : v))); if (Math.abs(m) >= Math.abs(obs) - 1e-12) extreme++; }
  return { x, y, n: tasks.length, obs, lo: q(boots, 0.025), hi: q(boots, 0.975), p: (extreme + 1) / (B + 1) };
});
// Holm
const order = res.map((r, i) => [r.p, i]).sort((a, b) => a[0] - b[0]); let run = 0;
order.forEach(([p, i], k) => { run = Math.max(run, Math.min(1, p * (res.length - k))); res[i].pHolm = run; });
console.log(`\npaired difference (x minus y), per-task pass rates, ${res.length} comparison(s), Holm-adjusted`);
console.log("x-y   tasks  diff    95% CI           p        p (Holm)  verdict at 0.05");
for (const r of res) console.log(`${(r.x + "-" + r.y).padEnd(6)}${String(r.n).padEnd(7)}${(r.obs >= 0 ? "+" : "") + pct(r.obs)}`.padEnd(21) + `${pct(r.lo)} to ${pct(r.hi)}`.padEnd(17) + `${r.p.toFixed(4).padEnd(9)}${r.pHolm.toFixed(4).padEnd(10)}${r.pHolm < 0.05 ? (r.obs > 0 ? r.x + " better" : r.y + " better") : "no reliable difference"}`);
