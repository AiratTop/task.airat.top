import React, { useState, useEffect, useMemo, useRef } from "react";
import { 
  Clock,
  Plus, 
  Mic,
  MicOff,
  Trash2, 
  CheckCircle2, 
  Circle, 
  Moon, 
  Sun, 
  Github, 
  ExternalLink, 
  Sparkles, 
  Split, 
  Pencil,
  Check,
  Flag,
  RotateCcw,
  Download,
  ChevronDown, 
  ChevronUp,
  Search,
  Filter,
  MoreVertical,
  X,
  Loader2,
  GripVertical
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { format } from "date-fns";
import { cn } from "./lib/utils";
import { Task, SubTask, FilterType, AppSettings, TaskPriority } from "./types";
import { analyzeTask, decomposeTask } from "./services/gemini";

const STORAGE_KEY = "airat_tasks_v1";
const SETTINGS_KEY = "airat_settings_v1";

const createId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2, 11);

const TASK_PRIORITIES: { value: TaskPriority; label: string; className: string }[] = [
  { value: "low", label: "Low", className: "text-emerald-600 dark:text-emerald-400" },
  { value: "normal", label: "Normal", className: "text-muted-foreground" },
  { value: "high", label: "High", className: "text-rose-600 dark:text-rose-400" },
];

const getTaskPriority = (task: Task): TaskPriority => task.priority ?? "normal";

const shouldSkipAiAnalysis = (title: string) => title.trim().toLowerCase() === "test";

const getTodayDateKey = () => format(new Date(), "yyyy-MM-dd");

const getDateKeyInDays = (daysFromToday: number) => {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  return format(date, "yyyy-MM-dd");
};

const getDueDateStatus = (task: Task) => {
  if (!task.dueDate) return null;

  const today = getTodayDateKey();

  if (!task.completed && task.dueDate < today) {
    return {
      label: "Overdue",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    };
  }

  if (task.dueDate === today) {
    return {
      label: "Today",
      className: "border-primary/30 bg-primary/10 text-primary",
    };
  }

  return {
    label: "Due",
    className: "border-border bg-muted/50 text-muted-foreground",
  };
};

type UndoAction = {
  id: string;
  message: string;
  restore: () => void;
};

const createDemoTask = (): Task => ({
  id: createId(),
  title: "Explore Task.Airat.Top features",
  completed: false,
  createdAt: Date.now(),
  priority: "high",
  dueDate: getDateKeyInDays(1),
  tags: ["demo", "workflow", "local-first"],
  subtasks: [
    {
      id: createId(),
      title: "Edit this task title inline",
      completed: false,
    },
    {
      id: createId(),
      title: "Drag tasks and subtasks to reorder them",
      completed: false,
    },
    {
      id: createId(),
      title: "Set a manual due date and priority",
      completed: false,
    },
    {
      id: createId(),
      title: "Delete something and restore it with Undo within 3 seconds",
      completed: false,
    },
  ],
  isDecomposed: true,
  isGeneratingTags: false,
  isDecomposing: false,
});

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settings, setSettings] = useState<AppSettings>({ theme: "system" });
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  );
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTaskTitle, setEditingTaskTitle] = useState("");
  const [editingTaskError, setEditingTaskError] = useState<string | null>(null);
  const [newSubtaskTitles, setNewSubtaskTitles] = useState<Record<string, string>>({});
  const [newSubtaskErrors, setNewSubtaskErrors] = useState<Record<string, string | null>>({});
  const [editingSubtask, setEditingSubtask] = useState<{
    taskId: string;
    subtaskId: string;
    title: string;
    error: string | null;
  } | null>(null);
  const [draggedSubtask, setDraggedSubtask] = useState<{
    taskId: string;
    subtaskId: string;
  } | null>(null);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  // Load data
  useEffect(() => {
    const savedTasks = localStorage.getItem(STORAGE_KEY);
    const savedSettings = localStorage.getItem(SETTINGS_KEY);
    
    if (savedTasks) {
      setTasks(JSON.parse(savedTasks));
    } else {
      setTasks([createDemoTask()]);
    }
    if (savedSettings) setSettings(JSON.parse(savedSettings));
    
    setIsLoaded(true);
  }, []);

  // Save data
  useEffect(() => {
    if (isLoaded) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    }
  }, [tasks, isLoaded]);

  useEffect(() => {
    if (isLoaded) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }
  }, [settings, isLoaded]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (undoTimerRef.current) {
        window.clearTimeout(undoTimerRef.current);
      }
    };
  }, []);

  // Theme management
  useEffect(() => {
    const root = window.document.documentElement;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    
    const applyTheme = () => {
      const systemTheme = mediaQuery.matches ? "dark" : "light";
      const activeTheme = settings.theme === "system" ? systemTheme : settings.theme;
      
      root.classList.remove("light", "dark");
      root.classList.add(activeTheme);
      setResolvedTheme(activeTheme);
    };

    applyTheme();
    
    if (settings.theme === "system") {
      mediaQuery.addEventListener("change", applyTheme);
      return () => mediaQuery.removeEventListener("change", applyTheme);
    }
  }, [settings.theme]);

  const clearCompleted = () => {
    const completedTasks = tasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => task.completed);

    if (completedTasks.length === 0) return;

    showUndo({
      id: createId(),
      message:
        completedTasks.length === 1
          ? "Completed task cleared"
          : `${completedTasks.length} completed tasks cleared`,
      restore: () => {
        setTasks(prev => {
          const next = [...prev];

          completedTasks.forEach(({ task, index }) => {
            if (next.some(existingTask => existingTask.id === task.id)) return;
            next.splice(Math.min(index, next.length), 0, task);
          });

          return next;
        });
      },
    });

    setTasks(prev => prev.filter(t => !t.completed));
  };

  const showUndo = (action: UndoAction) => {
    if (undoTimerRef.current) {
      window.clearTimeout(undoTimerRef.current);
    }

    setUndoAction(action);
    undoTimerRef.current = window.setTimeout(() => {
      setUndoAction(null);
      undoTimerRef.current = null;
    }, 3000);
  };

  const handleUndo = () => {
    if (!undoAction) return;

    if (undoTimerRef.current) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }

    undoAction.restore();
    setUndoAction(null);
  };

  const exportTasks = () => {
    const payload = {
      source: "task.airat.top",
      exportedAt: new Date().toISOString(),
      tasks,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `task-airat-top-tasks-${getTodayDateKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleVoiceInput = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const SpeechRecognitionConstructor =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionConstructor) {
      setError("Voice input is not supported in this browser");
      return;
    }

    const recognition = new SpeechRecognitionConstructor();
    const initialText = newTaskTitle.trim();
    let transcript = "";

    recognitionRef.current = recognition;
    recognition.lang = navigator.language || "ru-RU";
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setError(null);
      setIsListening(true);
    };

    recognition.onresult = (event) => {
      let finalTranscript = "";
      let interimTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";

        if (result.isFinal) {
          finalTranscript += text;
        } else {
          interimTranscript += text;
        }
      }

      if (finalTranscript.trim()) {
        transcript = `${transcript} ${finalTranscript}`.trim();
      }

      const currentTranscript = `${transcript} ${interimTranscript}`.trim();
      setNewTaskTitle([initialText, currentTranscript].filter(Boolean).join(" "));
    };

    recognition.onerror = (event) => {
      if (event.error !== "no-speech" && event.error !== "aborted") {
        setError("Could not recognize speech. Please try again.");
      }
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognition.start();
  };

  const addTask = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const title = newTaskTitle.trim();
    
    if (!title) return;

    if (title.length < 3) {
      setError("Task is too short (min 3 chars)");
      return;
    }
    
    if (title.length > 120) {
      setError("Task is too long (max 120 chars)");
      return;
    }
    
    if (tasks.length >= 100) {
      setError("Task limit reached (max 100). Please clear some tasks.");
      return;
    }

    setError(null);

    const newTask: Task = {
      id: createId(),
      title: title,
      completed: false,
      createdAt: Date.now(),
      priority: "normal",
      dueDate: undefined,
      tags: [],
      subtasks: [],
      isDecomposed: false,
      isGeneratingTags: !shouldSkipAiAnalysis(title),
      isDecomposing: false,
    };

    setTasks(prev => [newTask, ...prev]);
    setNewTaskTitle("");

    if (shouldSkipAiAnalysis(title)) return;

    // AI Tagging
    try {
      const { tags } = await analyzeTask(newTask.title);
      setTasks(prev => prev.map(t => 
        t.id === newTask.id ? { ...t, tags, isGeneratingTags: false } : t
      ));
    } catch (error) {
      setTasks(prev => prev.map(t => 
        t.id === newTask.id ? { ...t, isGeneratingTags: false } : t
      ));
    }
  };

  const toggleTask = (id: string) => {
    setTasks(prev => prev.map(t => {
      if (t.id === id) {
        const completed = !t.completed;
        return { 
          ...t, 
          completed, 
          completedAt: completed ? Date.now() : undefined 
        };
      }
      return t;
    }));
  };

  const updateTaskPriority = (id: string, priority: TaskPriority) => {
    setTasks(prev => prev.map(t =>
      t.id === id ? { ...t, priority } : t
    ));
  };

  const updateTaskDueDate = (id: string, dueDate: string) => {
    setTasks(prev => prev.map(t =>
      t.id === id ? { ...t, dueDate: dueDate || undefined } : t
    ));
  };

  const deleteTask = (id: string) => {
    const taskIndex = tasks.findIndex(t => t.id === id);
    const deletedTask = tasks[taskIndex];

    if (!deletedTask) return;

    showUndo({
      id: createId(),
      message: "Task deleted",
      restore: () => {
        setTasks(prev => {
          if (prev.some(t => t.id === deletedTask.id)) return prev;

          const next = [...prev];
          next.splice(Math.min(taskIndex, next.length), 0, deletedTask);
          return next;
        });
      },
    });

    setTasks(prev => prev.filter(t => t.id !== id));
    if (editingTaskId === id) {
      setEditingTaskId(null);
      setEditingTaskTitle("");
      setEditingTaskError(null);
    }
  };

  const startEditingTask = (task: Task) => {
    setEditingTaskId(task.id);
    setEditingTaskTitle(task.title);
    setEditingTaskError(null);
  };

  const cancelEditingTask = () => {
    setEditingTaskId(null);
    setEditingTaskTitle("");
    setEditingTaskError(null);
  };

  const saveEditedTask = async () => {
    if (!editingTaskId) return;

    const title = editingTaskTitle.trim();
    const currentTask = tasks.find(t => t.id === editingTaskId);

    if (!currentTask) {
      cancelEditingTask();
      return;
    }

    if (title.length < 3) {
      setEditingTaskError("Task is too short (min 3 chars)");
      return;
    }

    if (title.length > 120) {
      setEditingTaskError("Task is too long (max 120 chars)");
      return;
    }

    if (title === currentTask.title) {
      cancelEditingTask();
      return;
    }

    const taskId = editingTaskId;
    setEditingTaskId(null);
    setEditingTaskTitle("");
    setEditingTaskError(null);
    setTasks(prev => prev.map(t =>
      t.id === taskId
        ? { ...t, title, tags: [], isGeneratingTags: !shouldSkipAiAnalysis(title) }
        : t
    ));

    if (shouldSkipAiAnalysis(title)) return;

    try {
      const { tags } = await analyzeTask(title);
      setTasks(prev => prev.map(t =>
        t.id === taskId ? { ...t, tags, isGeneratingTags: false } : t
      ));
    } catch (error) {
      setTasks(prev => prev.map(t =>
        t.id === taskId ? { ...t, isGeneratingTags: false } : t
      ));
    }
  };

  const moveTaskBefore = (taskId: string, targetTaskId: string) => {
    if (taskId === targetTaskId) return;

    setTasks(prev => {
      const fromIndex = prev.findIndex(t => t.id === taskId);
      const targetIndex = prev.findIndex(t => t.id === targetTaskId);

      if (fromIndex === -1 || targetIndex === -1) return prev;

      const next = [...prev];
      const [movedTask] = next.splice(fromIndex, 1);
      const adjustedTargetIndex = next.findIndex(t => t.id === targetTaskId);

      if (adjustedTargetIndex === -1) return prev;

      next.splice(adjustedTargetIndex, 0, movedTask);
      return next;
    });
  };

  const moveTaskAfter = (taskId: string, targetTaskId: string) => {
    if (taskId === targetTaskId) return;

    setTasks(prev => {
      const fromIndex = prev.findIndex(t => t.id === taskId);
      const targetIndex = prev.findIndex(t => t.id === targetTaskId);

      if (fromIndex === -1 || targetIndex === -1) return prev;

      const next = [...prev];
      const [movedTask] = next.splice(fromIndex, 1);
      const adjustedTargetIndex = next.findIndex(t => t.id === targetTaskId);

      if (adjustedTargetIndex === -1) return prev;

      next.splice(adjustedTargetIndex + 1, 0, movedTask);
      return next;
    });
  };

  const moveTaskByVisibleStep = (taskId: string, direction: -1 | 1) => {
    const visibleIndex = filteredTasks.findIndex(t => t.id === taskId);
    const targetTask = filteredTasks[visibleIndex + direction];

    if (!targetTask) return;

    if (direction < 0) {
      moveTaskBefore(taskId, targetTask.id);
      return;
    }

    moveTaskAfter(taskId, targetTask.id);
  };

  const handleTaskDrop = (targetTaskId: string, event: React.DragEvent<HTMLDivElement>) => {
    if (draggedTaskId) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const shouldMoveAfter = event.clientY > bounds.top + bounds.height / 2;

      if (shouldMoveAfter) {
        moveTaskAfter(draggedTaskId, targetTaskId);
      } else {
        moveTaskBefore(draggedTaskId, targetTaskId);
      }
    }
    setDraggedTaskId(null);
  };

  const handleDecompose = async (id: string) => {
    const task = tasks.find(t => t.id === id);
    if (!task || task.isDecomposed || task.isDecomposing) return;

    setTasks(prev => prev.map(t => 
      t.id === id ? { ...t, isDecomposing: true } : t
    ));

    try {
      const subtaskTitles = await decomposeTask(task.title);
      const newSubtasks: SubTask[] = subtaskTitles.map(title => ({
        id: createId(),
        title,
        completed: false,
      }));

      setTasks(prev => prev.map(t => 
        t.id === id ? { 
          ...t, 
          subtasks: newSubtasks, 
          isDecomposed: true, 
          isDecomposing: false 
        } : t
      ));
    } catch (error) {
      setTasks(prev => prev.map(t => 
        t.id === id ? { ...t, isDecomposing: false } : t
      ));
    }
  };

  const toggleSubtask = (taskId: string, subtaskId: string) => {
    setTasks(prev => prev.map(t => {
      if (t.id === taskId) {
        const updatedSubtasks = t.subtasks.map(st => 
          st.id === subtaskId ? { ...st, completed: !st.completed } : st
        );
        // Auto-complete parent if all subtasks are done? Maybe not, let user decide.
        return { ...t, subtasks: updatedSubtasks };
      }
      return t;
    }));
  };

  const validateSubtaskTitle = (title: string) => {
    if (title.length < 2) return "Subtask is too short (min 2 chars)";
    if (title.length > 120) return "Subtask is too long (max 120 chars)";
    return null;
  };

  const addSubtask = (taskId: string) => {
    const title = (newSubtaskTitles[taskId] ?? "").trim();
    const validationError = validateSubtaskTitle(title);

    if (validationError) {
      setNewSubtaskErrors(prev => ({ ...prev, [taskId]: validationError }));
      return;
    }

    const newSubtask: SubTask = {
      id: createId(),
      title,
      completed: false,
    };

    setTasks(prev => prev.map(t =>
      t.id === taskId
        ? { ...t, subtasks: [...t.subtasks, newSubtask], isDecomposed: true }
        : t
    ));
    setNewSubtaskTitles(prev => ({ ...prev, [taskId]: "" }));
    setNewSubtaskErrors(prev => ({ ...prev, [taskId]: null }));
  };

  const deleteSubtask = (taskId: string, subtaskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    const subtaskIndex = task?.subtasks.findIndex(st => st.id === subtaskId) ?? -1;
    const deletedSubtask = task?.subtasks[subtaskIndex];

    if (!task || !deletedSubtask) return;

    showUndo({
      id: createId(),
      message: "Subtask deleted",
      restore: () => {
        setTasks(prev => prev.map(t => {
          if (t.id !== taskId || t.subtasks.some(st => st.id === deletedSubtask.id)) return t;

          const subtasks = [...t.subtasks];
          subtasks.splice(Math.min(subtaskIndex, subtasks.length), 0, deletedSubtask);

          return {
            ...t,
            subtasks,
            isDecomposed: true,
          };
        }));
      },
    });

    setTasks(prev => prev.map(t => {
      if (t.id !== taskId) return t;

      const subtasks = t.subtasks.filter(st => st.id !== subtaskId);
      return {
        ...t,
        subtasks,
        isDecomposed: subtasks.length > 0,
      };
    }));

    if (editingSubtask?.taskId === taskId && editingSubtask.subtaskId === subtaskId) {
      setEditingSubtask(null);
    }
  };

  const startEditingSubtask = (taskId: string, subtask: SubTask) => {
    setEditingSubtask({
      taskId,
      subtaskId: subtask.id,
      title: subtask.title,
      error: null,
    });
  };

  const cancelEditingSubtask = () => {
    setEditingSubtask(null);
  };

  const saveEditedSubtask = () => {
    if (!editingSubtask) return;

    const title = editingSubtask.title.trim();
    const validationError = validateSubtaskTitle(title);

    if (validationError) {
      setEditingSubtask({ ...editingSubtask, error: validationError });
      return;
    }

    setTasks(prev => prev.map(t => {
      if (t.id !== editingSubtask.taskId) return t;

      return {
        ...t,
        subtasks: t.subtasks.map(st =>
          st.id === editingSubtask.subtaskId ? { ...st, title } : st
        ),
      };
    }));
    setEditingSubtask(null);
  };

  const moveSubtask = (
    taskId: string,
    subtaskId: string,
    targetSubtaskId: string,
    placement: "before" | "after"
  ) => {
    if (subtaskId === targetSubtaskId) return;

    setTasks(prev => prev.map(t => {
      if (t.id !== taskId) return t;

      const fromIndex = t.subtasks.findIndex(st => st.id === subtaskId);
      const targetIndex = t.subtasks.findIndex(st => st.id === targetSubtaskId);

      if (fromIndex === -1 || targetIndex === -1) return t;

      const subtasks = [...t.subtasks];
      const [movedSubtask] = subtasks.splice(fromIndex, 1);
      const adjustedTargetIndex = subtasks.findIndex(st => st.id === targetSubtaskId);

      if (adjustedTargetIndex === -1) return t;

      subtasks.splice(
        placement === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex,
        0,
        movedSubtask
      );

      return { ...t, subtasks };
    }));
  };

  const moveSubtaskByStep = (taskId: string, subtaskId: string, direction: -1 | 1) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const subtaskIndex = task.subtasks.findIndex(st => st.id === subtaskId);
    const targetSubtask = task.subtasks[subtaskIndex + direction];

    if (!targetSubtask) return;

    moveSubtask(taskId, subtaskId, targetSubtask.id, direction < 0 ? "before" : "after");
  };

  const handleSubtaskDrop = (
    taskId: string,
    targetSubtaskId: string,
    event: React.DragEvent<HTMLDivElement>
  ) => {
    if (!draggedSubtask || draggedSubtask.taskId !== taskId) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const placement = event.clientY > bounds.top + bounds.height / 2 ? "after" : "before";

    moveSubtask(taskId, draggedSubtask.subtaskId, targetSubtaskId, placement);
    setDraggedSubtask(null);
  };

  const filteredTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return tasks.filter(t => {
      const matchesFilter = 
        filter === "all" ? true :
        filter === "active" ? !t.completed :
        t.completed;
      
      const matchesSearch = !query ||
        t.title.toLowerCase().includes(query) ||
        t.tags.some(tag => tag.toLowerCase().includes(query)) ||
        t.subtasks.some(subtask => subtask.title.toLowerCase().includes(query));
      
      return matchesFilter && matchesSearch;
    });
  }, [tasks, filter, searchQuery]);

  const stats = useMemo(() => ({
    total: tasks.length,
    completed: tasks.filter(t => t.completed).length,
    active: tasks.filter(t => !t.completed).length,
  }), [tasks]);

  return (
    <div className="min-h-screen flex flex-col font-sans selection:bg-primary selection:text-primary-foreground">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-border bg-background/80 backdrop-blur-md">
        <div className="container max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <a
            href="/"
            className="flex items-center gap-2 rounded-lg outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-primary/30"
            aria-label="Task.Airat.Top home"
          >
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold tracking-tight hidden sm:block">Task.Airat.Top</h1>
          </a>

          <div className="flex items-center gap-2">
            {tasks.length > 0 && (
              <button
                type="button"
                onClick={exportTasks}
                className="p-2 rounded-full hover:bg-muted transition-colors"
                title="Export Tasks"
                aria-label="Export tasks as JSON"
              >
                <Download className="w-5 h-5" />
              </button>
            )}
            <button 
              onClick={() =>
                setSettings((s) => ({
                  ...s,
                  theme: (s.theme === "system" ? resolvedTheme : s.theme) === "dark" ? "light" : "dark",
                }))
              }
              className="p-2 rounded-full hover:bg-muted transition-colors"
              title="Toggle Theme"
            >
              {resolvedTheme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <a 
              href="https://github.com/AiratTop/task.airat.top" 
              target="_blank" 
              rel="noreferrer"
              className="p-2 rounded-full hover:bg-muted transition-colors"
              title="GitHub Repository"
            >
              <Github className="w-5 h-5" />
            </a>
          </div>
        </div>
      </header>

      <main className="flex-1 container max-w-4xl mx-auto px-4 py-8">
        {/* Stats & Search */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="md:col-span-2 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input 
              type="text" 
              placeholder="Search tasks or tags..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-muted/50 border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
            />
          </div>
          <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border border-border rounded-xl text-sm">
            <span className="text-muted-foreground">Progress</span>
            <span className="font-medium">{stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0}%</span>
          </div>
        </div>

        {/* Input */}
        <form onSubmit={addTask} className="relative mb-8 group">
          <input 
            type="text" 
            placeholder="Add a new task... (AI will auto-tag it)" 
            value={newTaskTitle}
            onChange={(e) => {
              setNewTaskTitle(e.target.value);
              if (error) setError(null);
            }}
            className={cn(
              "w-full pl-4 pr-28 py-4 bg-card border-2 border-border rounded-2xl text-lg focus:outline-none focus:border-primary transition-all shadow-sm group-focus-within:shadow-md",
              error && "border-destructive focus:border-destructive"
            )}
          />
          {error && (
            <motion.p 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="absolute -bottom-6 left-4 text-[10px] font-bold text-destructive uppercase tracking-wider"
            >
              {error}
            </motion.p>
          )}
          <button
            type="button"
            onClick={handleVoiceInput}
            className={cn(
              "absolute right-14 top-1/2 -translate-y-1/2 p-2 rounded-xl transition-all hover:scale-105 active:scale-95",
              isListening
                ? "bg-destructive text-destructive-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            )}
            title={isListening ? "Stop voice input" : "Voice input"}
            aria-label={isListening ? "Stop voice input" : "Start voice input"}
          >
            {isListening ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
          </button>
          <button 
            type="submit"
            disabled={!newTaskTitle.trim()}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-primary text-primary-foreground rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:scale-105 active:scale-95"
          >
            <Plus className="w-6 h-6" />
          </button>
        </form>

        {/* Filters */}
        <div className="flex items-center justify-between mb-6 gap-4">
          <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide flex-1">
            {(["all", "active", "completed"] as FilterType[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "px-4 py-1.5 rounded-full text-sm font-medium transition-all whitespace-nowrap",
                  filter === f 
                    ? "bg-primary text-primary-foreground shadow-sm" 
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
                <span className="ml-2 opacity-60">
                  {f === "all" ? stats.total : f === "active" ? stats.active : stats.completed}
                </span>
              </button>
            ))}
          </div>
          {stats.completed > 0 && (
            <button 
              onClick={clearCompleted}
              className="group flex items-center p-2 text-destructive hover:bg-destructive/10 rounded-full transition-all shrink-0"
              title="Clear Completed"
            >
              <Trash2 className="w-4.5 h-4.5" />
              <span className="overflow-hidden whitespace-nowrap text-xs font-medium transition-all duration-300 max-w-0 opacity-0 group-hover:max-w-[120px] group-hover:opacity-100 group-hover:ml-2">
                Clear Completed
              </span>
            </button>
          )}
        </div>

        {/* Task List */}
        <div className="space-y-4">
          <AnimatePresence mode="popLayout">
            {filteredTasks.map((task, index) => (
              <motion.div
                key={task.id}
                layout
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                onDragOver={(event) => {
                  if (draggedTaskId && draggedTaskId !== task.id) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  handleTaskDrop(task.id, event);
                }}
                onDragEnd={() => setDraggedTaskId(null)}
                className={cn(
                  "task-card group relative",
                  draggedTaskId === task.id && "opacity-40",
                  draggedTaskId && draggedTaskId !== task.id && "ring-1 ring-primary/20",
                  task.completed && "opacity-60"
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex flex-col items-center gap-1 text-muted-foreground">
                    <button
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        setDraggedTaskId(task.id);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", task.id);
                      }}
                      className="cursor-grab rounded-md p-1 transition-colors hover:bg-muted active:cursor-grabbing"
                      title="Drag to reorder"
                      aria-label="Drag to reorder"
                    >
                      <GripVertical className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveTaskByVisibleStep(task.id, -1)}
                      disabled={index === 0}
                      className="rounded-md p-1 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                      title="Move up"
                      aria-label="Move task up"
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveTaskByVisibleStep(task.id, 1)}
                      disabled={index === filteredTasks.length - 1}
                      className="rounded-md p-1 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                      title="Move down"
                      aria-label="Move task down"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>
                  <button 
                    onClick={() => toggleTask(task.id)}
                    className="mt-1 text-primary transition-transform hover:scale-110 active:scale-90"
                  >
                    {task.completed ? (
                      <CheckCircle2 className="w-6 h-6 fill-primary text-primary-foreground" />
                    ) : (
                      <Circle className="w-6 h-6" />
                    )}
                  </button>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      {editingTaskId === task.id ? (
                        <div className="flex-1 min-w-0">
                          <input
                            type="text"
                            autoFocus
                            value={editingTaskTitle}
                            onChange={(event) => {
                              setEditingTaskTitle(event.target.value);
                              if (editingTaskError) setEditingTaskError(null);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void saveEditedTask();
                              }

                              if (event.key === "Escape") {
                                cancelEditingTask();
                              }
                            }}
                            className={cn(
                              "w-full rounded-lg border bg-background px-3 py-1.5 text-lg font-medium leading-tight outline-none transition-all focus:ring-2 focus:ring-primary/20",
                              editingTaskError ? "border-destructive" : "border-border focus:border-primary"
                            )}
                          />
                          {editingTaskError && (
                            <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-destructive">
                              {editingTaskError}
                            </p>
                          )}
                        </div>
                      ) : (
                        <h3 className={cn(
                          "text-lg font-medium leading-tight break-words",
                          task.completed && "line-through text-muted-foreground"
                        )}>
                          {task.title}
                        </h3>
                      )}
                      <div className={cn(
                        "flex items-center gap-1 transition-opacity",
                        editingTaskId === task.id ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover:opacity-100"
                      )}>
                        {editingTaskId === task.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void saveEditedTask()}
                              className="p-1.5 rounded-lg hover:bg-primary/10 text-primary"
                              title="Save Task"
                              aria-label="Save task"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={cancelEditingTask}
                              className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"
                              title="Cancel Editing"
                              aria-label="Cancel editing"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </>
                        ) : (
                          <>
                            {!task.isDecomposed && !task.completed && (
                              <button 
                                onClick={() => handleDecompose(task.id)}
                                disabled={task.isDecomposing}
                                className="p-1.5 rounded-lg hover:bg-muted text-primary"
                                title="AI Decomposition"
                              >
                                {task.isDecomposing ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Split className="w-4 h-4" />
                                )}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => startEditingTask(task)}
                              className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"
                              title="Edit Task"
                              aria-label="Edit task"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button 
                              onClick={() => deleteTask(task.id)}
                              className="p-1.5 rounded-lg hover:bg-destructive/10 text-destructive"
                              title="Delete Task"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Priority */}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1">
                        <Flag className={cn(
                          "ml-1 w-3.5 h-3.5",
                          TASK_PRIORITIES.find(priority => priority.value === getTaskPriority(task))?.className
                        )} />
                        {TASK_PRIORITIES.map(priority => {
                          const isActive = getTaskPriority(task) === priority.value;

                          return (
                            <button
                              key={priority.value}
                              type="button"
                              onClick={() => updateTaskPriority(task.id, priority.value)}
                              className={cn(
                                "rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-wider transition-colors",
                                isActive
                                  ? "bg-background text-foreground shadow-sm"
                                  : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
                              )}
                              aria-pressed={isActive}
                            >
                              {priority.label}
                            </button>
                          );
                        })}
                      </div>
                      <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2 py-1">
                        <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                        <input
                          type="date"
                          value={task.dueDate ?? ""}
                          onChange={(event) => updateTaskDueDate(task.id, event.target.value)}
                          className="h-7 bg-transparent text-xs font-medium text-foreground outline-none [color-scheme:light] dark:[color-scheme:dark]"
                          title="Due date"
                          aria-label="Due date"
                        />
                        {task.dueDate && (
                          <>
                            {(() => {
                              const dueStatus = getDueDateStatus(task);

                              return dueStatus ? (
                                <span className={cn(
                                  "rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                                  dueStatus.className
                                )}>
                                  {dueStatus.label}
                                </span>
                              ) : null;
                            })()}
                            <button
                              type="button"
                              onClick={() => updateTaskDueDate(task.id, "")}
                              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                              title="Clear due date"
                              aria-label="Clear due date"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Tags */}
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      {task.isGeneratingTags && (
                        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-muted-foreground animate-pulse">
                          <Sparkles className="w-3 h-3" />
                          Analyzing...
                        </div>
                      )}
                      {task.tags.map(tag => (
                        <span 
                          key={tag} 
                          className="px-2 py-0.5 bg-secondary text-secondary-foreground text-xs rounded-md font-medium border border-border/50"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>

                    {/* Subtasks */}
                    <div className="mt-4 space-y-2 pl-2 border-l-2 border-muted">
                      {task.subtasks.length > 0 && (
                        <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-2">
                          <Split className="w-3 h-3" />
                          Subtasks
                        </div>
                      )}
                      {task.subtasks.map((st, subtaskIndex) => {
                        const isEditingSubtask =
                          editingSubtask?.taskId === task.id && editingSubtask.subtaskId === st.id;

                        return (
                          <div
                            key={st.id}
                            onDragOver={(event) => {
                              if (
                                draggedSubtask &&
                                draggedSubtask.taskId === task.id &&
                                draggedSubtask.subtaskId !== st.id
                              ) {
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                              }
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              handleSubtaskDrop(task.id, st.id, event);
                            }}
                            onDragEnd={() => setDraggedSubtask(null)}
                            className={cn(
                              "flex items-start gap-2 rounded-lg py-1 group/st",
                              draggedSubtask?.taskId === task.id &&
                                draggedSubtask.subtaskId === st.id &&
                                "opacity-40",
                              draggedSubtask?.taskId === task.id &&
                                draggedSubtask.subtaskId !== st.id &&
                                "ring-1 ring-primary/20"
                            )}
                          >
                            <div className="flex items-center gap-0.5 text-muted-foreground">
                              <button
                                type="button"
                                draggable
                                onDragStart={(event) => {
                                  setDraggedSubtask({ taskId: task.id, subtaskId: st.id });
                                  event.dataTransfer.effectAllowed = "move";
                                  event.dataTransfer.setData("text/plain", st.id);
                                }}
                                className="cursor-grab rounded p-0.5 transition-colors hover:bg-muted active:cursor-grabbing"
                                title="Drag to reorder subtask"
                                aria-label="Drag to reorder subtask"
                              >
                                <GripVertical className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveSubtaskByStep(task.id, st.id, -1)}
                                disabled={subtaskIndex === 0}
                                className="rounded p-0.5 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                                title="Move subtask up"
                                aria-label="Move subtask up"
                              >
                                <ChevronUp className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveSubtaskByStep(task.id, st.id, 1)}
                                disabled={subtaskIndex === task.subtasks.length - 1}
                                className="rounded p-0.5 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                                title="Move subtask down"
                                aria-label="Move subtask down"
                              >
                                <ChevronDown className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            <button 
                              onClick={() => toggleSubtask(task.id, st.id)}
                              className="mt-0.5 text-muted-foreground hover:text-primary transition-colors"
                            >
                              {st.completed ? (
                                <CheckCircle2 className="w-4 h-4 text-primary" />
                              ) : (
                                <Circle className="w-4 h-4" />
                              )}
                            </button>
                            <div className="flex-1 min-w-0">
                              {isEditingSubtask ? (
                                <>
                                  <input
                                    type="text"
                                    autoFocus
                                    value={editingSubtask.title}
                                    onChange={(event) =>
                                      setEditingSubtask({
                                        ...editingSubtask,
                                        title: event.target.value,
                                        error: null,
                                      })
                                    }
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        saveEditedSubtask();
                                      }

                                      if (event.key === "Escape") {
                                        cancelEditingSubtask();
                                      }
                                    }}
                                    className={cn(
                                      "w-full rounded-md border bg-background px-2 py-1 text-sm outline-none transition-all focus:ring-2 focus:ring-primary/20",
                                      editingSubtask.error
                                        ? "border-destructive"
                                        : "border-border focus:border-primary"
                                    )}
                                  />
                                  {editingSubtask.error && (
                                    <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-destructive">
                                      {editingSubtask.error}
                                    </p>
                                  )}
                                </>
                              ) : (
                                <span className={cn(
                                  "text-sm leading-6 break-words",
                                  st.completed && "line-through text-muted-foreground"
                                )}>
                                  {st.title}
                                </span>
                              )}
                            </div>
                            <div className={cn(
                              "flex items-center gap-0.5 transition-opacity",
                              isEditingSubtask ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover/st:opacity-100"
                            )}>
                              {isEditingSubtask ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={saveEditedSubtask}
                                    className="rounded p-1 text-primary transition-colors hover:bg-primary/10"
                                    title="Save subtask"
                                    aria-label="Save subtask"
                                  >
                                    <Check className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={cancelEditingSubtask}
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted"
                                    title="Cancel editing"
                                    aria-label="Cancel editing"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => startEditingSubtask(task.id, st)}
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted"
                                    title="Edit subtask"
                                    aria-label="Edit subtask"
                                  >
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => deleteSubtask(task.id, st.id)}
                                    className="rounded p-1 text-destructive transition-colors hover:bg-destructive/10"
                                    title="Delete subtask"
                                    aria-label="Delete subtask"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      <div>
                        <div className="flex items-center gap-2 pt-1">
                          <input
                            type="text"
                            value={newSubtaskTitles[task.id] ?? ""}
                            onChange={(event) => {
                              setNewSubtaskTitles(prev => ({ ...prev, [task.id]: event.target.value }));
                              if (newSubtaskErrors[task.id]) {
                                setNewSubtaskErrors(prev => ({ ...prev, [task.id]: null }));
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                addSubtask(task.id);
                              }
                            }}
                            placeholder="Add subtask..."
                            className={cn(
                              "min-w-0 flex-1 rounded-lg border bg-background px-3 py-1.5 text-sm outline-none transition-all focus:ring-2 focus:ring-primary/20",
                              newSubtaskErrors[task.id]
                                ? "border-destructive"
                                : "border-border focus:border-primary"
                            )}
                          />
                          <button
                            type="button"
                            onClick={() => addSubtask(task.id)}
                            disabled={!(newSubtaskTitles[task.id] ?? "").trim()}
                            className="rounded-lg bg-muted p-1.5 text-muted-foreground transition-all hover:bg-primary hover:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
                            title="Add subtask"
                            aria-label="Add subtask"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                        </div>
                        {newSubtaskErrors[task.id] && (
                          <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-destructive">
                            {newSubtaskErrors[task.id]}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-border/50 flex items-center justify-between text-[10px] text-muted-foreground font-mono">
                  <div className="flex items-center gap-3">
                    <span>Created {format(task.createdAt, "MMM d, HH:mm")}</span>
                    {task.completed && task.completedAt && (
                      <span className="flex items-center gap-1 text-primary">
                        <CheckCircle2 className="w-2.5 h-2.5" />
                        Done {format(task.completedAt, "MMM d, HH:mm")}
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {filteredTasks.length === 0 && (
            <div className="py-20 text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
                <Filter className="w-8 h-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium">No tasks found</h3>
              <p className="text-muted-foreground">Try changing your filter or adding a new task.</p>
            </div>
          )}
        </div>
      </main>

      <AnimatePresence>
        {undoAction && (
          <motion.div
            key={undoAction.id}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="fixed bottom-4 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3 text-sm shadow-lg"
          >
            <span className="font-medium">{undoAction.message}</span>
            <button
              type="button"
              onClick={handleUndo}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Undo
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="border-t border-border bg-muted/20 py-16">
        <div className="container max-w-4xl mx-auto px-4">
          <div className="flex flex-col items-center text-center">
            <div className="flex items-center gap-2 mb-6">
              <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center border border-primary/20">
                <CheckCircle2 className="w-5 h-5 text-primary" />
              </div>
              <span className="text-xl font-bold tracking-tight">Task.Airat.Top</span>
            </div>
            
            <p className="text-sm text-muted-foreground max-w-md mb-10 leading-relaxed">
              A smart, privacy-first task manager designed for personal productivity. 
              Powered by Gemini AI for intelligent tagging and decomposition.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-xs font-medium uppercase tracking-widest text-muted-foreground/60 mb-10">
              <a href="https://airat.top" className="hover:text-primary transition-colors" target="_blank" rel="author">Airat.Top</a>
              <a href="https://github.com/AiratTop/task.airat.top" className="hover:text-primary transition-colors" target="_blank" rel="noreferrer">GitHub</a>
              <a href="https://privacy.airat.top" className="hover:text-primary transition-colors" target="_blank" rel="noreferrer privacy-policy">Privacy</a>
              <a href="https://terms.airat.top" className="hover:text-primary transition-colors" target="_blank" rel="noreferrer terms-of-service">Terms</a>
            </div>

            <div className="w-full max-w-xs h-px bg-gradient-to-r from-transparent via-border to-transparent mb-8" />

            <p className="text-xs text-muted-foreground/50 font-mono">
              © 2026 <a href="https://airat.top" className="hover:text-primary transition-colors underline underline-offset-4 decoration-border/50" target="_blank" rel="author">Airat.Top</a>
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
