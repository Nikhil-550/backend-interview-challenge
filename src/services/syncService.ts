import axios from 'axios';
import {
  Task,
  SyncQueueItem,
  SyncResult,
  BatchSyncRequest,
  BatchSyncResponse,
} from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';

export class SyncService {
  private apiUrl: string;

  constructor(
    private db: Database,
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
  }

  async sync(): Promise<SyncResult> {
    const online = await this.checkConnectivity();
    if (!online) {
      return { success: false, synced_items: 0, failed_items: 0, errors: [] };
    }

    const batchSize = Number(process.env.SYNC_BATCH_SIZE ?? 50);

    const rawItems = await this.db.all(`SELECT * FROM sync_queue ORDER BY created_at LIMIT ?`, [batchSize]);
    if (!rawItems.length) {
      return { success: true, synced_items: 0, failed_items: 0, errors: [] };
    }

    const items: SyncQueueItem[] = rawItems.map((r: any) => ({
      id: r.id,
      task_id: r.task_id,
      operation: r.operation,
      data: JSON.parse(r.data),
      created_at: new Date(r.created_at),
      retry_count: r.retry_count ?? 0,
      error_message: r.error_message ?? undefined,
    }));

    let response: BatchSyncResponse;
    try {
      response = await this.processBatch(items);
    } catch (err: any) {
      for (const item of items) {
        await this.handleSyncError(item, err);
      }
      return {
        success: false,
        synced_items: 0,
        failed_items: items.length,
        errors: items.map(i => ({
          task_id: i.task_id,
          operation: i.operation,
          error: err.message || 'batch error',
          timestamp: new Date(),
        })),
      };
    }

    let synced = 0;
    let failed = 0;
    const errors: { task_id: string; operation: string; error: string; timestamp: Date }[] = [];

    for (const processed of response.processed_items) {
      const item = items.find(i => i.id === processed.client_id);
      if (!item) continue;

      if (processed.status === 'success') {
        await this.updateSyncStatus(item.task_id, 'synced', { server_id: processed.server_id });
        await this.db.run(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
        synced++;
      } else if (processed.status === 'conflict') {
        const local = await this.taskService.getTask(item.task_id);
        if (local && processed.resolved_data) {
          const winner = await this.resolveConflict(local, processed.resolved_data);
          await this.db.run(
            `UPDATE tasks SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = 'synced', server_id = ? WHERE id = ?`,
            [
              winner.title,
              winner.description ?? null,
              winner.completed ? 1 : 0,
              new Date(winner.updated_at).toISOString(),
              processed.server_id ?? null,
              local.id,
            ]
          );
          await this.db.run(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
          synced++;
        } else {
          await this.handleSyncError(item, new Error('Conflict unresolved'));
          failed++;
          errors.push({ task_id: item.task_id, operation: item.operation, error: 'Conflict unresolved', timestamp: new Date() });
        }
      } else {
        await this.handleSyncError(item, new Error(processed.error || 'sync error'));
        failed++;
        errors.push({ task_id: item.task_id, operation: item.operation, error: processed.error || 'sync error', timestamp: new Date() });
      }
    }

    return { success: failed === 0, synced_items: synced, failed_items: failed, errors };
  }

  async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, retry_count, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
      [taskId, taskId, operation, JSON.stringify(data), new Date().toISOString()]
    );
  }

  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    const payload: BatchSyncRequest = { items, client_timestamp: new Date() };
    const { data } = await axios.post<BatchSyncResponse>(`${this.apiUrl}/batch`, payload);
    return data;
  }

  private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
    const localTime = new Date(localTask.updated_at).getTime();
    const serverTime = new Date(serverTask.updated_at).getTime();
    return serverTime > localTime ? serverTask : localTask;
  }

  private async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE tasks SET sync_status = ?, last_synced_at = ?, server_id = COALESCE(?, server_id) WHERE id = ?`,
      [status, now, serverData?.server_id ?? null, taskId]
    );
  }

  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    await this.db.run(
      `UPDATE sync_queue SET retry_count = retry_count + 1, error_message = ? WHERE id = ?`,
      [error.message, item.id]
    );
    await this.updateSyncStatus(item.task_id, 'error');
  }

  async checkConnectivity(): Promise<boolean> {
    try {
      await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
