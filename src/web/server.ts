import express, { type Express, type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type { MemoryManager } from '../memory/manager.js';
import type { SyncWebSocketServer } from '../sync/websocket.js';
import type { Category, Priority, Status } from '../memory/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class WebServer {
  private app: Express;
  private memoryManager: MemoryManager;
  private wsServer: SyncWebSocketServer | null;

  constructor(memoryManager: MemoryManager, wsServer: SyncWebSocketServer | null = null) {
    this.app = express();
    this.memoryManager = memoryManager;
    this.wsServer = wsServer;

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));
  }

  private setupRoutes(): void {
    // API: Получить все записи
    this.app.get('/api/memory', async (req: Request, res: Response) => {
      try {
        const category = req.query.category as Category | 'all' | undefined;
        const search = req.query.search as string | undefined;
        const status = req.query.status as Status | undefined;
        const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;

        const entries = await this.memoryManager.read({
          category: category || 'all',
          search,
          status,
          limit
        });

        res.json({ success: true, entries });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // API: Получить статистику
    this.app.get('/api/stats', async (_req: Request, res: Response) => {
      try {
        const stats = await this.memoryManager.getStats();

        // Добавляем информацию о подключенных агентах
        if (this.wsServer) {
          stats.connectedAgents = this.wsServer.getConnectedCount();
        }

        res.json({ success: true, stats });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // API: Получить подключенных агентов
    this.app.get('/api/agents', (_req: Request, res: Response) => {
      try {
        const agents = this.wsServer?.getConnectedClientsInfo() || [];
        res.json({ success: true, agents });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // API: Добавить запись
    this.app.post('/api/memory', async (req: Request, res: Response) => {
      try {
        const { category, title, content, tags, priority, author } = req.body;

        if (!category || !title || !content) {
          res.status(400).json({
            success: false,
            error: 'Missing required fields: category, title, content'
          });
          return;
        }

        const entry = await this.memoryManager.write({
          category: category as Category,
          title,
          content,
          tags: tags || [],
          priority: (priority as Priority) || 'medium',
          author: author || 'web-ui'
        });

        res.json({ success: true, entry });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // API: Обновить запись
    this.app.put('/api/memory/:id', async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { title, content, status, tags, priority } = req.body;

        const updated = await this.memoryManager.update({
          id,
          title,
          content,
          status: status as Status | undefined,
          tags,
          priority: priority as Priority | undefined
        });

        if (!updated) {
          res.status(404).json({
            success: false,
            error: 'Entry not found'
          });
          return;
        }

        res.json({ success: true, entry: updated });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // API: Удалить/архивировать запись
    this.app.delete('/api/memory/:id', async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const archive = req.query.archive !== 'false';

        const success = await this.memoryManager.delete({ id, archive });

        if (!success) {
          res.status(404).json({
            success: false,
            error: 'Entry not found'
          });
          return;
        }

        res.json({ success: true, archived: archive });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // API: Закрепить/открепить запись
    this.app.post('/api/memory/:id/pin', async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { pinned } = req.body;

        const updated = await this.memoryManager.pin(id, pinned !== false);

        if (!updated) {
          res.status(404).json({
            success: false,
            error: 'Entry not found'
          });
          return;
        }

        res.json({ success: true, entry: updated });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // API: Создать бэкап
    this.app.post('/api/backup', async (_req: Request, res: Response) => {
      try {
        const backupPath = await this.memoryManager.createBackup();
        res.json({ success: true, backupPath });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Главная страница
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
  }

  start(port: number): void {
    this.app.listen(port, '0.0.0.0', () => {
      console.error(`Web UI available at http://localhost:${port}`);
    });
  }
}
