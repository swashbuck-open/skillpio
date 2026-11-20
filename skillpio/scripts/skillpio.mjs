#!/usr/bin/env node
// Skillpio: gap-driven skill generation.
//   1. research   -> skills/<name>/{research.md, facts.json, probes.json}   (done by a research agent)
//   2. probe      -> target model (Sonnet 5.5, no tools) answers each probe N times
//   3. assess     -> assessor (Opus 5.5) grades every answer against facts.json
//   4. report     -> per-fact error rates + variance -> gaps.md  (Claude writes SKILL.md from it)
//   5. verify     -> re-probe WITH the skill (injected, or installed and left to trigger) and re-assess
//
// Usage:
//   node pipeline/skillpio.mjs run    <skill> --phase baseline [--runs 5] [--set train|holdout|all]
//   node pipeline/skillpio.mjs run    <skill> --phase verify-injected  [--runs 3] [--set all]
//   node pipeline/skillpio.mjs run    <skill> --phase verify-triggered [--runs 3] [--set all]
//   node pipeline/skillpio.mjs report <skill> --phase baseline
//   node pipeline/skillpio.mjs compare <skill>
//   node pipeline/skillpio.mjs check-facts <skill>                 (step 1b: does each source support its fact?)
//   node pipeline/skillpio.mjs run <skill> --phase calibrate       (step 1c: can a perfect answer score full marks?)
//   node pipeline/skillpio.mjs grade-sheet <skill> [--n 30]        (sheet for a human to grade, assessor hidden)
//   node pipeline/skillpio.mjs agreement <skill>                   (human vs assessor, after the sheet is filled in)
//   node pipeline/skillpio.mjs docs <skill> --lib X --q "a|b"      (step 1a: version-specific docs from Context7)
//   node pipeline/skillpio.mjs trigger-eval <skill>                (does the description load it when it should? any model)
//   node pipeline/skillpio.mjs tune-description <skill> [--apply]  (propose and test better descriptions)
//   node pipeline/skillpio.mjs blind-compare <skill> --vs <other>  (A/B the two skills' answers, labels hidden)
//   node pipeline/skillpio.mjs evaluate <skill> [--tier tier3]     (NVIDIA SkillEvaluator)
//   node pipeline/skillpio.mjs optimize <skill> [--focus F24,F33]  (find the sentence behind a regression, race fixes)
//   node pipeline/skillpio.mjs sweeps <skill> [--max 4]            (sweeping sentences: find exceptions, add test questions)
//   node pipeline/skillpio.mjs repeats <skill>                     (facts stated in more than one place)
// Steps can also be run alone: probe | assess | report.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const TARGET = process.env.SKILLPIO_TARGET || "claude-sonnet-5-5";
const ASSESSOR = process.env.SKILLPIO_ASSESSOR || "claude-opus-5-5";
const CONCURRENCY = Number(process.env.SKILLPIO_CONCURRENCY || 6);

const [cmd, skill, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(
  rest.join(" ").split(/(?:^|\s)--(?=[a-z])/).filter((x) => x.trim()).map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.length ? v.join(" ") : true])
);
// blind-compare judges two skills, so its default is their with-skill answers; everything else starts at baseline.
const phase = opt.phase || (cmd === "blind-compare" ? "verify-injected" : "baseline");
const runs = Number(opt.runs || (phase === "baseline" ? 5 : phase === "calibrate" ? 1 : 3));
const set = opt.set || (phase === "baseline" ? "train" : "all");

if (!cmd || !skill) {
  console.error("usage: skillpio.mjs <run|probe|assess|report|compare|scope> <skill> [--phase X] [--runs N] [--set S]");
  process.exit(1);
}
// Work folders live in SKILLPIO_SKILLS_ROOT, or ./skills under the folder you run from.
const dir = path.join(process.env.SKILLPIO_SKILLS_ROOT || path.join(process.cwd(), "skills"), skill);
const phaseDir = path.join(dir, "runs", phase);
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
// `scope` also runs on skills with no test data (it says so in SCOPE.md), so missing facts or probes are allowed there.
const haveTests = fs.existsSync(path.join(dir, "facts.json")) && fs.existsSync(path.join(dir, "probes.json"));
if (!haveTests && cmd !== "scope") { console.error(`no facts.json / probes.json in ${dir}`); process.exit(1); }
const facts = haveTests ? JSON.parse(read("facts.json")) : [];
// --only P15,P16 runs just those probes (for example new ones from sweeps), whatever their set.
const probes = (haveTests ? JSON.parse(read("probes.json")) : []).filter((p) => (opt.only ? String(opt.only).split(",").includes(p.id) : set === "all" || p.set === set));
const factById = Object.fromEntries(facts.map((f) => [f.id, f]));
// Optional programmatic check: skills/<name>/validate.mjs exporting default (probe, answerText) -> {outcome, detail}.
// For procedural probes (move lists, code that must parse, exact outputs) it replays the answer and the assessor is
// shown the result, so legality and completeness are not left to the grader's reading of a 255-line answer.
const validatorFile = path.join(dir, "validate.mjs");
const validator = fs.existsSync(validatorFile) ? (await import(validatorFile)).default : null;
async function check(p, answer) {
  if (!validator) return undefined;
  try { return await validator(p, answer); } catch (e) { return { outcome: "CHECK_ERROR", detail: e.message.slice(0, 200) }; }
}

// ---------- claude CLI wrapper ----------
// Long answers: hidden thinking counts against the CLI's output budget; when it is hit the CLI auto-resumes and
// `result` holds only the last message. So raise the budget (CLAUDE_CODE_MAX_OUTPUT_TOKENS, overridable) and read
// the stream, stitching every assistant text block in order.
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ||= "64000";
function claude(args, { cwd, input } = {}) {
  // The prompt goes in on stdin: variadic flags like --tools would otherwise swallow it.
  return new Promise((resolve, reject) => {
    const p = spawn("claude", ["-p", "--no-session-persistence", "--output-format", "stream-json", "--verbose", ...args], {
      cwd: cwd || os.tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    p.stdin.end(input);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      const events = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const j = events.find((e) => e.type === "result");
      if (!j) return reject(new Error(`claude exited ${code}: ${err.slice(0, 500)} ${out.slice(-500)}`));
      if (j.is_error) return reject(new Error(j.result || "claude error"));
      const text = events.filter((e) => e.type === "assistant").flatMap((e) => e.message?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      resolve({ ...j, result: text || j.result, resumed: events.filter((e) => e.type === "user").length });
    });
  });
}

// ---------- any-model runner ----------
// Set SKILLPIO_TARGET_CMD (or SKILLPIO_ASSESSOR_CMD) to any shell command that reads a prompt on stdin and prints the
// answer, and that role runs through it instead of the claude CLI. Examples:
//   SKILLPIO_TARGET_CMD='codex exec -'      SKILLPIO_TARGET_CMD='gemini -p'      SKILLPIO_TARGET_CMD='ollama run qwen3'
// The skill text and instructions are then put at the top of the prompt, since a generic command has no system-prompt flag.
const CMD = { target: process.env.SKILLPIO_TARGET_CMD, assessor: process.env.SKILLPIO_ASSESSOR_CMD };
const roleName = (role) => CMD[role] ? `\`${CMD[role]}\`` : role === "target" ? TARGET : ASSESSOR;

function shellCmd(cmd, input) {
  return new Promise((resolve, reject) => {
    const p = spawn("sh", ["-c", cmd], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    p.stdin.end(input);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`)));
  });
}

// Generic CLIs print banners and warnings (sometimes with JSON in them) around the answer. Take the LAST complete
// JSON object that has every required key of the schema.
function firstJson(text, schema) {
  const t = text.replace(/```json|```/g, ""), found = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "{") continue;
    let depth = 0, inStr = false;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) {
        try { found.push(JSON.parse(t.slice(i, j + 1))); } catch {} break;
      }
    }
  }
  const need = schema?.required || [];
  const ok = found.filter((o) => o && typeof o === "object" && need.every((k) => k in o));
  if (!ok.length) throw new Error(`no JSON answer in: ${t.slice(0, 200)}`);
  return ok.at(-1);
}

// ask(role, prompt, {system, schema, tools}) -> {text, data, cost, turns}
async function ask(role, prompt, { system = "", schema, tools = "", allowed, cwd, extra = [] } = {}) {
  if (CMD[role]) {
    const input = `${system ? system + "\n\n---\n\n" : ""}${prompt}${schema ? `\n\nReply with ONLY a JSON object matching this JSON Schema, no other text:\n${JSON.stringify(schema)}` : ""}`;
    const text = await shellCmd(CMD[role], input);
    return { text, data: schema ? firstJson(text, schema) : undefined, cost: null, turns: 1 };
  }
  const args = ["--model", role === "target" ? TARGET : ASSESSOR, ...extra];
  if (!extra.includes("--setting-sources")) args.push("--safe-mode", "--tools", tools);
  if (allowed) args.push("--allowedTools", allowed);
  if (system) args.push("--append-system-prompt", system);
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  const t0 = Date.now();
  const j = await claude(args, { cwd, input: prompt });
  return { text: j.result, data: schema ? (j.structured_output || firstJson(j.result, schema)) : undefined, cost: j.total_cost_usd, turns: j.num_turns, seconds: (Date.now() - t0) / 1000 };
}

async function pool(items, fn, n = CONCURRENCY) {
  const results = [];
  let i = 0, done = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      for (let attempt = 1; ; attempt++) {
        try { results[idx] = await fn(items[idx]); break; }
        catch (e) {
          if (attempt >= 3) { console.error(`  ! failed: ${e.message.slice(0, 200)}`); results[idx] = null; break; }
          await new Promise((r) => setTimeout(r, 3000 * attempt));
        }
      }
      process.stdout.write(`\r  ${++done}/${items.length}`);
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  process.stdout.write("\n");
  return results;
}

// ---------- step 2: probe ----------
function triggeredWorkspace() {
  // A throwaway project with the skill installed, so the target has to decide to load it itself.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `skillpio-${skill}-`));
  const dest = path.join(ws, ".claude", "skills", skill);
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(dir, "skill"), dest, { recursive: true });
  return ws;
}

const NO_TOOLS = "No tools are available in this conversation. Answer directly from your own knowledge; say where you are unsure.";
async function probe() {
  fs.mkdirSync(phaseDir, { recursive: true });
  // Without this, the target sometimes "calls" npm/Bash to check versions, gets nothing back and answers
  // with an empty tool call. That is a harness artifact, not a knowledge gap.
  let system = NO_TOOLS, extra = [], cwd, tools = "";
  if (phase === "baseline") {}
  else if (phase === "verify-injected") {
    system += `\n\nThe following skill has been loaded for this task:\n\n${fs.readFileSync(path.join(dir, "skill", "SKILL.md"), "utf8")}`;
  } else if (phase === "calibrate") {
    // The answer key is in front of the target. A probe that still can't score full marks is a bad probe
    // (ambiguous, leaky, or graded against a wrong fact), not a knowledge gap. Idea from skillfid's calibration gate.
    system += `\n\nVerified reference material for this request. Use it.\n\n${read("research.md")}\n\nFacts:\n${facts.map((f) => `- ${f.id}: ${f.fact}`).join("\n")}`;
  } else if (phase === "verify-triggered") {
    if (CMD.target) throw new Error("verify-triggered needs the claude CLI. For other models use: trigger-eval");
    cwd = triggeredWorkspace(); system = ""; tools = "Skill,Read";
    extra = ["--setting-sources", "project", "--tools", "Skill,Read"];
  } else throw new Error(`unknown phase ${phase}`);

  const jobs = probes.flatMap((p) => Array.from({ length: runs }, (_, r) => ({ p, r: r + 1 })))
    .filter(({ p, r }) => !fs.existsSync(path.join(phaseDir, `${p.id}_r${r}.json`)));
  console.log(`probe ${skill} [${phase}] ${jobs.length} calls to ${roleName("target")}`);
  await pool(jobs, async ({ p, r }) => {
    const j = await ask("target", p.prompt, { system, cwd, tools, extra });
    // Skill and Read are the only tools available, so any extra turn means it loaded the skill.
    const usedSkill = j.turns > 1;
    fs.writeFileSync(path.join(phaseDir, `${p.id}_r${r}.json`), JSON.stringify({
      probe: p.id, run: r, model: CMD.target || TARGET, phase, prompt: p.prompt, answer: j.text,
      num_turns: j.turns, used_skill: phase === "verify-triggered" ? usedSkill : undefined,
      cost: j.cost, seconds: j.seconds, check: await check(p, j.text),
    }, null, 2));
  });
}

// Drop answers that are only an attempted tool call (see NO_TOOLS) so they get re-probed.
function purgeToolCallAnswers() {
  if (!fs.existsSync(phaseDir)) return;
  for (const f of fs.readdirSync(phaseDir).filter((f) => /^[A-Z]\w*_r\d+\.json$/.test(f))) {
    const rec = JSON.parse(fs.readFileSync(path.join(phaseDir, f), "utf8"));
    if (phase !== "verify-triggered" && /<invoke name=|<function_calls>/.test(rec.answer)) {
      fs.rmSync(path.join(phaseDir, f));
      fs.rmSync(path.join(phaseDir, f.replace(".json", ".assess.json")), { force: true });
      console.log(`  purged tool-call answer ${f}`);
    }
  }
}

// ---------- step 3: assess ----------
const ASSESS_SCHEMA = {
  type: "object",
  properties: {
    fact_verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["correct", "partial", "wrong", "missing", "not_applicable"] },
          note: { type: "string" },
        },
        required: ["id", "verdict", "note"],
      },
    },
    totally_wrong: { type: "array", items: { type: "string" }, description: "Incorrect claims or code in the answer, including ones not covered by the listed facts." },
    good: { type: "array", items: { type: "string" } },
    could_improve: { type: "array", items: { type: "string" } },
    score: { type: "integer", minimum: 0, maximum: 10 },
  },
  required: ["fact_verdicts", "totally_wrong", "good", "could_improve", "score"],
};

function assessPrompt(rec) {
  const p = probes.find((x) => x.id === rec.probe) || JSON.parse(read("probes.json")).find((x) => x.id === rec.probe);
  const listed = p.facts.map((id) => factById[id]).filter(Boolean);
  return `You are the assessor in a knowledge-gap study. A target model answered a developer's request with no tools and no web access.
Judge its answer strictly against the verified ground truth below (researched for this study). The ground truth wins over your own memory; if you believe a ground-truth fact is itself wrong, say so in a note but still grade against it.

## Ground-truth research notes
${read("research.md")}

## Facts this probe can reveal
${listed.map((f) => `- ${f.id} [${f.importance}${f.recent ? ", recent" : ""}]: ${f.fact}`).join("\n")}

## The developer's request
${rec.prompt}

## The target model's answer
${rec.answer}
${rec.check ? `
## Automatic check of the answer (a program replayed it against the rules; trust this over your own reading)
${rec.check.outcome}: ${rec.check.detail || ""}
` : ""}
## How to grade
For EACH listed fact give a verdict:
- correct: the answer uses or states it correctly
- partial: right direction but incomplete, vague, or mixed with outdated info
- wrong: contradicts it (e.g. uses the old/removed API, wrong version, wrong default)
- missing: the fact was needed for a correct answer to this request but the answer omits it
- not_applicable: a good answer to this particular request genuinely didn't need it
Then list: totally_wrong (every incorrect claim or broken code, even outside the facts), good (what it got right that matters), could_improve (what needs more nuance), and a 0-10 score for how well a developer would be served by following this answer.`;
}

async function assess() {
  const files = fs.readdirSync(phaseDir).filter((f) => /^[A-Z]\w*_r\d+\.json$/.test(f));
  const jobs = files.filter((f) => !fs.existsSync(path.join(phaseDir, f.replace(".json", ".assess.json"))));
  console.log(`assess ${skill} [${phase}] ${jobs.length} calls to ${roleName("assessor")}`);
  await pool(jobs, async (f) => {
    const rec = JSON.parse(fs.readFileSync(path.join(phaseDir, f), "utf8"));
    const j = await ask("assessor", assessPrompt(rec), { schema: ASSESS_SCHEMA });
    const a = j.data;
    fs.writeFileSync(path.join(phaseDir, f.replace(".json", ".assess.json")),
      JSON.stringify({ probe: rec.probe, run: rec.run, used_skill: rec.used_skill, ...a, cost: j.cost }, null, 2));
  });
}

// ---------- step 4: report ----------
const W = { correct: 0, partial: 0.5, wrong: 1, missing: 1 };
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));

function loadAssessments(ph) {
  const d = path.join(dir, "runs", ph);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith(".assess.json")).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8")));
}

function summarize(ph) {
  const as = loadAssessments(ph);
  const perFact = {};
  for (const a of as) for (const v of a.fact_verdicts) {
    if (!factById[v.id] || v.verdict === "not_applicable") continue;
    (perFact[v.id] ||= { verdicts: [], notes: [] }).verdicts.push(v.verdict);
    if (v.verdict !== "correct") perFact[v.id].notes.push(`${a.probe}r${a.run} ${v.verdict}: ${v.note}`);
  }
  const factRows = facts.map((f) => {
    const pf = perFact[f.id];
    if (!pf) return { ...f, n: 0, err: null };
    const errs = pf.verdicts.map((v) => W[v]);
    const counts = Object.fromEntries(["correct", "partial", "wrong", "missing"].map((k) => [k, pf.verdicts.filter((v) => v === k).length]));
    const modal = Math.max(...Object.values(counts));
    return { ...f, n: pf.verdicts.length, err: mean(errs), consistency: modal / pf.verdicts.length, counts, notes: pf.notes };
  });
  const perProbe = {};
  for (const a of as) (perProbe[a.probe] ||= []).push(a.score);
  const probeRows = Object.entries(perProbe).sort().map(([id, s]) => ({ id, n: s.length, mean: mean(s), sd: sd(s), min: Math.min(...s), max: Math.max(...s) }));
  const triggered = as.filter((a) => a.used_skill !== undefined);
  // Decision facts (facts.json "decision": true) change what the user does: a date, an amount, a yes/no, a channel.
  // When the file flags them, the headline number is the error rate over their verdicts only; context facts are not scored.
  const hasDecision = facts.some((f) => f.decision !== undefined);
  const dRows = factRows.filter((f) => f.decision && f.n);
  const dN = dRows.reduce((t, f) => t + f.n, 0);
  const decisionErr = hasDecision && dN ? dRows.reduce((t, f) => t + f.err * f.n, 0) / dN : undefined;
  return { as, factRows, probeRows, meanScore: mean(as.map((a) => a.score)), hasDecision, decisionErr, decisionN: dN,
    triggerRate: triggered.length ? triggered.filter((a) => a.used_skill).length / triggered.length : undefined };
}

function report() {
  const s = summarize(phase);
  const scored = s.hasDecision ? s.factRows.filter((f) => f.decision) : s.factRows;
  const gaps = scored.filter((f) => f.err !== null && (f.err >= 0.25 || (f.importance === "critical" && f.counts.wrong > 0) || (s.hasDecision && f.counts.wrong > 0)))
    .sort((a, b) => b.err - a.err);
  const known = scored.filter((f) => f.err !== null && !gaps.includes(f));
  const context = s.hasDecision ? s.factRows.filter((f) => !f.decision && f.err !== null) : [];
  const untested = s.factRows.filter((f) => f.err === null);
  const pct = (x) => `${Math.round(x * 100)}%`;
  let md = `# ${skill} — ${phase}\n\nTarget: ${TARGET} · Assessor: ${ASSESSOR} · ${s.as.length} graded answers · mean score **${s.meanScore.toFixed(1)}/10**\n`;
  if (s.hasDecision) md += `\n**Decision-fact error: ${pct(s.decisionErr)}** over ${s.decisionN} verdicts on the ${scored.length} facts that change what the user does. Context facts are listed at the end and not scored.\n`;
  if (s.triggerRate !== undefined) md += `\nSkill triggered on its own in **${pct(s.triggerRate)}** of runs.\n`;
  md += `\n## Score variance per probe\n\n| probe | runs | mean | sd | min–max |\n|---|---|---|---|---|\n`;
  md += s.probeRows.map((r) => `| ${r.id} | ${r.n} | ${r.mean.toFixed(1)} | ${r.sd.toFixed(2)} | ${r.min}–${r.max} |`).join("\n");
  md += s.hasDecision ? `\n\n## Gaps (decision facts with any wrong verdict, or error ≥ 25%) — these go in the skill\n\n` : `\n\n## Gaps (error rate ≥ 25%, or any wrong on a critical fact) — these go in the skill\n\n`;
  md += gaps.map((f) => `### ${f.id} · ${pct(f.err)} error · consistency ${pct(f.consistency)} · ${f.importance}${f.recent ? " · recent" : ""}\n${f.fact}\n\nVerdicts: ${JSON.stringify(f.counts)}\n\n${f.notes.slice(0, 6).map((n) => `- ${n}`).join("\n")}\n`).join("\n");
  md += `\n## Already known (leave out of the skill)\n\n${known.map((f) => `- ${f.id} (${pct(f.err)} err, n=${f.n}): ${f.fact}`).join("\n")}\n`;
  if (untested.length) md += `\n## Not exercised by any answer\n\n${untested.map((f) => `- ${f.id}: ${f.fact}`).join("\n")}\n`;
  if (context.length) md += `\n## Context facts (not scored: they do not change what the user does)\n\n${context.map((f) => `- ${f.id} (${pct(f.err)} err, n=${f.n}): ${f.fact}`).join("\n")}\n`;
  md += `\n## Totally wrong claims (all runs)\n\n${s.as.flatMap((a) => a.totally_wrong.map((t) => `- ${a.probe}r${a.run}: ${t}`)).join("\n")}\n`;
  fs.writeFileSync(path.join(dir, `report-${phase}.md`), md);
  fs.writeFileSync(path.join(dir, `summary-${phase}.json`), JSON.stringify({ meanScore: s.meanScore, decisionErr: s.decisionErr, decisionN: s.decisionN, triggerRate: s.triggerRate, probes: s.probeRows,
    facts: s.factRows.map(({ id, importance, recent, decision, n, err, consistency, counts }) => ({ id, importance, recent, decision, n, err, consistency, counts })) }, null, 2));
  console.log(`report -> skills/${skill}/report-${phase}.md  (mean ${s.meanScore.toFixed(1)}/10${s.hasDecision ? `, decision-fact error ${pct(s.decisionErr)}` : ""}, ${gaps.length} gaps, ${known.length} known)`);
}

// ---------- compare baseline vs verify ----------
function compare() {
  const phases = ["baseline", "verify-injected", "verify-triggered"].filter((p) => loadAssessments(p).length);
  const S = Object.fromEntries(phases.map((p) => [p, summarize(p)]));
  const pct = (x) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);
  // 95% interval on the mean score. Differences inside it are run-to-run noise, not a better or worse skill.
  const ci = (p) => { const sc = S[p].as.map((a) => a.score); return sc.length > 1 ? 1.96 * sd(sc) * Math.sqrt(sc.length / (sc.length - 1)) / Math.sqrt(sc.length) : 0; };
  const hasD = Object.values(S).some((x) => x.hasDecision);
  let md = `# ${skill} — before vs after\n\n| phase | answers | ${hasD ? "decision-fact error | " : ""}mean score (95% CI) | trigger rate |\n|---|---|${hasD ? "---|" : ""}---|---|\n`;
  md += phases.map((p) => `| ${p} | ${S[p].as.length} | ${hasD ? `**${pct(S[p].decisionErr)}** (n=${S[p].decisionN}) | ` : ""}${S[p].meanScore.toFixed(1)} ± ${ci(p).toFixed(1)} | ${pct(S[p].triggerRate)} |`).join("\n");
  if (hasD) md += `\n\nDecision-fact error: the error rate over the facts that change what the user does (facts.json \`decision: true\`). That is the number that matters; the mean score counts every fact equally.`;
  md += `\n\nScores that overlap within their intervals are not reliably different. Use more --runs to tell them apart.`;
  md += `\n\n## Error rate per fact\n\n| fact | importance | ${phases.join(" | ")} |\n|---|---|${phases.map(() => "---").join("|")}|\n`;
  const ordered = hasD ? [...facts.filter((f) => f.decision), ...facts.filter((f) => !f.decision)] : facts;
  md += ordered.map((f) => `| ${f.id}${hasD ? (f.decision ? " (decision)" : " (context)") : ""} | ${f.importance} | ${phases.map((p) => pct(S[p].factRows.find((r) => r.id === f.id).err)).join(" | ")} |`).join("\n");
  const gate = regressionGate(S, hasD);
  if (gate) md = md.replace(/\n\n/, `\n\n${gate.md}\n\n`);
  fs.writeFileSync(path.join(dir, "compare.md"), md + "\n");
  console.log(md);
}

// One-sided Fisher exact test: if the skill changed nothing, how likely is it that the "after" answers got at least
// this many bad verdicts by chance? Small means the rise is real, not bad luck.
function fisherWorse(bad0, n0, bad1, n1) {
  const lf = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
  const N = n0 + n1, K = bad0 + bad1, choose = (a, b) => lf(a) - lf(b) - lf(a - b);
  let p = 0;
  for (let k = bad1; k <= Math.min(K, n1); k++) p += Math.exp(choose(K, k) + choose(N - K, n1 - k) - choose(N, n1));
  return Math.min(1, p);
}

// The ship rule, checked by code: no scored fact may get worse with the skill. A fact is "worse" when its rise is
// unlikely to be chance (p < 0.05), and "maybe worse" when it rose by 15 points or more but there are too few answers
// to tell; those need more runs. Writes the verdict into loop.json so the record can't disagree with the numbers.
function regressionGate(S, hasD) {
  const before = S.baseline;
  const afters = Object.keys(S).filter((p) => p !== "baseline");
  if (!before || !afters.length) return null;
  const bad = (r) => r.n - (r.counts?.correct || 0); // anything not fully correct
  const pct = (x) => `${Math.round(x * 100)}%`;
  const rows = [];
  // Context facts are checked too, as warnings: a skill can crowd out something the model used to say unprompted.
  // They don't block.
  const warn = [];
  for (const p of afters) for (const f of facts) {
    const ctx = hasD && !f.decision;
    const r0 = before.factRows.find((r) => r.id === f.id), r1 = S[p].factRows.find((r) => r.id === f.id);
    if (!r0?.n || !r1?.n || r1.err <= r0.err) continue;
    const pv = fisherWorse(bad(r0), r0.n, bad(r1), r1.n);
    const status = pv < 0.05 ? "worse" : r1.err - r0.err >= 0.15 ? "maybe worse" : null;
    if (status) (ctx ? warn : rows).push({ phase: p, id: f.id, status, before: r0.err, after: r1.err, n0: r0.n, n1: r1.n, p: pv, fact: f.fact });
  }
  const verdict = rows.some((r) => r.status === "worse") ? "NOT READY" : rows.length ? "NEEDS MORE RUNS" : "READY";
  const why = { READY: "No scored fact got worse with the skill.", "NOT READY": "At least one fact got worse by more than chance explains. Fix those before anything else.",
    "NEEDS MORE RUNS": "Some facts rose, but there are too few answers to tell bad luck from a real problem. Re-run verify with more --runs." }[verdict];
  let md = `## Did anything get worse? **${verdict}**\n\n${why} ${hasD ? "Only decision facts are checked." : "Every fact is checked."} `
    + `\"Worse\" means the rise is unlikely to be chance (one-sided Fisher exact test, p < 0.05, counting any verdict short of correct); `
    + `\"maybe worse\" means it rose 15 points or more but the test can't tell yet.`;
  if (rows.length) md += `\n\n| fact | phase | status | before | after | answers before / after | p |\n|---|---|---|---|---|---|---|\n`
    + rows.map((r) => `| ${r.id} | ${r.phase} | ${r.status} | ${pct(r.before)} | ${pct(r.after)} | ${r.n0} / ${r.n1} | ${r.p.toFixed(3)} |`).join("\n")
    + `\n\n${rows.map((r) => `- **${r.id}**: ${r.fact}`).join("\n")}`;
  if (warn.length) md += `\n\n**Context facts that got worse** (warnings, not blocking: the skill may be crowding out something the model used to say; if the fact changes what the user does, flag it as a decision fact):\n\n| fact | phase | status | before | after | answers before / after | p |\n|---|---|---|---|---|---|---|\n`
    + warn.map((r) => `| ${r.id} | ${r.phase} | ${r.status} | ${pct(r.before)} | ${pct(r.after)} | ${r.n0} / ${r.n1} | ${r.p.toFixed(3)} |`).join("\n")
    + `\n\n${warn.map((r) => `- **${r.id}**: ${r.fact}`).join("\n")}`;
  const loopFile = path.join(dir, "loop.json");
  const loop = fs.existsSync(loopFile) ? JSON.parse(fs.readFileSync(loopFile, "utf8")) : {};
  loop.regressions = rows.map(({ phase, id, status, before, after, n0, n1, p }) => ({ phase, id, status, before: pct(before), after: pct(after), answers: `${n0}/${n1}`, p: Number(p.toFixed(3)) }));
  loop.context_warnings = warn.map(({ phase, id, status, before, after, n0, n1, p }) => ({ phase, id, status, before: pct(before), after: pct(after), answers: `${n0}/${n1}`, p: Number(p.toFixed(3)) }));
  loop.regression_check = { verdict, checked: new Date().toLocaleDateString("en-CA"), rule: "no scored fact worse with the skill (Fisher p < 0.05); a rise of 15+ points without significance needs more runs" };
  fs.writeFileSync(loopFile, JSON.stringify(loop, null, 2) + "\n");
  return { md, verdict, rows };
}


// ---------- step 1b: check each fact against its own source ----------
const CHECK_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["supported", "partly_supported", "unsupported", "unreachable"] },
    quote: { type: "string", description: "The sentence on the page that supports or contradicts the fact, under 30 words." },
    correction: { type: "string", description: "The fact rewritten so the source supports it, or empty if supported." },
  },
  required: ["verdict", "quote", "correction"],
};

async function checkFacts() {
  const out = path.join(dir, "facts-check.json");
  const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : {};
  // Re-check facts whose source could not be read last time (the download may work now, e.g. a PDF).
  const todo = facts.filter((f) => !prev[f.id] || prev[f.id].verdict === "unreachable");
  console.log(`check-facts ${skill}: ${todo.length} facts, ${ASSESSOR} with WebFetch`);
  const res = await pool(todo, async (f) => {
    // A source can also be a local file (a measurement log, a report kept in the skill folder): then the checker reads it.
    // Some official sites (ato.gov.au) refuse WebFetch with 403. Download the page first with a browser user agent;
    // if that works the checker reads the saved copy, otherwise it falls back to WebFetch.
    let local = !/^https?:\/\//.test(f.source), src = local ? path.resolve(process.cwd(), f.source) : f.source;
    if (!local) {
      const cache = path.join(dir, "sources", "pages"); fs.mkdirSync(cache, { recursive: true });
      // The name carries a hash of the whole URL: long addresses that share their first characters (two OFT pages did)
      // must never overwrite each other's saved copy.
      const file = path.join(cache, f.source.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_").slice(0, 100) + "-" + createHash("sha1").update(f.source).digest("hex").slice(0, 8) + ".html");
      if (!fs.existsSync(file)) await new Promise((r) => spawn("curl", ["-sL", "--max-time", "30", "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", "-o", file, f.source]).on("close", r));
      // Legislation is often a PDF: the checker can't read one saved under .html, so convert it to text first.
      let use = file;
      if (fs.existsSync(file) && fs.readFileSync(file).subarray(0, 5).toString() === "%PDF-") {
        use = file.replace(/\.html$/, ".txt");
        if (!fs.existsSync(use)) await new Promise((r) => spawn("pdftotext", ["-layout", file, use]).on("close", r));
      } else if (fs.existsSync(file)) {
        // Raw HTML of a whole Act is too big to read: keep only the text.
        use = file.replace(/\.html$/, ".txt");
        if (!fs.existsSync(use)) fs.writeFileSync(use, fs.readFileSync(file, "utf8").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n"));
      }
      if (fs.existsSync(use) && fs.statSync(use).size > 2000) { local = true; src = `${use} (a saved copy of ${f.source})`; }
    }
    const tool = local ? "Read" : "WebFetch";
    const j = await claude(["--model", ASSESSOR, "--safe-mode", "--tools", tool, "--allowedTools", tool,
      "--json-schema", JSON.stringify(CHECK_SCHEMA)], { cwd: process.cwd(), input:
`Open this source and decide whether it supports the fact exactly as written. Version numbers, defaults and names must match.
Source: ${src}
Fact ${f.id}: ${f.fact}
If the page will not load, use "unreachable". Do not use any other page or your own memory to decide.` });
    return [f.id, { fact: f.fact, source: f.source, ...(j.structured_output || JSON.parse(j.result)), cost: j.total_cost_usd }];
  });
  const all = { ...prev, ...Object.fromEntries(res.filter(Boolean)) };
  fs.writeFileSync(out, JSON.stringify(all, null, 2));
  const bad = Object.entries(all).filter(([, v]) => v.verdict !== "supported");
  const red = bad.filter(([, v]) => v.verdict !== "partly_supported"), amber = bad.filter(([, v]) => v.verdict === "partly_supported");
  const block = ([id, v]) => `### ${id} · ${v.verdict}\n${v.fact}\n\nSource: ${v.source}\n\n> ${v.quote}\n\n${v.correction ? `Suggested: ${v.correction}\n` : ""}`;
  let md = `# ${skill}: fact check\n\n${Object.keys(all).length} facts checked against their own sources: ${Object.keys(all).length - bad.length} supported, ${amber.length} partly, ${red.length} unsupported or unreachable.\n\n`;
  md += `## Fix first: unsupported or unreachable (${red.length})\n\n${red.map(block).join("\n") || "None.\n"}\n`;
  md += `## Check: partly supported (${amber.length})\n\nUsually the core claim is confirmed and an extra clause (an older version, a date) is not on the cited page. Split the fact or cite the extra clause.\n\n${amber.map(block).join("\n")}`;
  fs.writeFileSync(path.join(dir, "facts-check.md"), md);
  console.log(`facts-check -> ${path.relative(process.cwd(), path.join(dir, "facts-check.md"))} (${bad.length} flagged)`);
}

// ---------- step 1c: calibration report ----------
function calibrationReport() {
  const as = loadAssessments("calibrate");
  const rows = Object.entries(as.reduce((m, a) => ((m[a.probe] ||= []).push(a), m), {})).sort().map(([id, list]) => {
    const notCorrect = list.flatMap((a) => a.fact_verdicts.filter((v) => !["correct", "not_applicable"].includes(v.verdict)).map((v) => `${v.id} ${v.verdict}: ${v.note}`));
    return { id, score: mean(list.map((a) => a.score)), notCorrect };
  });
  const bad = rows.filter((r) => r.score < 9 || r.notCorrect.length);
  let md = `# ${skill}: calibration\n\nEach probe answered with the research and facts in front of the target. ${rows.length - bad.length} of ${rows.length} probes pass (score 9+, every listed fact correct).\n\n`;
  md += bad.length ? `## Probes to fix or drop\n\n${bad.map((r) => `### ${r.id} · ${r.score.toFixed(1)}/10\n${r.notCorrect.map((n) => `- ${n}`).join("\n")}\n`).join("\n")}` : "All probes pass.\n";
  fs.writeFileSync(path.join(dir, "calibration.md"), md);
  console.log(`calibration -> ${bad.length} of ${rows.length} probes flagged`);
}

// ---------- human agreement: does the assessor grade like a person would? ----------
function seeded(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function gradeSheet() {
  const n = Number(opt.n || 30);
  const src = path.join(dir, "runs", "baseline");
  const recs = fs.readdirSync(src).filter((f) => /^[A-Z]\w*_r\d+\.json$/.test(f) && fs.existsSync(path.join(src, f.replace(".json", ".assess.json"))));
  const rnd = seeded(42);
  const byProbe = recs.reduce((m, f) => ((m[f.split("_")[0]] ||= []).push(f), m), {});
  for (const k in byProbe) byProbe[k].sort(() => rnd() - 0.5);
  const picked = [];
  // Round-robin over probes so every probe is represented before any repeats.
  for (let round = 0; picked.length < n && round < 50; round++)
    for (const k of Object.keys(byProbe).sort()) if (byProbe[k][round] && picked.length < n) picked.push(byProbe[k][round]);
  const outDir = path.join(dir, "human-grading");
  fs.mkdirSync(outDir, { recursive: true });
  let md = `# Grade these answers yourself\n\nFor each fact under an answer, decide: **correct**, **partial**, **wrong**, **missing** (needed but left out) or **na** (not needed for this request).\nWrite your verdicts in \`verdicts.csv\` (open it in Numbers or Excel). Use the fact list and research.md as the answer key, not the assessor: its grades are hidden on purpose.\n\n`;
  let csv = "sample,file,fact,human_verdict\n";
  picked.forEach((f, i) => {
    const rec = JSON.parse(fs.readFileSync(path.join(src, f), "utf8"));
    const p = JSON.parse(read("probes.json")).find((x) => x.id === rec.probe);
    const sid = `S${String(i + 1).padStart(2, "0")}`;
    md += `---\n\n## ${sid} (${rec.probe}, run ${rec.run})\n\n**Request:** ${rec.prompt}\n\n**Answer:**\n\n${rec.answer}\n\n**Facts to grade:**\n${p.facts.map((id) => `- ${id}: ${factById[id]?.fact}`).join("\n")}\n\n`;
    for (const id of p.facts) csv += `${sid},${f},${id},\n`;
  });
  fs.writeFileSync(path.join(outDir, "sheet.md"), md);
  fs.writeFileSync(path.join(outDir, "verdicts.csv"), csv);
  console.log(`grade-sheet -> ${path.relative(process.cwd(), outDir)}/ (${picked.length} answers, ${csv.split("\n").length - 2} verdicts to fill in)`);
}

function kappa(pairs, cats) {
  const N = pairs.length; if (!N) return null;
  const po = pairs.filter(([a, b]) => a === b).length / N;
  const pe = cats.reduce((s, c) => s + (pairs.filter(([a]) => a === c).length / N) * (pairs.filter(([, b]) => b === c).length / N), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

function agreement() {
  const outDir = path.join(dir, "human-grading");
  const lines = fs.readFileSync(path.join(outDir, "verdicts.csv"), "utf8").trim().split(/\r?\n/).slice(1);
  const norm = { na: "not_applicable", "n/a": "not_applicable", not_applicable: "not_applicable", correct: "correct", partial: "partial", wrong: "wrong", missing: "missing" };
  const pairs = [];
  for (const line of lines) {
    const [, file, fact, h] = line.split(",").map((x) => (x || "").trim().toLowerCase());
    const human = norm[h]; if (!human) continue;
    const a = JSON.parse(fs.readFileSync(path.join(dir, "runs", "baseline", file.replace(".json", ".assess.json")), "utf8"));
    const machine = a.fact_verdicts.find((v) => v.id.toLowerCase() === fact)?.verdict;
    if (machine) pairs.push([human, machine, file, fact]);
  }
  const graded = pairs.filter(([h, m]) => h !== "not_applicable" && m !== "not_applicable");
  const four = ["correct", "partial", "wrong", "missing"];
  const bin = graded.map(([h, m]) => [h === "correct" ? "ok" : "gap", m === "correct" ? "ok" : "gap"]);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const exact = graded.filter(([h, m]) => h === m).length / (graded.length || 1);
  const binAgree = bin.filter(([h, m]) => h === m).length / (bin.length || 1);
  let md = `# ${skill}: human vs assessor\n\n${pairs.length} verdicts compared (${graded.length} where both said the fact applied).\n\n| measure | value |\n|---|---|\n`;
  md += `| exact agreement, 4 verdicts | ${pct(exact)} |\n| Cohen's kappa, 4 verdicts | ${kappa(graded, four)?.toFixed(2)} |\n`;
  md += `| agreement on gap vs no gap (what decides the skill) | ${pct(binAgree)} |\n| Cohen's kappa, gap vs no gap | ${kappa(bin, ["ok", "gap"])?.toFixed(2)} |\n\n`;
  md += `Kappa reads roughly: below 0.4 weak, 0.4–0.6 moderate, 0.6–0.8 substantial, above 0.8 near perfect.\n\n## Disagreements\n\n`;
  md += graded.filter(([h, m]) => h !== m).map(([h, m, f, id]) => `- ${f} ${id.toUpperCase()}: you said ${h}, assessor said ${m}`).join("\n") + "\n";
  fs.writeFileSync(path.join(outDir, "agreement.md"), md);
  console.log(md);
}

// ---------- step 1a: current, version-specific docs from Context7 ----------
// node skillpio.mjs docs <skill> --lib "capacitor" --q "ios swift package manager|android sdk levels|migrate from 7"
// Saves sources/context7-*.md: official doc snippets, each with the file it came from, for the research step to cite.
async function docs() {
  if (!opt.lib && !opt.id) throw new Error('docs needs --lib "<library name>" (or --id /org/repo) and --q "query|query"');
  const headers = process.env.CONTEXT7_API_KEY ? { Authorization: `Bearer ${process.env.CONTEXT7_API_KEY}` } : {};
  const libName = String(opt.lib || "").replace(/_/g, " ");
  let id = opt.id;
  const outDir = path.join(dir, "sources"); fs.mkdirSync(outDir, { recursive: true });
  if (!id) {
    const r = await fetch(`https://context7.com/api/v2/libs/search?libraryName=${encodeURIComponent(libName)}&query=${encodeURIComponent(libName)}`, { headers });
    const found = (await r.json()).results || [];
    if (!found.length) throw new Error(`Context7 found no library for "${libName}"`);
    fs.writeFileSync(path.join(outDir, "context7-libraries.md"), `# Context7 matches for "${libName}"\n\n${found.slice(0, 8).map((x) => `- \`${x.id}\` ${x.title}: ${x.description} (trust ${x.trustScore}, updated ${String(x.lastUpdateDate).slice(0, 10)})`).join("\n")}\n`);
    id = found[0].id;
    console.log(`docs: using ${id} (other matches in sources/context7-libraries.md; pass --id to choose)`);
  }
  const queries = String(opt.q || libName).replace(/_/g, " ").split("|").map((q) => q.trim()).filter(Boolean);
  for (const q of queries) {
    const r = await fetch(`https://context7.com/api/v2/context?libraryId=${encodeURIComponent(id)}&query=${encodeURIComponent(q)}&type=txt`, { headers });
    const text = await r.text();
    const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
    fs.writeFileSync(path.join(outDir, `context7-${slug}.md`), `# Context7: ${id} · "${q}"\n\nFetched ${new Date().toLocaleDateString("en-CA")}. Cite the Source line under each snippet, not Context7.\n\n${text}`);
    console.log(`  ${r.status} "${q}" -> sources/context7-${slug}.md (${text.length} chars)`);
  }
}

// ---------- does the description load the skill when it should, and only then? (any model) ----------
// Router test: the model sees a catalogue of skill descriptions (this one, the other skills in the folder, and some
// everyday decoys) plus a request, and names the skills it would load. Works with any model via SKILLPIO_TARGET_CMD.
const DECOYS = [
  ["pdf", "Use when reading, creating, merging or filling PDF files."],
  ["docx", "Use when the user asks for a Word document or a .docx file."],
  ["git-workflow", "Use when committing, branching, rebasing or writing pull requests."],
  ["sql-queries", "Use when writing or optimising SQL queries for Postgres, MySQL or SQLite."],
  ["python-testing", "Use when writing or fixing pytest tests in a Python project."],
  ["react-components", "Use when building React components, hooks and state in a web app."],
  ["docker", "Use when writing Dockerfiles, compose files or debugging containers."],
  ["spreadsheet", "Use when the user works with .xlsx or .csv files."],
];
const ROUTE_SCHEMA = { type: "object", properties: { load: { type: "array", items: { type: "string" } } }, required: ["load"] };
const skillsRoot = path.dirname(dir);
function frontmatter(md) { const m = md.match(/^---\n([\s\S]*?)\n---/); const g = (k) => (m?.[1].match(new RegExp(`^${k}:\\s*(.*)$`, "m")) || [])[1]?.trim(); return { name: g("name"), description: g("description") }; }
function catalogue(ownDescription) {
  const own = frontmatter(fs.readFileSync(path.join(dir, "skill", "SKILL.md"), "utf8"));
  // Leave out other versions of this same skill (same probes): they would compete with it for the same requests.
  const myProbes = read("probes.json");
  const sibling = (d) => { try { return fs.readFileSync(path.join(skillsRoot, d, "probes.json"), "utf8") === myProbes; } catch { return false; } };
  const others = fs.readdirSync(skillsRoot).filter((d) => d !== skill && !sibling(d) && fs.existsSync(path.join(skillsRoot, d, "skill", "SKILL.md")))
    .map((d) => frontmatter(fs.readFileSync(path.join(skillsRoot, d, "skill", "SKILL.md"), "utf8"))).filter((f) => f.name && f.name !== own.name);
  return { own: own.name, items: [[own.name, ownDescription ?? own.description], ...others.map((o) => [o.name, o.description]), ...DECOYS] };
}

async function negatives() {
  const f = path.join(dir, "trigger-negatives.json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const own = frontmatter(fs.readFileSync(path.join(dir, "skill", "SKILL.md"), "utf8"));
  const j = await ask("assessor", `A skill called "${own.name}" covers: ${own.description}\n\nWrite 12 realistic developer requests that are NEAR this topic but where this skill should NOT be loaded: neighbouring libraries, older or unrelated versions where the user says so, general questions that happen to share words. Make them hard: a careless reader would load the skill. Return them as {"prompts": [...]}.`,
    { schema: { type: "object", properties: { prompts: { type: "array", items: { type: "string" } } }, required: ["prompts"] } });
  const list = j.data.prompts.map((prompt, i) => ({ id: `N${String(i + 1).padStart(2, "0")}`, set: i % 3 === 2 ? "holdout" : "train", prompt }));
  fs.writeFileSync(f, JSON.stringify(list, null, 2));
  console.log(`wrote ${list.length} near-miss prompts to trigger-negatives.json (edit them if any should load the skill)`);
  return list;
}

async function routeAll(description, which = "all", reps = Number(opt.runs || 2)) {
  const all = JSON.parse(read("probes.json"));
  const pos = all.filter((p) => which === "all" || p.set === which).map((p) => ({ ...p, want: true }));
  const neg = (await negatives()).filter((p) => which === "all" || p.set === which).map((p) => ({ ...p, want: false }));
  const cat = catalogue(description);
  const rnd = seeded(7);
  const jobs = [...pos, ...neg].flatMap((p) => Array.from({ length: reps }, (_, r) => ({ p, r, order: [...cat.items].sort(() => rnd() - 0.5) })));
  const res = await pool(jobs, async ({ p, order }) => {
    const j = await ask("target", `Skills available to you (name: when to use it):\n${order.map(([n, d]) => `- ${n}: ${d}`).join("\n")}\n\nThe user's request:\n${p.prompt}\n\nBefore starting, which skills (if any) would you load? Load a skill only if it will help with this request. Reply as {"load": [names]}, or {"load": []} for none.`, { schema: ROUTE_SCHEMA });
    const load = j.data.load || [];
    return { id: p.id, want: p.want, loaded: load.includes(cat.own), instead: load.filter((n) => n !== cat.own) };
  });
  const ok = res.filter(Boolean), P = ok.filter((x) => x.want), N = ok.filter((x) => !x.want);
  return { recall: P.filter((x) => x.loaded).length / (P.length || 1), falseRate: N.filter((x) => x.loaded).length / (N.length || 1),
    instead: Object.entries(P.filter((x) => !x.loaded).flatMap((x) => x.instead).reduce((m, n) => ((m[n] = (m[n] || 0) + 1), m), {})).map(([n, c]) => `${n} (${c})`).join(", "),
    missed: [...new Set(P.filter((x) => !x.loaded).map((x) => x.id))], falseHits: [...new Set(N.filter((x) => x.loaded).map((x) => x.id))], n: ok.length, cat };
}

async function triggerEval() {
  const r = await routeAll(undefined, opt.set || "all");
  const pct = (x) => `${Math.round(x * 100)}%`;
  const md = `# ${skill}: trigger test (router, ${roleName("target")})\n\nCatalogue of ${r.cat.items.length} skills. ${r.n} decisions.\n\n- Loaded when it should: **${pct(r.recall)}**\n- Loaded when it should not: **${pct(r.falseRate)}**\n\nMissed requests: ${r.missed.join(", ") || "none"}${r.instead ? ` (loaded instead: ${r.instead})` : ""}\n\nFalse loads: ${r.falseHits.join(", ") || "none"}\n\nAim for 90%+ and under 10%. To improve the description: \`tune-description\`.\n`;
  fs.writeFileSync(path.join(dir, "trigger-eval.md"), md); console.log(md);
}

async function tuneDescription() {
  const k = Number(opt.k || 4);
  const md0 = fs.readFileSync(path.join(dir, "skill", "SKILL.md"), "utf8");
  const cur = frontmatter(md0).description;
  const base = await routeAll(cur, "train");
  const negs = await negatives(), probesAll = JSON.parse(read("probes.json"));
  const txt = (ids, list) => ids.map((id) => `- ${list.find((x) => x.id === id)?.prompt}`).join("\n") || "(none)";
  const j = await ask("assessor", `Improve the description of a skill. The description is all an agent sees when deciding whether to load the skill.\n\nCurrent description:\n${cur}\n\nSkill body:\n${md0.replace(/^---[\s\S]*?---/, "").slice(0, 6000)}\n\nRequests where it should have loaded but did not:\n${txt(base.missed, probesAll)}\n\nRequests where it loaded but should not have:\n${txt(base.falseHits, negs)}\n\nWrite ${k} alternative descriptions. Rules: start with "Use when", say WHEN to load it (tasks, library and version, words users say), never HOW the skill works, under 60 words each. Return {"candidates": [...]}.`,
    { schema: { type: "object", properties: { candidates: { type: "array", items: { type: "string" } } }, required: ["candidates"] } });
  const rows = [{ d: cur, r: base, label: "current" }];
  for (const [i, d] of j.data.candidates.slice(0, k).entries()) rows.push({ d, r: await routeAll(d, "train"), label: `option ${i + 1}` });
  const score = (r) => r.recall - r.falseRate;
  const best = rows.reduce((a, b) => (score(b.r) > score(a.r) ? b : a));
  const hold = await routeAll(best.d, "holdout"), holdCur = best === rows[0] ? hold : await routeAll(cur, "holdout");
  const pct = (x) => `${Math.round(x * 100)}%`;
  let md = `# ${skill}: description tuning (router, ${roleName("target")})\n\nTuned on the train requests, checked on the holdout requests.\n\n`;
  md += rows.map((x) => `## ${x.label}${x === best ? " (best)" : ""}: loads ${pct(x.r.recall)} when it should, ${pct(x.r.falseRate)} when it should not\n${x.d}\n`).join("\n");
  md += `\n## Holdout check\n\nCurrent: ${pct(holdCur.recall)} / ${pct(holdCur.falseRate)}. Best: ${pct(hold.recall)} / ${pct(hold.falseRate)}.\n`;
  const apply = opt.apply && best !== rows[0] && score(hold) >= score(holdCur);
  if (apply) {
    fs.writeFileSync(path.join(dir, "skill", "SKILL.md"), md0.replace(/^(---\n[\s\S]*?^description:\s*).*$/m, `$1${best.d.replace(/\$/g, "$$$$")}`));
    md += `\nApplied to skill/SKILL.md.\n`;
  } else md += `\n${opt.apply ? "Not applied: the best option did not beat the current description on the holdout." : "Not applied. Re-run with --apply to write the best option into SKILL.md if it also wins on the holdout."}\n`;
  fs.writeFileSync(path.join(dir, "description-tuning.md"), md); console.log(md);
}

// ---------- blind A/B: which skill's answers are better? ----------
// node skillpio.mjs blind-compare <skillA> --vs <skillB> [--phase verify-injected]
// Both work folders must share the same probes. The grader sees two answers in random order, never which skill made them.
const AB_SCHEMA = { type: "object", properties: { better: { type: "string", enum: ["1", "2", "tie"] }, reason: { type: "string" } }, required: ["better", "reason"] };
async function blindCompare() {
  if (!opt.vs) throw new Error("blind-compare needs --vs <other skill folder>");
  // --vs-phase compares against a different phase of the other folder (e.g. a model's baseline with no skill).
  const vsPhase = opt["vs-phase"] || phase;
  const other = path.join(skillsRoot, opt.vs, "runs", vsPhase);
  const pairs = fs.readdirSync(phaseDir).filter((f) => /^[A-Z]\w*_r\d+\.json$/.test(f) && fs.existsSync(path.join(other, f)));
  const ans = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8")).answer;
  const same = pairs.filter((f) => ans(phaseDir, f) === ans(other, f)).length;
  if (same === pairs.length && pairs.length) throw new Error(`all ${pairs.length} answer pairs are identical (same answers in both folders, e.g. a copied baseline); pick a different --phase`);
  const rnd = seeded(11);
  console.log(`blind-compare ${skill} [${phase}] vs ${opt.vs} [${vsPhase}]: ${pairs.length} pairs, ${roleName("assessor")}`);
  const res = await pool(pairs, async (f) => {
    const a = JSON.parse(fs.readFileSync(path.join(phaseDir, f), "utf8")), b = JSON.parse(fs.readFileSync(path.join(other, f), "utf8"));
    const flip = rnd() < 0.5, [one, two] = flip ? [b, a] : [a, b];
    const pr = JSON.parse(read("probes.json")).find((x) => x.id === a.probe);
    const j = await ask("assessor", `Two answers to the same developer request. Judge which would serve the developer better, against the verified ground truth below. A claim that the research notes support is correct even if it is not in the listed facts. Ignore length and style except where they help or hurt the developer.\n\n## Research notes (ground truth)\n${read("research.md")}\n\n## Facts this request tests\n${pr.facts.map((id) => `- ${id}: ${factById[id]?.fact}`).join("\n")}\n\n## Request\n${a.prompt}\n\n## Answer 1\n${one.answer}\n\n## Answer 2\n${two.answer}`, { schema: AB_SCHEMA });
    const w = j.data.better === "tie" ? "tie" : (j.data.better === "1") !== flip ? "A" : "B";
    return { f, w, reason: j.data.reason };
  });
  const ok = res.filter(Boolean), A = ok.filter((x) => x.w === "A").length, B = ok.filter((x) => x.w === "B").length, T = ok.length - A - B;
  // Two-sided sign test on the non-tied pairs.
  const n = A + B, kk = Math.min(A, B); let pv = 0; const C = (n, k) => { let c = 1; for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1); return c; };
  for (let i = 0; i <= kk; i++) pv += C(n, i) / 2 ** n; pv = Math.min(1, 2 * pv);
  const md = `# Blind comparison: ${skill} ${phase} (A) vs ${opt.vs} ${vsPhase} (B)\n\n${ok.length} pairs judged by ${roleName("assessor")}, order randomised, labels hidden.\n\n- A better: **${A}**\n- B better: **${B}**\n- Tie: **${T}**\n- Sign test on non-tied pairs: p = ${pv.toFixed(3)}${pv >= 0.05 ? " (no reliable difference)" : ""}\n\n## Reasons where they differed\n\n${ok.filter((x) => x.w !== "tie").map((x) => `- ${x.f} ${x.w} better: ${x.reason}`).join("\n")}\n`;
  fs.writeFileSync(path.join(dir, `blind-vs-${opt.vs}${vsPhase !== phase ? "-" + vsPhase : ""}.md`), md); console.log(md);
}

// ---------- blocks: a skill as a list of editable pieces ----------
function splitBlocks(text) {
  // Blocks: frontmatter, headings and blank lines stay fixed; each bullet (with its continuation lines) or paragraph is editable.
  const fm = text.match(/^---\n[\s\S]*?\n---\n/)?.[0] || "";
  const segs = []; let cur = null, fence = false;
  for (const line of text.slice(fm.length).split("\n")) {
    if (fence) { cur.text += "\n" + line; if (line.startsWith("```")) fence = false; continue; }
    if (line.startsWith("```")) { fence = true; if (cur?.edit) cur.text += "\n" + line; else segs.push(cur = { text: line, edit: true }); continue; }
    if (/^\s*$/.test(line) || /^#/.test(line)) { segs.push({ text: line, edit: false }); cur = null; continue; }
    if (/^([-*]|\d+\.) /.test(line) || !cur) { segs.push(cur = { text: line, edit: true }); continue; }
    cur.text += "\n" + line;
  }
  let n = 0; for (const s of segs) if (s.edit) s.id = `B${String(++n).padStart(2, "0")}`;
  const blocks = segs.filter((s) => s.edit);
  // changes: { B07: "new text" | null (delete), "+B07": "a new line added after B07" }
  const render = (changes = {}) => fm + segs.map((s) => {
    const t = s.id && s.id in changes ? changes[s.id] : s.text, add = s.id && changes["+" + s.id];
    return add ? (t === null ? add : `${t}\n${add}`) : t;
  }).filter((t) => t !== null).join("\n").replace(/\n{3,}/g, "\n\n");
  return { fm, segs, blocks, render };
}

const REPEAT_SCHEMA = { type: "object", properties: { repeats: { type: "array", items: { type: "object", properties: { fact: { type: "string" }, blocks: { type: "array", items: { type: "string" } }, detail: { type: "string" } }, required: ["fact", "blocks", "detail"] } } }, required: ["repeats"] };
// Facts a skill states twice (one author call): the same piece of information (a value, date, name or rule) given in two
// or more blocks. A fact spread over several blocks, one step or part in each (a recipe, a checklist), is not a repeat.
// Repeats are allowed when they measure better, but every copy has to change when the source does.
async function repeatedFacts(text) {
  const { blocks } = splitBlocks(text);
  const r = (await ask("assessor", `Find repeated information in this skill: the same piece of information (the same value, date, version, name or rule) stated in two or more blocks. Not a repeat: one fact spread over several blocks with a different step or part in each (a numbered recipe, a checklist, a rule in one block and a different exception in another), or a passing mention that gives no content. For each repeat, give the fact id it belongs to, the block ids that state it, and the repeated detail in a few words.\n\nBlocks:\n\n${blocks.map((b) => `[${b.id}] ${b.text}`).join("\n\n")}\n\nFacts:\n${facts.map((f) => `- ${f.id}: ${f.fact}`).join("\n")}`, { schema: REPEAT_SCHEMA })).data.repeats;
  return r.filter((d) => factById[d.fact]).map((d) => ({ fact: d.fact, detail: d.detail, blocks: d.blocks.filter((id) => blocks.some((b) => b.id === id)).map((id) => blocks.find((b) => b.id === id).text) })).filter((d) => d.blocks.length > 1);
}
// node skillpio.mjs repeats <skill> [--file optimized/SKILL.md]
async function repeats() {
  const dup = await repeatedFacts(read(opt.file || "skill/SKILL.md"));
  console.log(dup.length ? dup.map((d) => `${d.fact}: "${d.detail}" is stated in ${d.blocks.length} places:\n${d.blocks.map((b) => `  - ${b.slice(0, 100)}…`).join("\n")}`).join("\n\n") : "No fact is stated in more than one place.");
}

// ---------- sweeps: test the skill's sweeping sentences where they could be false ----------
// node skillpio.mjs sweeps <skill> [--max 4] [--file skill/SKILL.md]
// A sweeping sentence ("calculate 12% of qualifying earnings", "state them as fact") is fine when it is true for every
// case and harmful when it is quietly false for some: the target applies it where it doesn't hold, and stops looking
// things up. The author model finds them and the exceptions the research supports (a quote from research.md is
// required and checked, so no invented exceptions); each exception becomes a fact plus two realistic questions, one
// for training and one reserved for the holdout, so the final check always has questions the search never saw.
// Then: baseline and verify the new probes (--only), compare, and optimize any that got worse.
async function sweeps() {
  const text = read(opt.file || "skill/SKILL.md"), max = Number(opt.max || 4);
  const SWEEP_SCHEMA = { type: "object", properties: { sweeps: { type: "array", items: { type: "object", properties: {
    quote: { type: "string" }, exceptions: { type: "array", items: { type: "object", properties: {
      exception: { type: "string" }, evidence: { type: "string" }, existing_fact: { type: "string" }, importance: { type: "string", enum: ["critical", "important", "nice"] },
      decision: { type: "boolean" }, train_question: { type: "string" }, holdout_question: { type: "string" } },
      required: ["exception", "evidence", "existing_fact", "importance", "decision", "train_question", "holdout_question"] } } },
    required: ["quote", "exceptions"] } } }, required: ["sweeps"] };
  const r = (await ask("assessor", `Find the sweeping sentences in this skill: rules stated without conditions or limits ("calculate X", "always", "never", "state as fact", "all employees"), which the model will apply to every case.

## The skill
${text}

## The research it was written from
${read("research.md")}

## The answer key
${facts.map((f) => `- ${f.id}: ${f.fact}`).join("\n")}

For each sweeping sentence, list the exceptions: cases where following it as written gives the wrong answer. Only exceptions the research supports. For each:
- exception: the true rule for that case, as a checkable fact, in the answer key's style
- evidence: a short quote copied word for word from the research above that supports it
- existing_fact: the answer-key id if the key already states it, else ""
- importance and decision (does it change what the user does: a date, an amount, a yes or no)
- train_question and holdout_question: two different realistic requests from a user, in their own words, where the exception decides the right answer. Don't name or hint at the exception; describe the situation (an age, a date, a kind of worker) and let the answer have to notice it.
Quote each sweeping sentence word for word in "quote". At most ${max} exceptions in total, the ones most likely to cause a wrong decision first. If a sentence has no supported exception, leave it out.`, { schema: SWEEP_SCHEMA })).data.sweeps;
  const norm = (t) => t.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim(), research = norm(read("research.md"));
  const allProbes = JSON.parse(read("probes.json")), allFacts = facts.slice();
  const next = (arr, pre) => `${pre}${String(Math.max(0, ...arr.map((x) => Number(x.id.slice(1)) || 0)) + 1).padStart(2, "0")}`;
  let md = `# ${skill}: sweeping sentences\n\nAuthor: ${roleName("assessor")}. Each exception below is backed by a quote from research.md (checked word for word); unsupported ones are dropped.\n\n`;
  const added = [];
  for (const sw of r) {
    const kept = [];
    for (const e of sw.exceptions) {
      if (added.length >= max) break;
      if (!research.includes(norm(e.evidence).slice(0, 120))) { md += `- Dropped (quote not found in research.md): ${e.exception}\n`; continue; }
      let fid = factById[e.existing_fact] ? e.existing_fact : null;
      if (!fid) { fid = next(allFacts, "F"); // Decision flags only where the skill already uses them: one flagged fact switches the whole report to decision facts.
        const flags = facts.some((f) => f.decision !== undefined) ? { decision: e.decision, ...(e.decision ? {} : { context_reason: "exception found by sweeps; does not change what the user does" }) } : {};
        allFacts.push({ id: fid, fact: e.exception, importance: e.importance, recent: false, source: "research.md (sweeps)", ...flags, sweep: sw.quote.slice(0, 200) }); }
      const pt = { id: next(allProbes, "P"), set: "train", prompt: e.train_question, facts: [fid], sweep: true }; allProbes.push(pt);
      const ph = { id: next(allProbes, "P"), set: "holdout", prompt: e.holdout_question, facts: [fid], sweep: true }; allProbes.push(ph);
      kept.push({ ...e, fid, train: pt.id, holdout: ph.id }); added.push(pt.id, ph.id);
    }
    if (kept.length) md += `\n## "${sw.quote}"\n\n${kept.map((e) => `- **${e.fid}${e.existing_fact ? "" : " (new)"}**: ${e.exception}\n  Evidence: "${e.evidence}"\n  ${e.train} (train): ${e.train_question}\n  ${e.holdout} (reserved for holdout): ${e.holdout_question}`).join("\n")}\n`;
  }
  if (!added.length) { console.log(md + "\nNo supported exceptions found."); return; }
  fs.writeFileSync(path.join(dir, "facts.json"), JSON.stringify(allFacts, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "probes.json"), JSON.stringify(allProbes, null, 2) + "\n");
  const only = added.join(",");
  md += `\n## Next\n\nAdded ${added.length} probes (${only}). Measure them without and with the skill, then check:\n\n\`\`\`\nrun ${skill} --phase calibrate --only ${only}\nrun ${skill} --phase baseline --runs 5 --only ${only}\nrun ${skill} --phase verify-injected --runs 3 --only ${only}\ncompare ${skill}\n\`\`\`\n\nAny fact that got worse is a sweep that is false where it matters: run \`optimize ${skill}\`.\n`;
  fs.writeFileSync(path.join(dir, "sweeps.md"), md);
  console.log(md);
}

// ---------- optimize: find the sentence behind a regression and race fixes for it ----------
// node skillpio.mjs optimize <skill> [--focus F24,F33] [--gaps] [--suspects 6] [--rewrites 3] [--runs 3] [--budget 150]
//   [--harm 2] [--dry-run]
// A skill is a list of blocks (one bullet or paragraph each). The search changes one block at a time:
//   1. problems: facts that got worse (loop.json, from compare), or --focus; --gaps adds decision facts still >= 25% wrong
//   2. suspects: the author model ranks the blocks most likely behind them (one call), and maps each block to its facts
//   3. leave one out: each suspect is removed and only the problem facts' training probes are re-asked; a block whose
//      removal lowers their error is a culprit (gap facts: the suspects that cover them are culprits directly)
//   4. rewrites: the author writes --rewrites alternatives per culprit, plus "delete it"
//   5. racing (successive halving): every candidate and the current skill get 1 run on the probes for the problem facts
//      and the block's own facts; the better half get --runs. Ranked by red-line breaches (critical facts up 15+ points
//      on baseline), then weighted net gain (critical 3, important 2, nice 1; an error the skill causes counts --harm
//      times an error it fixes), then fewer words. The current skill is always in the race, so "change nothing" can win.
//   6. combine the winning changes and check them together (edits interfere)
//   7. holdout: the winner and the current skill on the held-out probes, never used in the search; worse there = not
//      recommended (it fitted the training probes)
// Writes optimized/SKILL.md (never skill/SKILL.md), optimize.md and optimize.json. A "test" is one answer plus its grade.
async function optimize() {
  const R = Number(opt.runs || 3), budget = Number(opt.budget || 150), HARM = Number(opt.harm || 2);
  const allProbes = JSON.parse(read("probes.json")), train = allProbes.filter((p) => p.set !== "holdout"), holdout = allProbes.filter((p) => p.set === "holdout");
  const current = read("skill/SKILL.md");
  // The saved answers are reused and compared with new ones, so they must come from the same model.
  const vd = path.join(dir, "runs", "verify-injected"), vf = fs.existsSync(vd) && fs.readdirSync(vd).find((f) => /_r\d+\.json$/.test(f));
  const was = vf && JSON.parse(fs.readFileSync(path.join(vd, vf), "utf8")).model, now = CMD.target || TARGET;
  if (was && was !== now) throw new Error(`this skill's answers came from ${was}, but the target is ${now}. Set SKILLPIO_TARGET=${was} (or the matching SKILLPIO_TARGET_CMD).`);
  const base = Object.fromEntries(summarize("baseline").factRows.filter((r) => r.n).map((r) => [r.id, r.err]));
  const hasD = facts.some((f) => f.decision !== undefined);
  const scored = (id) => factById[id] && base[id] !== undefined && (!hasD || factById[id].decision);
  const weight = { critical: 3, important: 2, nice: 1 };
  const redLine = (id) => factById[id].importance === "critical";
  const pct = (x) => (x === undefined ? "–" : `${Math.round(x * 100)}%`);
  const words = (t) => t.replace(/^---[\s\S]*?---/, "").split(/\s+/).filter(Boolean).length;

  // 1. problems
  const loopFile = path.join(dir, "loop.json");
  const loop = fs.existsSync(loopFile) ? JSON.parse(fs.readFileSync(loopFile, "utf8")) : {};
  const regress = opt.focus ? String(opt.focus).split(",").map((s) => s.trim()) : [...new Set((loop.regressions || []).map((r) => r.id))];
  const gaps = opt.gaps ? summarize("verify-injected").factRows.filter((r) => r.n && scored(r.id) && r.err >= 0.25 && !regress.includes(r.id)).map((r) => r.id) : [];
  const problems = [...regress, ...gaps].filter((id) => factById[id]);
  if (!problems.length) { console.log("Nothing to optimize: no regressions in loop.json (run compare), no --focus, no --gaps."); return; }
  const touching = (ids, set = train) => set.filter((p) => p.facts.some((f) => ids.includes(f))).map((p) => p.id);
  const Qp = touching(problems);
  if (!Qp.length) throw new Error(`no training probe tests ${problems.join(", ")}; add probes before optimizing`);

  const { fm, segs, blocks, render } = splitBlocks(current);

  // Evaluation, cached by the text's hash: the same text on the same probe is never asked twice.
  let used = 0; const spent = () => used;
  const hash = (t) => createHash("sha1").update(t).digest("hex").slice(0, 10);
  // The author's suggestions are saved by the exact prompt, so a re-run after a budget stop gets the same suspects and
  // rewrites back and really continues where it stopped.
  async function author(prompt, o) {
    const f = path.join(dir, "runs", "opt", "author", `${hash(prompt + JSON.stringify(o.schema))}.json`);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
    const j = await ask("assessor", prompt, o);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ data: j.data }, null, 2));
    return j;
  }
  async function evaluate(text, ids, runsN) {
    const d = path.join(dir, "runs", "opt", hash(text));
    fs.mkdirSync(d, { recursive: true });
    if (!fs.existsSync(path.join(d, "SKILL.md"))) fs.writeFileSync(path.join(d, "SKILL.md"), text);
    // The current skill's verify answers were asked with exactly this text and prompt: reuse any not copied yet.
    const v = path.join(dir, "runs", "verify-injected");
    if (text === current && fs.existsSync(v)) for (const f of fs.readdirSync(v)) if (!fs.existsSync(path.join(d, f))) fs.copyFileSync(path.join(v, f), path.join(d, f));
    const jobs = ids.flatMap((id) => Array.from({ length: runsN }, (_, r) => ({ p: allProbes.find((x) => x.id === id), r: r + 1 })))
      .filter(({ p, r }) => !fs.existsSync(path.join(d, `${p.id}_r${r}.assess.json`)));
    if (used + jobs.length > budget) throw Object.assign(new Error(`budget: ${used} tests used, ${jobs.length} more needed, --budget ${budget}`), { budget: true });
    used += jobs.length;
    const system = `${NO_TOOLS}\n\nThe following skill has been loaded for this task:\n\n${text}`;
    await pool(jobs, async ({ p, r }) => {
      const af = path.join(d, `${p.id}_r${r}.json`);
      if (!fs.existsSync(af)) {
        const j = await ask("target", p.prompt, { system });
        fs.writeFileSync(af, JSON.stringify({ probe: p.id, run: r, model: CMD.target || TARGET, phase: "optimize", prompt: p.prompt, answer: j.text, cost: j.cost, check: await check(p, j.text) }, null, 2));
      }
      const rec = JSON.parse(fs.readFileSync(af, "utf8"));
      const g = await ask("assessor", assessPrompt(rec), { schema: ASSESS_SCHEMA });
      fs.writeFileSync(af.replace(".json", ".assess.json"), JSON.stringify({ probe: p.id, run: r, ...g.data, cost: g.cost }, null, 2));
    });
    const verdicts = {}, notes = {};
    for (const id of ids) for (let r = 1; r <= runsN; r++) {
      const f = path.join(d, `${id}_r${r}.assess.json`);
      if (!fs.existsSync(f)) continue;
      for (const v of JSON.parse(fs.readFileSync(f, "utf8")).fact_verdicts) {
        if (!factById[v.id] || v.verdict === "not_applicable") continue;
        (verdicts[v.id] ||= []).push(v.verdict);
        if (v.verdict !== "correct") (notes[v.id] ||= []).push(`${id}r${r} ${v.verdict}: ${v.note}`);
      }
    }
    return { verdicts, notes, hash: hash(text) };
  }
  // Score against the no-skill baseline, over the scored facts these probes test.
  function score(res) {
    const err = Object.fromEntries(Object.entries(res.verdicts).filter(([id]) => scored(id)).map(([id, vs]) => [id, mean(vs.map((v) => W[v]))]));
    let net = 0; const breaches = [];
    for (const [id, e] of Object.entries(err)) {
      const w = weight[factById[id].importance] || 1, b = base[id];
      net += e <= b ? w * (b - e) : -HARM * w * (e - b);
      if (redLine(id) && e - b >= 0.15) breaches.push(id);
    }
    return { err, net, breaches };
  }
  // Fixes are preferred in this order: at the fact's home block, then a new line, then a repeat in another block.
  // A repeat (a fact taught in a second block) costs --repeat-penalty of net gain, so it wins only when clearly better.
  const RP = Number(opt["repeat-penalty"] ?? 0.5), adj = (c) => c.s.net - RP * (c.repeats || 0);
  const rank = (a, b) => a.s.breaches.length - b.s.breaches.length || adj(b) - adj(a) || a.words - b.words;
  // Successive halving: 1 run each, then the better half (always including the current skill) get the full runs.
  async function race(cands, ids) {
    for (const c of cands) c.s = score(await evaluate(c.text, ids, 1));
    const alive = [...cands].sort(rank).slice(0, Math.max(2, Math.ceil(cands.length / 2)));
    if (!alive.some((c) => c.id === "current")) alive.push(cands.find((c) => c.id === "current"));
    for (const c of alive) c.s = score(await evaluate(c.text, ids, R));
    return alive.sort(rank);
  }
  // Pareto front: no other candidate is at least as good on every fact and better on one.
  const front = (cs) => cs.filter((a) => !cs.some((b) => b !== a && Object.keys(a.s.err).every((id) => (b.s.err[id] ?? 1) <= a.s.err[id]) && Object.keys(a.s.err).some((id) => (b.s.err[id] ?? 1) < a.s.err[id])));

  const log = { problems, regress, gaps, probes: Qp, blocks: blocks.length, steps: [] };
  let md = `# ${skill}: optimize\n\nTarget: ${roleName("target")} · Author: ${roleName("assessor")} · runs ${R} · harm weight ${HARM} · budget ${budget} tests\n\n`
    + `**Problem facts:** ${problems.map((id) => `${id} (${pct(base[id])} wrong with no skill)`).join(", ")}. Training probes that test them: ${Qp.join(", ")}.\n\n`;
  if (Qp.length < 2) md += `Only ${Qp.length} training probe tests these facts, so every number below rests on a few answers. Add probes to make the search reliable.\n\n`;

  // 2. suspects and the block-to-fact map, from the author model
  const incumbent = await evaluate(current, Qp, R);
  const SUSPECT_SCHEMA = { type: "object", properties: { suspects: { type: "array", items: { type: "string" } }, map: { type: "array", items: { type: "object", properties: { block: { type: "string" }, facts: { type: "array", items: { type: "string" } } }, required: ["block", "facts"] } } }, required: ["suspects", "map"] };
  const listing = blocks.map((b) => `[${b.id}] ${b.text}`).join("\n\n");
  const k = Number(opt.suspects || 6);
  if (opt["dry-run"]) {
    md += `Dry run: ${blocks.length} editable blocks; the search would test about ${k * Qp.length * R} answers to find the culprit, then race up to ${k} × ${Number(opt.rewrites || 3) + 1} candidates.\n`;
    console.log(md + `\nUsed so far: ${spent()} tests (only to fill in the current skill's answers).`); return;
  }
  const sj = (await author(`A skill (instructions loaded into a model's context) was tested fact by fact. With the skill loaded, these facts are answered worse than they should be:
${problems.map((id) => `- ${id} [${factById[id].importance}]: ${factById[id].fact}\n  Grader notes: ${(incumbent.notes[id] || ["(none on the training probes)"]).slice(0, 4).join(" | ")}`).join("\n")}

The skill's blocks:

${listing}

All facts:
${facts.map((f) => `- ${f.id}: ${f.fact}`).join("\n")}

1. suspects: the ${k} block ids most likely to cause the problem facts' errors, or most relevant to fixing them, most likely first. A block can cause an error about a fact it never mentions, by stating a nearby rule without its exceptions, or by crowding it out.
2. map: for every block, the fact ids it states or teaches (empty if none).`, { schema: SUSPECT_SCHEMA })).data;
  const suspects = sj.suspects.filter((id) => blocks.some((b) => b.id === id)).slice(0, k);
  const covers = Object.fromEntries(sj.map.map((m) => [m.block, m.facts.filter((f) => factById[f])]));
  md += `## 1. Suspects\n\nThe author model's shortlist: ${suspects.join(", ")}.\n\n`;

  try {
    // 3. leave one out
    const cur = { id: "current", text: current, words: words(current) };
    cur.s = score(incumbent);
    const loo = [];
    for (const id of suspects) {
      const t = render({ [id]: null });
      const s = score(await evaluate(t, Qp, R));
      const gain = regress.reduce((g, f) => g + ((cur.s.err[f] ?? 0) - (s.err[f] ?? 0)), 0);
      loo.push({ id, gain, err: s.err });
    }
    const culprits = [...new Set([...loo.filter((l) => l.gain > 0).sort((a, b) => b.gain - a.gain).map((l) => l.id),
      ...suspects.filter((id) => (covers[id] || []).some((f) => gaps.includes(f)))])].slice(0, 3);
    md += `## 2. Leave one out\n\nEach suspect removed, the problem facts' probes re-asked ${R} times. Positive = the facts got better without the block.\n\n| block | ${regress.join(" | ")} | gain |\n|---|${regress.map(() => "---").join("|")}|---|\n`
      + `| (current) | ${regress.map((f) => pct(cur.s.err[f])).join(" | ")} | |\n`
      + loo.map((l) => `| ${l.id} | ${regress.map((f) => pct(l.err[f])).join(" | ")} | ${l.gain > 0 ? "+" : ""}${Math.round(l.gain * 100)} |`).join("\n")
      + `\n\nCulprits: ${culprits.length ? culprits.join(", ") : "none: no single block's removal helped. The cause is spread out, or the rise was chance."}\n\n`;
    log.steps.push({ step: "leave-one-out", loo, culprits });

    // 4–5. rewrites, raced per culprit
    const REWRITE_SCHEMA = { type: "object", properties: { rewrites: { type: "array", items: { type: "object", properties: { text: { type: "string" }, why: { type: "string" }, teaches: { type: "array", items: { type: "string" } } }, required: ["text", "why", "teaches"] } } }, required: ["rewrites"] };
    // A fact's home is the block(s) the map says teach it. Teaching it anywhere else is a repeat.
    const homes = (f) => Object.entries(covers).filter(([, fs_]) => fs_.includes(f)).map(([b]) => b);
    // A repeat: stating here a fact that lives in other blocks but not this one. Rewording this block's own part of a
    // multi-step fact is not a repeat.
    const repeatsIn = (blockId, teaches) => teaches.filter((f) => factById[f] && homes(f).length && !homes(f).includes(blockId)).length;
    const rules = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "WRITING_RULES.md"), "utf8");
    const winners = [];
    for (const id of culprits) {
      const b = blocks.find((x) => x.id === id), own = covers[id] || [];
      const rw = (await author(`${rules}\n\n---\n\nRewrite one block of this skill. The whole skill, for context:\n\n${current}\n\n---\n\nThe block [${id}]:\n\n${b.text}\n\nIt must keep teaching: ${own.map((f) => `${f} (${factById[f].fact})`).join("; ") || "(no listed facts)"}.\nWith it in the skill, these facts are answered worse:\n${problems.map((f) => `- ${f}: ${factById[f].fact}\n  Grader notes: ${(incumbent.notes[f] || []).slice(0, 4).join(" | ")}`).join("\n")}\n\nWrite ${Number(opt.rewrites || 3) + 1} different replacements for the block, in the same Markdown form (a bullet if it is a bullet), no longer than it, that keep what it teaches and stop the errors above.
- The first ${Number(opt.rewrites || 3)} must teach only what this block is about: fix the errors by changing this block's own wording (scope the rule, name the exception, tell the model to check, reorder), not by stating the problem facts here.
- The last one may also state a problem fact in this block, if that is the best fix, even though another block covers it.
Make them genuinely different. Return the block text only, and in "teaches" the fact ids each version states.`, { schema: REWRITE_SCHEMA })).data.rewrites;
      const cands = [cur, { id: `${id}-delete`, change: { [id]: null }, why: "delete the block" },
        ...rw.slice(0, Number(opt.rewrites || 3) + 1).map((r, i) => ({ id: `${id}-r${i + 1}`, change: { [id]: r.text.trim() }, why: r.why, repeats: repeatsIn(id, r.teaches || []) }))]
        .map((c) => (c.change ? { ...c, text: render(c.change), words: words(render(c.change)) } : c));
      const ids = [...new Set([...Qp, ...touching(own)])];
      const ranked = await race(cands, ids);
      const f = front(ranked).map((c) => c.id);
      const facts_ = [...new Set(ranked.flatMap((c) => Object.keys(c.s.err)))].sort();
      md += `## 3. Fixes for ${id}\n\n> ${b.text.replace(/\n/g, "\n> ")}\n\nRaced on ${ids.join(", ")} (${R} runs for the finalists). ★ = on the Pareto front (no other candidate is as good on every fact and better on one).\n\n`
        + `| candidate | breaches | net gain | repeats | words | ${facts_.join(" | ")} |\n|---|---|---|---|---|${facts_.map(() => "---").join("|")}|\n`
        + ranked.map((c) => `| ${f.includes(c.id) ? "★ " : ""}${c.id} | ${c.s.breaches.join(", ") || "none"} | ${c.s.net.toFixed(2)} | ${c.repeats || 0} | ${c.words} | ${facts_.map((x) => pct(c.s.err[x])).join(" | ")} |`).join("\n") + "\n\n"
        + ranked.filter((c) => c.change).map((c) => `- **${c.id}**: ${c.why}${c.change[id] ? `\n  > ${c.change[id].replace(/\n/g, "\n  > ")}` : ""}`).join("\n") + "\n\n";
      const curHere = ranked.find((c) => c.id === "current"), best = ranked[0];
      if (best.id !== "current" && rank(best, curHere) < 0) winners.push({ ...best, block: id });
      log.steps.push({ step: "race", block: id, ranked: ranked.map(({ id, why, words, s }) => ({ id, why, words, ...s })), front: f });
    }

    // 5b. add a line: one new line per problem fact, placed by the author. A repeat only if another block already covers it.
    const ADD_SCHEMA = { type: "object", properties: { lines: { type: "array", items: { type: "object", properties: { fact: { type: "string" }, after: { type: "string" }, text: { type: "string" }, why: { type: "string" } }, required: ["fact", "after", "text", "why"] } } }, required: ["lines"] };
    const adds = (await author(`${rules}\n\n---\n\nThis skill, split into blocks:\n\n${listing}\n\nWith it loaded, these facts are answered worse:\n${problems.map((f) => `- ${f}: ${factById[f].fact}\n  Grader notes: ${(incumbent.notes[f] || []).slice(0, 4).join(" | ")}`).join("\n")}\n\nFor each fact, write ONE new line to add to the skill (a bullet, in the skill's style, under 40 words) that stops the error, and the id of the block it should go after. Use the fact id in "fact".`, { schema: ADD_SCHEMA })).data.lines
      .filter((l) => factById[l.fact] && blocks.some((b) => b.id === l.after));
    if (adds.length) {
      const cands = [cur, ...adds.map((l) => { const change = { ["+" + l.after]: l.text.trim() }, t = render(change);
        return { id: `add-${l.fact}`, change, why: l.why, text: t, words: words(t), repeats: homes(l.fact).length ? 1 : 0, block: `+${l.after}` }; })];
      const ids = [...new Set([...Qp, ...touching(adds.map((l) => l.fact))])];
      const ranked = await race(cands, ids);
      const facts_ = [...new Set(ranked.flatMap((c) => Object.keys(c.s.err)))].sort();
      md += `## 3. New lines\n\nRaced on ${ids.join(", ")}.\n\n| candidate | breaches | net gain | repeats | words | ${facts_.join(" | ")} |\n|---|---|---|---|---|${facts_.map(() => "---").join("|")}|\n`
        + ranked.map((c) => `| ${c.id} | ${c.s.breaches.join(", ") || "none"} | ${c.s.net.toFixed(2)} | ${c.repeats || 0} | ${c.words} | ${facts_.map((x) => pct(c.s.err[x])).join(" | ")} |`).join("\n") + "\n\n"
        + ranked.filter((c) => c.change).map((c) => `- **${c.id}** (after ${c.block.slice(1)}): ${c.why}\n  > ${Object.values(c.change)[0]}`).join("\n") + "\n\n";
      const curHere = ranked.find((c) => c.id === "current"), best = ranked[0];
      if (best.id !== "current" && rank(best, curHere) < 0) winners.push(best);
      log.steps.push({ step: "add-line", ranked: ranked.map(({ id, why, words, repeats, s }) => ({ id, why, words, repeats, ...s })) });
    }

    // 6. combine
    let win = null;
    if (winners.length) {
      const ids = [...new Set([...Qp, ...winners.flatMap((w) => touching(covers[w.block] || []))])];
      const all = { id: "combined", text: render(Object.assign({}, ...winners.map((w) => w.change))), repeats: winners.reduce((t, w) => t + (w.repeats || 0), 0) }; all.words = words(all.text);
      const pool_ = [cur, ...(winners.length > 1 ? [all] : []), ...winners];
      for (const c of pool_) c.s = score(await evaluate(c.text, ids, R));
      pool_.sort(rank);
      win = pool_[0].id === "current" ? null : pool_[0];
      md += `## 4. Together\n\n${pool_.map((c) => `- ${c.id}: net ${c.s.net.toFixed(2)}, breaches ${c.s.breaches.join(", ") || "none"}, ${c.repeats || 0} repeats, ${c.words} words`).join("\n")}\n\n`;
    }

    // 7. holdout
    if (!win) md += `## Result: keep the current skill\n\nNo change beat it on the training probes without a red-line breach.\n`;
    else {
      const hp = holdout.map((p) => p.id);
      const hc = score(await evaluate(current, hp, R)), hw = score(await evaluate(win.text, hp, R));
      const ok = hw.breaches.length <= hc.breaches.length && hw.net >= hc.net - 0.05;
      fs.mkdirSync(path.join(dir, "optimized"), { recursive: true });
      fs.writeFileSync(path.join(dir, "optimized", "SKILL.md"), win.text);
      const dup = await repeatedFacts(win.text);
      if (dup.length) md += `**Repeated facts in the winner** (when a source changes, update every copy):\n${dup.map((d) => `- ${d.fact} ("${d.detail}") in ${d.blocks.length} places: ${d.blocks.map((b) => `"${b.slice(0, 60)}…"`).join("; ")}`).join("\n")}\n\n`;
      log.repeated = dup;
      md += `## Held-out check (probes the search never used: ${hp.join(", ")})\n\n| | net gain | breaches | words |\n|---|---|---|---|\n| current | ${hc.net.toFixed(2)} | ${hc.breaches.join(", ") || "none"} | ${words(current)} |\n| ${win.id} | ${hw.net.toFixed(2)} | ${hw.breaches.join(", ") || "none"} | ${win.words} |\n\n`
        + (ok ? `## Result: **${win.id}** recommended\n\nSaved to \`optimized/SKILL.md\`. To adopt it: copy it over \`skill/SKILL.md\`, then run verify on every probe (\`run --phase verify-injected\`) and \`compare\`. Ship only on READY.\n`
          : `## Result: not recommended\n\n${win.id} won on the training probes but did worse on the held-out ones: it fitted the test, not the topic. Saved to \`optimized/SKILL.md\` for inspection only.\n`);
      log.result = { winner: win.id, holdout: { current: hc, winner: hw }, recommended: ok };
    }
  } catch (e) {
    if (!e.budget) throw e;
    md += `\n## Stopped: ${e.message}\n\nEverything asked so far is cached; re-run with a larger --budget to continue from here.\n`;
  }
  md += `\n---\n${spent()} tests used (each: one answer and one grade).\n`;
  log.tests = spent();
  fs.writeFileSync(path.join(dir, "optimize.md"), md);
  fs.writeFileSync(path.join(dir, "optimize.json"), JSON.stringify(log, null, 2));
  console.log(md);
}

// ---------- NVIDIA SkillEvaluator (Apache-2.0): static checks, overlap, live with/without-skill runs ----------
// node skillpio.mjs evaluate <skill> [--tier quality-check|tier1|tier2|tier3]   (default quality-check: no key needed)
async function evaluate() {
  const tier = opt.tier || "quality-check";
  const bin = spawn("skillevaluator", [tier, path.join(dir, "skill")], { stdio: "inherit" });
  await new Promise((res, rej) => { bin.on("error", () => rej(new Error('skillevaluator not installed. Install: uv tool install --python 3.13 "skillevaluator[all] @ git+https://github.com/NVIDIA/SkillEvaluator.git"'))); bin.on("close", res); });
}

// ---------- scope: what the skill is measured good at, and known to fail at ----------
// Writes skills/<name>/SCOPE.md for people choosing or maintaining the skill. It is built from the test data, so it
// stays outside skill/: the model never reads it, and nothing learned from the tests goes back into the skill.
// Default data: with-skill answers in runs/verify-injected, without in runs/baseline, on the latest reserve set those
// answers cover (any probe set other than "train"), else train. --with, --without and --set override; --kind and
// --target override what loop.json records. A hand-written scope-notes.md (not covered, use instead, reviewed by) is appended.
async function scope() {
  const loop = fs.existsSync(path.join(dir, "loop.json")) ? JSON.parse(read("loop.json")) : {};
  const skillMd = fs.existsSync(path.join(dir, "skill", "SKILL.md")) ? fs.readFileSync(path.join(dir, "skill", "SKILL.md"), "utf8") : "";
  const fm = frontmatter(skillMd);
  const last = (loop.iterations || []).at(-1) || {};
  const words = skillMd ? skillMd.replace(/^---\n[\s\S]*?\n---\n/, "").split(/\s+/).filter(Boolean).length : 0;
  const kind = opt.kind || loop.kind || (validator ? "task" : haveTests ? "knowledge" : "not recorded");
  const asOf = (skillMd.replace(/^---\n[\s\S]*?\n---\n/, "").match(/\b(?:as of|as at)\s+((?:\d{1,2}\s+)?(?:[A-Z][a-z]{2,8}\.?\s+)?\d{4}(?:-\d{2})?)/i) || [])[1];
  const pct = (x) => `${Math.round(x * 100)}%`;
  let md = `# ${fm.name || skill}: scope\n\n*Generated by \`skillpio.mjs scope\` on ${new Date().toISOString().slice(0, 10)} from this folder's test data. Not loaded by the model.*\n\n`;
  md += `${fm.description || ""}\n\n`;
  md += `| | |\n|---|---|\n| Kind | **${kind}**${kind === "task" ? " (does work; answers checked by `validate.mjs`)" : kind === "knowledge" ? " (gives advice; answers graded fact by fact)" : ""} |\n`;
  md += `| Tested with | ${opt.target || loop.target || "model not recorded in loop.json"} |\n`;
  if (asOf) md += `| As of | ${asOf.trim()} |\n`;
  md += `| Version | iteration ${last.n ?? "?"}, ${words} words${last.frozen_sha256 ? `, sha256 ${last.frozen_sha256.slice(0, 12)}…` : ""} |\n`;
  const notes = path.join(dir, "scope-notes.md");
  if (!haveTests) {
    md += `\n## Measured ability\n\nNo Skillpio test data in this folder (no facts.json or probes.json), so nothing here is measured. Treat it as untested.\n`;
    if (fs.existsSync(notes)) md += `\n${fs.readFileSync(notes, "utf8").trim()}\n`;
    fs.writeFileSync(path.join(dir, "SCOPE.md"), md); console.log(`scope -> skills/${skill}/SCOPE.md (no test data)`); return;
  }
  const allProbes = JSON.parse(read("probes.json"));
  const setOf = Object.fromEntries(allProbes.map((p) => [p.id, p.set || "train"]));
  const withPh = opt.with || "verify-injected", withoutPh = opt.without || "baseline";
  const W_ = loadAssessments(withPh), WO = loadAssessments(withoutPh);
  const sets = [...new Set(W_.map((a) => setOf[a.probe]).filter(Boolean))];
  const reserveSets = sets.filter((s) => /^(holdout|reserve)/.test(s)).sort();
  const useSet = opt.set || reserveSets.at(-1) || "train";
  const inSet = (a) => setOf[a.probe] === useSet;
  const hasDecision = facts.some((f) => f.decision !== undefined);
  const scored = (f) => !hasDecision || f.decision;
  const tally = (as) => {
    const t = {};
    for (const a of as.filter(inSet)) for (const v of a.fact_verdicts || []) {
      const f = factById[v.id]; if (!f || !scored(f) || v.verdict === "not_applicable" || W[v.verdict] === undefined) continue;
      (t[v.id] ||= []).push({ v: v.verdict, note: v.note, at: `${a.probe}r${a.run}` });
    }
    return t;
  };
  const tw = tally(W_), two = tally(WO);
  // Facts without a topic get one from topics.json; if that is missing, the assessor groups the facts once and saves it
  // (it only names groups, it never sees answers or verdicts). --no-label skips this and leaves them under "general".
  const topicsFile = path.join(dir, "topics.json");
  if (!facts.some((f) => f.topic || f.section) && !fs.existsSync(topicsFile) && !opt["no-label"]) {
    const TOPIC_SCHEMA = { type: "object", properties: { topics: { type: "array", items: { type: "object", properties: { name: { type: "string" }, facts: { type: "array", items: { type: "string" } } }, required: ["name", "facts"] } } }, required: ["topics"] };
    const r = await ask("assessor", `Group these facts into 3 to 8 topics a user of the skill would recognise (for example "GST registration", "upgrade steps", "pricing"). Every fact id goes in exactly one topic. Topic names: 1 to 4 words, lower case.\n\n${facts.map((f) => `${f.id}: ${f.fact}`).join("\n")}\n\nReturn {"topics": [{"name": ..., "facts": [ids]}]}.`, { schema: TOPIC_SCHEMA });
    if (r.data?.topics) fs.writeFileSync(topicsFile, JSON.stringify(Object.fromEntries(r.data.topics.flatMap((t) => t.facts.map((id) => [id, t.name]))), null, 2));
  }
  const topicMap = fs.existsSync(topicsFile) ? JSON.parse(fs.readFileSync(topicsFile, "utf8")) : {};
  const topicOf = (f) => f.topic || f.section || topicMap[f.id] || "general";
  const topics = {};
  for (const f of facts.filter(scored)) {
    const T = (topics[topicOf(f)] ||= { facts: 0, tested: 0, w: [], wo: [] });
    T.facts++; if ((tw[f.id] || []).length) T.tested++; T.w.push(...(tw[f.id] || []).map((x) => W[x.v])); T.wo.push(...(two[f.id] || []).map((x) => W[x.v]));
  }
  const nW = W_.filter(inSet).length, probesN = new Set(W_.filter(inSet).map((a) => a.probe)).size;
  const basis = useSet === "train" ? `**train probes only** (${probesN} probes, ${nW} answers): the skill was written from these, so expect real use to be worse` : `the sealed reserve set \`${useSet}\` (${probesN} probes the author never saw, ${nW} answers)`;
  md += `| Measured on | ${basis} |\n| Scored | ${hasDecision ? "decision facts (ones that change what the user does)" : "all facts"}; an LLM grader's verdicts, not real-world outcomes |\n`;
  if (!nW) {
    md += `\n## Measured ability\n\nNo with-skill answers in \`runs/${withPh}\`, so this folder holds no measurement of the skill itself. If it was tested elsewhere, its SUMMARY.md or README.md says where; until then treat it as unmeasured. Researched topics: ${[...new Set(facts.map(topicOf))].join(", ")}.\n`;
    if (fs.existsSync(notes)) md += `\n${fs.readFileSync(notes, "utf8").trim()}\n`;
    fs.writeFileSync(path.join(dir, "SCOPE.md"), md); console.log(`scope -> skills/${skill}/SCOPE.md (${kind}; no with-skill answers)`); return;
  }
  const MIN = Number(opt["min-n"] || 10), GOOD = Number(opt.good || 0.05), WEAK = Number(opt.weak || 0.15);
  const rows = Object.entries(topics).map(([k, T]) => ({ k, ...T, err: T.w.length ? mean(T.w) : null, errWo: T.wo.length ? mean(T.wo) : null }));
  const line = (r) => `| ${r.k} | ${r.tested} of ${r.facts} | ${r.w.length} | ${r.err === null ? "–" : pct(r.err)} | ${r.errWo === null ? "–" : pct(r.errWo)} |`;
  const head = `| topic | facts tested | graded verdicts | error with skill | error without |\n|---|---|---|---|---|\n`;
  const good = rows.filter((r) => r.w.length >= MIN && r.err <= GOOD).sort((a, b) => a.err - b.err);
  const weak = rows.filter((r) => r.w.length >= MIN && r.err >= WEAK).sort((a, b) => b.err - a.err);
  const mid = rows.filter((r) => r.w.length >= MIN && r.err > GOOD && r.err < WEAK);
  const thin = rows.filter((r) => r.w.length < MIN);
  md += `\n## Good at (error ≤ ${pct(GOOD)}, at least ${MIN} verdicts)\n\n${good.length ? head + good.map(line).join("\n") : "No topic met this bar."}\n`;
  if (mid.length) md += `\n## Usable, with some errors (between ${pct(GOOD)} and ${pct(WEAK)})\n\n${head}${mid.map(line).join("\n")}\n`;
  md += `\n## Weak (error ≥ ${pct(WEAK)})\n\n${weak.length ? head + weak.map(line).join("\n") : "No topic reached this error rate."}\n`;
  const fails = facts.filter((f) => scored(f) && (tw[f.id] || []).some((x) => x.v === "wrong" || x.v === "missing"))
    .map((f) => ({ f, xs: tw[f.id], bad: tw[f.id].filter((x) => x.v === "wrong" || x.v === "missing") })).sort((a, b) => b.bad.length / b.xs.length - a.bad.length / a.xs.length);
  md += `\n## Known to fail (facts answered wrong or left out with the skill loaded)\n\nPartly right answers count half in the error rates above but are not listed here.\n\n`;
  md += fails.length ? fails.map(({ f, xs, bad }) => `- **${f.id}** (${topicOf(f)}), wrong or missing in ${bad.length} of ${xs.length}: ${f.fact}\n  - e.g. ${bad[0].at}: ${String(bad[0].note || "").slice(0, 240)}`).join("\n") : "None on this data.";
  md += `\n\n## Too little data to judge (fewer than ${MIN} verdicts)\n\n${thin.length ? head + thin.map(line).join("\n") : "None."}\n`;
  const untested = facts.filter((f) => scored(f) && !(tw[f.id] || []).length);
  if (untested.length) md += `\n## Researched but never tested on this set (${untested.length} facts)\n\nThe skill may state these, but no test on this set checked them, so they count as unmeasured.\n\n<details><summary>List</summary>\n\n${untested.map((f) => `- ${f.id} (${topicOf(f)}): ${f.fact}`).join("\n")}\n\n</details>\n`;
  md += `\n## Not covered\n\nAnything outside the topics above: the skill was not researched or tested there, so on those questions it is the bare model.\n`;
  if (fs.existsSync(notes)) md += `\n${fs.readFileSync(notes, "utf8").trim()}\n`;
  fs.writeFileSync(path.join(dir, "SCOPE.md"), md);
  console.log(`scope -> skills/${skill}/SCOPE.md (${kind}; ${useSet}; ${good.length} good, ${mid.length} usable, ${weak.length} weak, ${thin.length} thin, ${fails.length} known failures)`);
}

const steps = { probe, assess, report, compare, purge: purgeToolCallAnswers, "check-facts": checkFacts, calibration: calibrationReport, "grade-sheet": gradeSheet, agreement, docs, "trigger-eval": triggerEval, "tune-description": tuneDescription, "blind-compare": blindCompare, evaluate, scope, optimize, repeats, sweeps };
if (cmd === "run") { purgeToolCallAnswers(); await probe(); await assess(); if (phase === "calibrate") calibrationReport(); else report(); }
else if (steps[cmd]) await steps[cmd]();
else { console.error(`unknown command ${cmd}`); process.exit(1); }
