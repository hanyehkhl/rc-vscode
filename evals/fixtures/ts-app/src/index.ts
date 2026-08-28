import { formatList } from "./format.js";
import { TaskStore } from "./store.js";
import { isPriority, validateTitle } from "./validate.js";

export function seedStore(): TaskStore {
  const store = new TaskStore();
  store.add("Write the design doc", "high");
  store.add("Reply to code review", "normal");
  store.add("Tidy the changelog", "low");
  store.complete(3);
  return store;
}

export function addChecked(store: TaskStore, title: string, priority: string): string {
  const problem = validateTitle(title);
  if (problem) {
    return problem;
  }
  if (!isPriority(priority)) {
    return `Unknown priority: ${priority}`;
  }
  const task = store.add(title.trim(), priority);
  return `Added #${task.id}`;
}

export function render(store: TaskStore): string {
  return formatList(store.sorted());
}
