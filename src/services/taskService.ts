import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';
import { SyncService } from './syncService';

export class TaskService {
  constructor(private db: Database, private syncService: SyncService) {}

  private rowToTask(row: any): Task {
    // Convert DB row fields (strings/ints) to Task object (with Date fields)
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      completed: !!row.completed,
      is_deleted: !!row.is_deleted,
      created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
      sync_status: row.sync_status,
      server_id: row.server_id ?? null,
    } as Task;
  }

  async createTask(taskData: Partial<Task>): Promise<Task> {
    const now = new Date();
    const task: Task = {
      id: uuidv4(),
      title: taskData.title ?? '',
      description: taskData.description ?? '',
      completed: taskData.completed ?? false,
      is_deleted: false,
      created_at: now,
      updated_at: now,
      sync_status: 'pending',
      server_id: (taskData.server_id as any) ?? null,
    } as Task;

    await this.db.run(
      `INSERT INTO tasks (id, title, description, completed, is_deleted, created_at, updated_at, sync_status, server_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.title,
        task.description,
        task.completed ? 1 : 0,
        task.is_deleted ? 1 : 0,
        task.created_at.toISOString(),
        task.updated_at.toISOString(),
        task.sync_status,
        task.server_id,
      ]
    );

    // queue for sync
    await this.syncService.addToSyncQueue(task.id, 'create', {
      id: task.id,
      title: task.title,
      description: task.description,
      completed: task.completed,
      updated_at: task.updated_at,
      created_at: task.created_at,
      is_deleted: task.is_deleted,
      server_id: task.server_id ?? undefined,
    });

    return task;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existingRow = await this.db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
    if (!existingRow) return null;

    const existing = this.rowToTask(existingRow);

    const now = new Date();
    const updated: Task = {
      ...existing,
      ...updates,
      updated_at: now,
      sync_status: 'pending',
    } as Task;

    await this.db.run(
      `UPDATE tasks SET title = ?, description = ?, completed = ?, is_deleted = ?, updated_at = ?, sync_status = ?, server_id = ? WHERE id = ?`,
      [
        updated.title,
        updated.description,
        updated.completed ? 1 : 0,
        updated.is_deleted ? 1 : 0,
        updated.updated_at.toISOString(),
        updated.sync_status,
        updated.server_id ?? null,
        id,
      ]
    );

    await this.syncService.addToSyncQueue(id, 'update', {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      completed: updated.completed,
      updated_at: updated.updated_at,
      created_at: updated.created_at,
      is_deleted: updated.is_deleted,
      server_id: updated.server_id ?? undefined,
    });

    return updated;
  }

  async deleteTask(id: string): Promise<boolean> {
    const existingRow = await this.db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
    if (!existingRow) return false;

    const existing = this.rowToTask(existingRow);
    const now = new Date();

    await this.db.run(
      `UPDATE tasks SET is_deleted = 1, updated_at = ?, sync_status = ? WHERE id = ?`,
      [now.toISOString(), 'pending', id]
    );

    await this.syncService.addToSyncQueue(id, 'delete', {
      id: existing.id,
      title: existing.title,
      description: existing.description,
      completed: existing.completed,
      updated_at: now,
      created_at: existing.created_at,
      is_deleted: true,
      server_id: existing.server_id ?? undefined,
    });

    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    const row = await this.db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
    if (!row) return null;
    const t = this.rowToTask(row);
    if (t.is_deleted) return null;
    return t;
  }

  async getAllTasks(): Promise<Task[]> {
    const rows = await this.db.all(`SELECT * FROM tasks WHERE is_deleted = 0`);
    return (rows || []).map((r: any) => this.rowToTask(r));
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    const rows = await this.db.all(`SELECT * FROM tasks WHERE sync_status IN ('pending','error')`);
    return (rows || []).map((r: any) => this.rowToTask(r));
  }
}
