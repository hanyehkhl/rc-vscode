import { createTask, priorityWeight, type Priority, type Task } from "./task.js";

/**
 * In-memory task store. Every mutation goes through here so the rest of the
 * app can treat `Task` values as immutable snapshots.
 */
export class TaskStore {
  private tasks: Task[] = [];
  private nextId = 1;

  add(title: string, priority: Priority = "normal"): Task {
    const task = createTask(this.nextId, title, priority);
    this.nextId += 1;
    this.tasks.push(task);
    return task;
  }

  find(id: number): Task | undefined {
    return this.tasks.find((task) => task.id === id);
  }

  complete(id: number): boolean {
    const task = this.find(id);
    if (!task) {
      return false;
    }
    task.done = true;
    return true;
  }

  remove(id: number): boolean {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((task) => task.id !== id);
    return this.tasks.length < before;
  }

  all(): Task[] {
    return [...this.tasks];
  }

  /** Highest priority first; ties keep insertion order. */
  sorted(): Task[] {
    return [...this.tasks].sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority));
  }

  count(): number {
    return this.tasks.length;
  }
}
