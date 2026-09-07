/**
 * Content schema for the playground. Every code string is a complete,
 * runnable TypeScript file that imports from "effect" and prints to console.
 */

export interface Lesson {
  id: string
  title: string
  /** Markdown. Plain English first. May include tables and side-by-side comparisons. */
  explain: string
  /** Full runnable program. */
  code: string
  /** Exact stdout (trimmed) the code prints. Verified by scripts/verify.ts. */
  expectedOutput: string
  /** Optional markdown shown under the output: what to notice, what to try changing. */
  after?: string
}

export interface Challenge {
  id: string
  title: string
  /** Markdown. What is wrong or missing, in one or two sentences. */
  task: string
  /** The broken/incomplete program the learner edits. Must NOT pass the check. */
  code: string
  /** A corrected program that passes. */
  solution: string
  /** Exact stdout (trimmed) the solution prints. */
  expectedOutput: string
  /** Progressive hints, first is vague, last nearly gives it away. */
  hints: Array<string>
  /** Markdown shown after success: why the fix works. */
  explanation: string
}

export interface Problem {
  id: string
  title: string
  /** Markdown spec: what to build, exact output required. */
  spec: string
  /** Skeleton with imports and TODOs. */
  starter: string
  solution: string
  expectedOutput: string
  hints: Array<string>
}

export interface Recall {
  q: string
  /** Markdown answer, hidden until revealed. */
  a: string
}

export interface DoDont {
  /** Imperative, STE. What to do. */
  do: string
  /** What not to do, the common mistake. */
  dont: string
  /** One sentence: what goes wrong if you do the wrong thing. */
  why: string
}

export interface Section {
  id: string
  title: string
  /** Position in the sidebar. */
  order: number
  /** One line under the title. */
  summary: string
  /** Markdown. The mental model: the problem this solves, then the idea. */
  intro: string
  lessons: Array<Lesson>
  /** 5-8 pairs. Shown between Learn and Fix it. */
  dosAndDonts: Array<DoDont>
  challenges: Array<Challenge>
  problems: Array<Problem>
  recall: Array<Recall>
}
