/**
 * CiviFix AI - Internal Python ML Service Supervisor
 * Phase 7: Manages the lifecycle of the internal Flask microservice (port 5001).
 *
 * Guarantees:
 * 1. Spawns Python using .venv virtual environment if present, falling back to system python3.
 * 2. Enforces loopback binding (127.0.0.1:5001) for internal proxy communication only.
 * 3. Bounded restarts (max 3) with backoff; never crashes or blocks Express if Python fails.
 * 4. Graceful shutdown on SIGTERM / SIGINT, killing child process safely.
 * 5. Sanitized health reporting for GET /api/health (zero credentials or internal traces leaked).
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

export interface MLSupervisorStatus {
  isConfigured: boolean;
  isRunning: boolean;
  isHealthy: boolean;
  pid: number | null;
  restarts: number;
  pythonBin: string | null;
  port: number;
  modelLoaded?: boolean;
  opencvAvailable?: boolean;
  opencvVersion?: string;
}

const ML_PORT = 5001;
const MAX_RESTARTS = 3;
const STARTUP_TIMEOUT_MS = 6000;

class MLSupervisor {
  private childProcess: ChildProcess | null = null;
  private restarts = 0;
  private isShuttingDown = false;
  private isHealthy = false;
  private pythonBin: string | null = null;
  private appPath: string = '';
  private signalHandlersRegistered = false;

  constructor() {
    this.appPath = path.resolve(process.cwd(), 'ml/app.py');
    this.pythonBin = this.resolvePythonBinary();
  }

  /**
   * Checks whether a candidate Python binary can import Flask.
   */
  private hasFlask(binPath: string): boolean {
    try {
      const res = spawnSync(binPath, ['-c', 'import flask'], {
        timeout: 2000,
        stdio: 'ignore',
      });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Resolves Python binary, prioritizing .venv virtual environment that has Flask installed.
   */
  private resolvePythonBinary(): string | null {
    const candidatePaths = [
      path.resolve(process.cwd(), '.venv/bin/python3'),
      path.resolve(process.cwd(), '.venv/bin/python'),
      path.resolve(process.cwd(), 'ml/.venv/bin/python3'),
      path.resolve(process.cwd(), '.venv/Scripts/python.exe'),
      path.resolve(process.cwd(), 'ml/.venv/Scripts/python.exe'),
      process.env.PYTHON_BIN,
      'python3',
      'python',
      'py',
    ].filter(Boolean) as string[];

    for (const p of candidatePaths) {
      if (p.startsWith('/') && fs.existsSync(p)) {
        if (this.hasFlask(p)) {
          return p;
        }
      } else if (!p.startsWith('/')) {
        if (this.hasFlask(p)) {
          return p;
        }
      }
    }
    return null;
  }

  /**
   * Fast health-check against loopback port 5001.
   */
  public async checkHealth(): Promise<{ healthy: boolean; data?: any }> {
    try {
      const res = await fetch(`http://127.0.0.1:${ML_PORT}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        const data = await res.json();
        this.isHealthy = true;
        return { healthy: true, data };
      }
    } catch {
      // Unreachable or offline
    }
    this.isHealthy = false;
    return { healthy: false };
  }

  /**
   * Starts the internal Python Flask microservice.
   */
  public async start(): Promise<void> {
    if (this.childProcess && !this.childProcess.killed) {
      return;
    }

    // Check if another instance is already running on port 5001
    const initialHealth = await this.checkHealth();
    if (initialHealth.healthy) {
      console.log(`[Python-ML] Existing service detected on http://127.0.0.1:${ML_PORT} (healthy).`);
      this.isHealthy = true;
      return;
    }

    if (!fs.existsSync(this.appPath)) {
      console.warn(`[Python-ML] ml/app.py not found at ${this.appPath}. Operating in standalone mode.`);
      return;
    }

    this.registerSignalHandlers();
    this.spawnService();
  }

  private spawnService(): void {
    if (this.isShuttingDown) return;

    this.pythonBin = this.resolvePythonBinary();
    if (!this.pythonBin) {
      console.warn('[Python-ML] No Python environment with Flask installed found. Operating in standalone mode with TypeScript fallbacks.');
      this.isHealthy = false;
      return;
    }
    const bin = this.pythonBin;
    console.log(`[Python-ML] Spawning internal ML service (${bin} ml/app.py)...`);

    try {
      this.childProcess = spawn(bin, [this.appPath], {
        env: {
          ...process.env,
          ML_PORT: String(ML_PORT),
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const pid = this.childProcess.pid;
      console.log(`[Python-ML] Process spawned with PID ${pid}.`);

      this.childProcess.stdout?.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
          console.log(`[Python-ML] ${text}`);
        }
      });

      this.childProcess.stderr?.on('data', (chunk) => {
        const text = chunk.toString().trim();
        // Flask dev server prints startup notices to stderr; log as info/debug
        if (text) {
          console.info(`[Python-ML] ${text}`);
        }
      });

      this.childProcess.on('exit', (code, signal) => {
        console.warn(`[Python-ML] Process exited with code ${code}, signal ${signal}.`);
        this.isHealthy = false;
        this.childProcess = null;

        if (this.isShuttingDown) {
          return;
        }

        if (this.restarts < MAX_RESTARTS) {
          this.restarts++;
          const delay = this.restarts * 2000;
          console.warn(`[Python-ML] Scheduling restart attempt ${this.restarts}/${MAX_RESTARTS} in ${delay}ms...`);
          setTimeout(() => this.spawnService(), delay);
        } else {
          console.warn(
            `[Python-ML] Reached maximum restart attempts (${MAX_RESTARTS}). Running in standalone mode with Gemini and heuristic fallbacks.`
          );
        }
      });

      this.childProcess.on('error', (err) => {
        console.warn(`[Python-ML] Spawn error: ${err.message}. Operating in standalone mode.`);
        this.childProcess = null;
        this.isHealthy = false;
      });

      // Verification loop: check health within startup window
      this.waitForStartup();
    } catch (err: any) {
      console.warn(`[Python-ML] Failed to start Python service: ${err.message}. Preserving Express server.`);
      this.childProcess = null;
      this.isHealthy = false;
    }
  }

  private async waitForStartup(): Promise<void> {
    const startMs = Date.now();
    while (Date.now() - startMs < STARTUP_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 600));
      const { healthy } = await this.checkHealth();
      if (healthy) {
        console.log(`[Python-ML] Service confirmed healthy on http://127.0.0.1:${ML_PORT}.`);
        return;
      }
      if (!this.childProcess) {
        return; // Exited early
      }
    }
    console.info(`[Python-ML] Health verification still warming up. Gateways will use fallbacks until service is fully ready.`);
  }

  /**
   * Graceful shutdown of child process.
   */
  public async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (!this.childProcess || this.childProcess.killed) {
      return;
    }

    console.log(`[Python-ML] Stopping internal ML process (PID ${this.childProcess.pid})...`);
    try {
      this.childProcess.kill('SIGTERM');
      // Wait up to 2 seconds for graceful exit
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => {
          this.childProcess?.on('exit', () => resolve(true));
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);

      if (!exited && this.childProcess && !this.childProcess.killed) {
        console.warn(`[Python-ML] Forcefully terminating child process (SIGKILL)...`);
        this.childProcess.kill('SIGKILL');
      }
    } catch (err: any) {
      console.warn(`[Python-ML] Error during shutdown: ${err.message}`);
    } finally {
      this.childProcess = null;
      this.isHealthy = false;
    }
  }

  /**
   * Returns sanitized status for public /api/health endpoint.
   */
  public async getSanitizedStatus(): Promise<MLSupervisorStatus> {
    const health = await this.checkHealth();
    return {
      isConfigured: fs.existsSync(this.appPath),
      isRunning: Boolean(this.childProcess && !this.childProcess.killed) || health.healthy,
      isHealthy: health.healthy,
      pid: this.childProcess?.pid || null,
      restarts: this.restarts,
      pythonBin: this.pythonBin ? path.basename(this.pythonBin) : null,
      port: ML_PORT,
      modelLoaded: health.data?.model_loaded || false,
      opencvAvailable: health.data?.opencv_available || false,
      opencvVersion: health.data?.opencv_version || undefined,
    };
  }

  private registerSignalHandlers(): void {
    if (this.signalHandlersRegistered) return;
    this.signalHandlersRegistered = true;

    const cleanup = async () => {
      await this.stop();
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('exit', cleanup);
  }
}

export const mlSupervisor = new MLSupervisor();
