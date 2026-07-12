/**
 * Lesson storage utilities for persistent learning memory.
 * Supports multiple storage paths (Pi and Copilot).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export type LessonCategory =
  | "task_misunderstanding"
  | "context_loss"
  | "incomplete_info"
  | "verification_failure"
  | "tool_misuse"
  | "premature_conclusion"
  | "chain_error"
  | "instruction_ignored"
  | "other";

export interface Lesson {
  id: string;
  timestamp: string;
  category: LessonCategory;
  summary: string; // Short advice to inject in system prompt
  detail: string; // Full context for reference
  trace_id: string;
  count: number; // How many times this lesson has been seen
  last_seen: string;
}

export interface LessonStorageConfig {
  path?: string; // Override default path
  maxLessons?: number;
}

const DEFAULT_LESSONS_PATH_PI = join(homedir(), ".pi", "agent", "pi-lessons.json");
const DEFAULT_LESSONS_PATH_COPILOT = join(homedir(), ".copilot", "copilot-lessons.json");

/**
 * Get lessons file path
 * @param agent - "pi" or "copilot"
 * @param override - custom path override
 */
export function getLessonsPath(agent: "pi" | "copilot", override?: string): string {
  if (override) return override;
  if (agent === "pi") return DEFAULT_LESSONS_PATH_PI;
  return DEFAULT_LESSONS_PATH_COPILOT;
}

/**
 * Load lessons from file
 */
export function loadLessons(path: string): Lesson[] {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8")) as Lesson[];
    }
  } catch (e) {
    console.warn(`[lesson-storage] Failed to load lessons from ${path}:`, e);
  }
  return [];
}

/**
 * Save lessons to file
 */
export function saveLessons(lessons: Lesson[], path: string): boolean {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(lessons, null, 2), "utf-8");
    return true;
  } catch (e) {
    console.warn(`[lesson-storage] Failed to save lessons to ${path}:`, e);
    return false;
  }
}

/**
 * Generate fingerprint for lesson deduplication
 */
export function lessonFingerprint(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[.,!?;:'"()]/g, "")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Find matching lesson by fingerprint (fuzzy)
 */
export function findMatchingLesson(lessons: Lesson[], summary: string): Lesson | undefined {
  const fp = lessonFingerprint(summary);
  return lessons.find((l) => {
    const lfp = lessonFingerprint(l.summary);
    if (lfp === fp) return true;
    if (lfp.includes(fp) || fp.includes(lfp)) return true;
    return false;
  });
}

import { randomBytes } from "node:crypto";

/**
 * Upsert lesson into lessons array (update if duplicate, insert if new)
 */
export function upsertLesson(
  lessons: Lesson[],
  category: LessonCategory,
  summary: string,
  detail: string,
  trace_id: string,
  maxLessons = 50,
): Lesson[] {
  const now = new Date().toISOString();
  const existing = findMatchingLesson(lessons, summary);

  if (existing) {
    // Update existing lesson
    return lessons.map((l) =>
      l.id === existing.id ? { ...l, count: l.count + 1, last_seen: now } : l,
    );
  }

  // Create new lesson
  const newLesson: Lesson = {
    id: randomBytes(4).toString("hex"),
    timestamp: now,
    category,
    summary,
    detail,
    trace_id,
    count: 1,
    last_seen: now,
  };

  lessons = [newLesson, ...lessons];
  if (lessons.length > maxLessons) {
    lessons = lessons.slice(0, maxLessons);
  }
  return lessons;
}

/**
 * Get top N lessons by frequency and recency
 */
export function getTopLessons(lessons: Lesson[], count = 8): Lesson[] {
  return lessons
    .sort((a, b) => {
      // Sort by count (desc), then by last_seen (desc)
      const countDiff = b.count - a.count;
      if (countDiff !== 0) return countDiff;
      return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
    })
    .slice(0, count);
}

/**
 * Format lessons for system prompt injection
 */
export function formatLessonsForPrompt(lessons: Lesson[]): string {
  if (lessons.length === 0) return "";
  const lines = [
    "## Things I learned from past mistakes (I will try to avoid these):",
    "",
  ];
  for (const lesson of lessons) {
    lines.push(`- **[${lesson.category.toUpperCase()}]** ${lesson.summary}`);
  }
  return lines.join("\n");
}
