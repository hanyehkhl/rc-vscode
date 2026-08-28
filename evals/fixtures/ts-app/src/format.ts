import { defaultConfig, type Config } from "./config.js";
import type { Task } from "./task.js";

export function formatTask(task: Task): string {
  const box = task.done ? "[x]" : "[ ]";
  const tags = task.tags.length > 0 ? ` (${task.tags.join(", ")})` : "";
  return `${box} #${task.id} ${task.title} <${task.priority}>${tags}`;
}

export function formatList(tasks: Task[], config: Config = defaultConfig): string {
  const visible = config.hideDone ? tasks.filter((task) => !task.done) : tasks;
  return visible.slice(0, config.pageSize).map(formatTask).join("\n");
}
