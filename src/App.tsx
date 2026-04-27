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
  ChevronDown, 
  ChevronUp,
  Search,
  Filter,
  MoreVertical,
  X,
  Loader2
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { format } from "date-fns";
import { cn } from "./lib/utils";
import { Task, SubTask, FilterType, AppSettings } from "./types";
import { analyzeTask, decomposeTask } from "./services/gemini";

const STORAGE_KEY = "airat_tasks_v1";
const SETTINGS_KEY = "airat_settings_v1";

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
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Load data
  useEffect(() => {
    const savedTasks = localStorage.getItem(STORAGE_KEY);
    const savedSettings = localStorage.getItem(SETTINGS_KEY);
    
    if (savedTasks) setTasks(JSON.parse(savedTasks));
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
    setTasks(prev => prev.filter(t => !t.completed));
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
      id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' 
        ? crypto.randomUUID() 
        : Math.random().toString(36).substring(2, 11),
      title: title,
      completed: false,
      createdAt: Date.now(),
      tags: [],
      subtasks: [],
      isDecomposed: false,
      isGeneratingTags: true,
      isDecomposing: false,
    };

    setTasks(prev => [newTask, ...prev]);
    setNewTaskTitle("");

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

  const deleteTask = (id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id));
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
        id: crypto.randomUUID(),
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

  const filteredTasks = useMemo(() => {
    return tasks.filter(t => {
      const matchesFilter = 
        filter === "all" ? true :
        filter === "active" ? !t.completed :
        t.completed;
      
      const matchesSearch = t.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.tags.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));
      
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
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold tracking-tight hidden sm:block">Task.Airat.Top</h1>
          </div>

          <div className="flex items-center gap-2">
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
            {filteredTasks.map((task) => (
              <motion.div
                key={task.id}
                layout
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className={cn(
                  "task-card group relative",
                  task.completed && "opacity-60"
                )}
              >
                <div className="flex items-start gap-3">
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
                      <h3 className={cn(
                        "text-lg font-medium leading-tight break-words",
                        task.completed && "line-through text-muted-foreground"
                      )}>
                        {task.title}
                      </h3>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
                          onClick={() => deleteTask(task.id)}
                          className="p-1.5 rounded-lg hover:bg-destructive/10 text-destructive"
                          title="Delete Task"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
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
                    {task.subtasks.length > 0 && (
                      <div className="mt-4 space-y-2 pl-2 border-l-2 border-muted">
                        <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-2">
                          <Split className="w-3 h-3" />
                          Subtasks
                        </div>
                        {task.subtasks.map(st => (
                          <div key={st.id} className="flex items-center gap-2 group/st">
                            <button 
                              onClick={() => toggleSubtask(task.id, st.id)}
                              className="text-muted-foreground hover:text-primary transition-colors"
                            >
                              {st.completed ? (
                                <CheckCircle2 className="w-4 h-4 text-primary" />
                              ) : (
                                <Circle className="w-4 h-4" />
                              )}
                            </button>
                            <span className={cn(
                              "text-sm",
                              st.completed && "line-through text-muted-foreground"
                            )}>
                              {st.title}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
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
              <a href="https://status.airat.top" className="hover:text-primary transition-colors" target="_blank" rel="noreferrer">Status</a>
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
