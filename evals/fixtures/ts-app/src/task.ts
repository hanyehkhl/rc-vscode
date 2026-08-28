export type Priority = "low" | "normal" | "high";

export type Task = {
  id: number;
  title: string;
  done: boolean;
  priority: Priority;
  tags: string[];
};

/** Sort weight for a priority. Higher sorts first. */
export function priorityWeight(priority: Priority): number {
  switch (priority) {
    case "high":
      return 2;
    case "normal":
      return 1;
    case "low":
      return 0;
  }
}

export function createTask(id: number, title: string, priority: Priority = "normal"): Task {
  return { id, title, done: false, priority, tags: [] };
}
