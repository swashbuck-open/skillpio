#!/usr/bin/env node
// How many TASKS a study needs (procedures/03-sample-size.md). Uses a pilot or earlier run to estimate the spread of
// per-task differences between two arms, then the normal approximation for a paired test:
//   tasks = ((z(1 - alpha/(2m)) + z(power)) * sd / delta)^2      (alpha Bonferroni-split over m planned comparisons)
//   node procedures/power.mjs <runs> --pair D-B [--delta 0.10,0.15,0.20] [--m 3] [--power 0.8]
import fs from "node:fs"; import path from "node:path";
const argv = process.argv.slice(2), dir = argv[0], opt = (k, d) => (argv.includes("--" + k) ? argv[argv.indexOf("--" + k) + 1] : d);
const [x, y] = opt("pair", "D-B").split("-"), m = +opt("m", 3), power = +opt("power", 0.8), alpha = +opt("alpha", 0.05);
const deltas = opt("delta", "0.05,0.10,0.15,0.20").split(",").map(Number);
const load = (a) => { const d = path.join(dir, a), r = {}; for (const f of fs.readdirSync(d).filter((f) => f.endsWith(".json"))) { const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); (r[j.task] ||= []).push(j.pass ? 1 : 0); } return r; };
const X = load(x), Y = load(y), mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const tasks = Object.keys(X).filter((t) => Y[t]); const d = tasks.map((t) => mean(X[t]) - mean(Y[t]));
const sd = Math.sqrt(d.reduce((s, v) => s + (v - mean(d)) ** 2, 0) / (d.length - 1));
// inverse normal (Acklam)
function z(p) { const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924], b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857], c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878], e = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742]; const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((e[0] * q + e[1]) * q + e[2]) * q + e[3]) * q + 1); }
  if (p > 1 - pl) return -z(1 - p); const q = p - 0.5, r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
const za = z(1 - alpha / (2 * m)), zb = z(power);
console.log(`pilot: ${x} vs ${y} on ${tasks.length} tasks; observed mean difference ${(mean(d) * 100).toFixed(0)} points, sd of per-task differences ${sd.toFixed(2)}`);
console.log(`alpha ${alpha} split over ${m} planned comparisons, power ${power}\n`);
console.log("difference to detect   tasks needed");
for (const dl of deltas) console.log(`${String(Math.round(dl * 100)).padStart(4)} points             ${Math.ceil(((za + zb) * sd / dl) ** 2)}`);
