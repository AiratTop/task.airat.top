export interface SubTask {
  id: string;
  title: string;
  completed: boolean;
}

export type TaskPriority = "low" | "normal" | "high";

export interface Task {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  createdAt: number;
  completedAt?: number;
  priority?: TaskPriority;
  dueDate?: string;
  tags: string[];
  subtasks: SubTask[];
  isDecomposed: boolean;
  isGeneratingTags: boolean;
  isDecomposing: boolean;
}

export type FilterType = "all" | "active" | "completed";

export interface AppSettings {
  theme: "light" | "dark" | "system";
}
