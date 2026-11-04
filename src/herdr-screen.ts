/**
 * Turning a full-screen agent's terminal (Claude Code / Codex) into something readable on a phone.
 *
 * A raw screen is mostly UI: separator rules (which wrap into several lines in DingTalk), the input
 * box with its grey prompt suggestion, the status bar, "Update installed" banners and timing lines.
 * `stripChrome` removes that; `turnSummary` keeps only the agent's prose from the latest turn.
 */

const BOX_RE = /[─━═╌╍┄┅┈┉│┃║╭╮╰╯┌┐└┘├┤┬┴┼▔▁\-=]/g;
const STATUS_RE = /auto mode|shift\+tab|to manage|for shortcuts|context left|% left|esc to (interrupt|cancel)|bypass permissions|accept edits|plan mode on|⏎ send|newline|ctrl\+[a-z]|update installed|restart to update|\bshells? still running|^\s*[⏵▸►]{2}/i;
const PROMPT_RE = /^\s*[❯›>](\s|$)/;
const MENU_RE = /^\s*[❯›>]\s*\d+\./;
const TIMING_RE = /^[✻✶✳✢✽✺*·]\s.*\bfor \d+(\.\d+)?(ms|s|m|h)\b/;
const TOOL_HEAD_RE = /^[●•⏺]\s+(?:Background command\b|[A-Z][\w-]*(?:\s[\w-]+)?\(|(?:Ran|Explored|Edited|Read|Called|Updated|Added|Deleted|Searched|Waited|Listed|Wrote|Viewed|Fetched)\b)/;
const COLLAPSED_RE = /^\s{1,4}(?:Ran|Searched|Read|Wrote|Edited|Listed|Updated|Created|Fetched|Explored|Called)\b.*\b(?:command|pattern|file|files|director(?:y|ies)|tool|tools|url)s?\b/i;
const BRANCH_RE = /^\s*[⎿└├│]/;
const BULLET_RE = /^[●•⏺]\s+/;

/** Terminal columns a string takes (CJK and fullwidth count double). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) ? 2 : 1;
  }
  return w;
}

/** A separator rule: mostly box-drawing characters (text like "─ Worked for 1m ─────" included). */
export function isRule(line: string): boolean {
  const t = line.trim();
  if (t.length < 12) return false;
  const box = (t.match(BOX_RE) || []).length;
  return box / t.length >= 0.6;
}

const isStatus = (l: string) => STATUS_RE.test(l);

/**
 * Remove UI chrome: the input box at the bottom (prompt line, possibly holding only a grey
 * suggestion, with its rules and the status bar under it), every separator rule, banners.
 * A numbered menu (`❯ 1. Yes`) is a question, not the input box, so it is kept.
 */
export function stripChrome(text: string): string[] {
  const lines = String(text || "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "")
    .split("\n").map((l) => l.replace(/\s+$/, ""));
  // cut the input box: walk up over blanks/status/rules; a prompt line there is the input
  let i = lines.length - 1;
  while (i >= 0 && (!lines[i].trim() || isStatus(lines[i]) || isRule(lines[i]))) i--;
  if (i >= 0 && PROMPT_RE.test(lines[i]) && !MENU_RE.test(lines[i])) {
    let j = i - 1;
    while (j >= 0 && isRule(lines[j])) j--;
    lines.length = j + 1;
  }
  return lines
    .filter((l) => !isRule(l) && !/update installed|restart to update/i.test(l))
    .map((l) => l.replace(/\s*\(disable recaps in \/config\)/, "").replace(/^\s{8,}/, "  "));
}

/** Join lines the terminal wrapped back into one, so a phone can wrap them at its own width. */
export function unwrap(lines: string[], width: number): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    const cont = l.match(/^( {2,4})(\S.*)$/);
    const item = prev?.match(/^(\s*)(?:[-*•]|\d+[.)])\s/);
    const hanging = !!(item && cont && cont[1].length === item[1].length + 2);
    if (prev && cont && (hanging || displayWidth(prev) >= width - 16) && !/^([-*•]|\d+[.)])\s/.test(cont[2]) && !BRANCH_RE.test(l)) {
      const glue = /[⺀-￿]$/.test(prev) || /^[⺀-￿]/.test(cont[2]) ? "" : " ";
      out[out.length - 1] = prev + glue + cont[2];
    } else out.push(l);
  }
  return out;
}

function screenWidth(text: string): number {
  let w = 0;
  for (const l of String(text || "").split("\n")) {
    const d = displayWidth(l.replace(/\s+$/, ""));
    if (isRule(l)) return d;
    if (d > w) w = d;
  }
  return w || 80;
}

/** Cleaned screen for reading: chrome removed, wraps joined, blank runs collapsed, last `max` lines. */
export function readable(text: string, max: number): string[] {
  const lines = unwrap(stripChrome(text), screenWidth(text))
    .filter((l, i, a) => l.trim() || (a[i - 1] ?? "").trim());
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.slice(-max);
}

export interface TurnSummary {
  ask: string;      // what the user sent this turn ("" when it is off screen)
  lines: string[];  // the agent's prose from this turn, newest last
  title: string;    // first sentence of the agent's last message
}

/**
 * The latest turn's prose: everything after the last user prompt in the history, minus tool calls
 * and their output, collapsed tool summaries, timing lines and recaps. Falls back to the cleaned
 * tail of the screen when no prose is found.
 */
export function turnSummary(text: string, maxLines = 12, maxChars = 1200): TurnSummary {
  const lines = unwrap(stripChrome(text), screenWidth(text));
  let start = 0, ask = "";
  for (let k = lines.length - 1; k >= 0; k--) {
    if (/^[❯›>]\s+\S/.test(lines[k]) && !MENU_RE.test(lines[k])) {
      start = k + 1;
      ask = lines[k].replace(/^[❯›>]\s+/, "").trim();
      break;
    }
  }
  // a turn ends with a timing line ("✻ Cooked for 12s"); keep the latest turn that has prose
  let seg = lines.slice(start);
  const timing = seg.map((l, k) => (TIMING_RE.test(l) ? k : -1)).filter((k) => k >= 0);
  if (timing.length) {
    const lastT = timing[timing.length - 1];
    const after = seg.slice(lastT + 1).some((l) => BULLET_RE.test(l) && !TOOL_HEAD_RE.test(l));
    if (!after) seg = seg.slice(timing.length > 1 ? timing[timing.length - 2] + 1 : 0, lastT);
    else seg = seg.slice(lastT + 1);
  }
  const prose: string[][] = [];
  let skip = false;
  for (const l of seg) {
    if (!l.trim()) { skip = false; continue; }
    if (skip) continue;
    if (TOOL_HEAD_RE.test(l) || /^※\s/.test(l)) { skip = true; continue; }
    if (TIMING_RE.test(l) || COLLAPSED_RE.test(l) || BRANCH_RE.test(l) || isStatus(l)) continue;
    if (BULLET_RE.test(l)) { prose.push([l.replace(BULLET_RE, "")]); continue; }
    if (prose.length) prose[prose.length - 1].push(l.replace(/^ {2}/, ""));
  }
  let out: string[] = [];
  for (let b = prose.length - 1; b >= 0; b--) {
    const next = [...prose[b], ...out];
    if (out.length && (next.length > maxLines || next.join("\n").length > maxChars)) break;
    out = next;
  }
  if (out.length > maxLines) out = out.slice(0, maxLines).concat("…");
  let joined = out.join("\n");
  if (joined.length > maxChars) out = (joined.slice(0, maxChars) + "…").split("\n");
  const last = prose[prose.length - 1]?.join(" ") || "";
  const title = (last.match(/^.{1,60}?[。！？!?]/)?.[0] || (last.length > 50 ? last.slice(0, 50) + "…" : last)).trim();
  if (!out.length) out = readable(text, 8);
  return { ask: ask.slice(0, 80), lines: out, title };
}
