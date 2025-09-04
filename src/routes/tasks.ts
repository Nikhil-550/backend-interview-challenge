import { Router } from "express";
import { Database } from "../db/database";
import { TaskService } from "../services/taskService";
import { SyncService } from "../services/syncService";

const router = Router();
const db = new Database();

let taskService: TaskService;
let syncService: SyncService;

syncService = new SyncService(db, {} as TaskService); // placeholder
taskService = new TaskService(db, syncService);
(syncService as any).taskService = taskService;

// Example GET route
router.get("/", async (_req, res) => {
  try {
    const tasks = await taskService.getAllTasks();
    return res.json(tasks);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// Example POST route
router.post("/", async (req, res) => {
  try {
    const newTask = await taskService.createTask(req.body);
    return res.status(201).json(newTask);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
