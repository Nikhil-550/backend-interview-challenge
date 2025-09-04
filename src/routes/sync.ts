import { Router } from "express";
import { Database } from "../db/database";
import { TaskService } from "../services/taskService";
import { SyncService } from "../services/syncService";

const router = Router();

// Step 1: Create database
const db = new Database();

// Step 2: Create placeholders
let taskService: TaskService;
let syncService: SyncService;

// Step 3: Instantiate with circular dependency
syncService = new SyncService(db, {} as TaskService); // temp placeholder
taskService = new TaskService(db, syncService);
// now replace placeholder with the real one
(syncService as any).taskService = taskService;

// Example route
router.post("/batch", async (_req, res) => {
  try {
    const result = await syncService.sync();
    return res.json(result); // ✅ ensures return in all code paths
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
