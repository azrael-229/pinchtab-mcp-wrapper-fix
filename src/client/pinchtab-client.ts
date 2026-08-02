import { PinchtabError } from '../types/index.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export class PinchtabClient {
  private baseUrl: string;
  private token?: string;
  private defaultTimeout: number;
  private onUnhealthy?: () => Promise<void>;

  constructor(baseUrl: string, token?: string, timeout = 30000, onUnhealthy?: () => Promise<void>) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.defaultTimeout = timeout;
    this.onUnhealthy = onUnhealthy;
  }

   async ensureHealthy(): Promise<void> {
    try {
      const health = await this.rawHealth();

      if (health.status !== 'ok') {
        logger.warn(`Pinchtab unhealthy: ${JSON.stringify(health)}`);
        if (this.onUnhealthy) {
          logger.info('Attempting restart...');
          await this.onUnhealthy();
          await new Promise(resolve => setTimeout(resolve, 3000));
          const newHealth = await this.rawHealth();
           if (newHealth.status !== 'ok') {
            throw new PinchtabError(
              `Pinchtab still unhealthy after automatic restart: ${JSON.stringify(newHealth)}.\n\n` +
              'Automatic recovery failed. This could indicate:\n' +
              '- Chrome cannot start due to missing dependencies\n' +
              '- Port 9867 is blocked or already in use\n' +
              '- Insufficient permissions or resources\n\n' +
              'Please check:\n' +
              '  1. Docker logs (if using docker mode): docker logs pinchtab\n' +
              '  2. System resources: free memory, disk space\n' +
              '  3. Chrome installation: ensure Chrome/Chromium is available\n' +
              '  4. Firewall settings: port 9867 must be accessible\n',
              'HEALTH_ERROR'
            );
          }
          logger.info('Restart successful');
        } else {
          throw new PinchtabError(
            `Pinchtab is running but Chrome is not connected (zombie state). Health status: ${JSON.stringify(health)}.\n\n` +
            'Possible causes:\n' +
            '- Chrome crashed or failed to start\n' +
            '- Invalid Chrome flags (CDP_URL environment variable)\n' +
            '- Insufficient memory or resources\n\n' +
            'Manual fix:\n' +
            '  1. Kill the pinchtab process: pkill pinchtab\n' +
            '  2. Restart your MCP client\n' +
            '  3. If using external mode, ensure Pinchtab binary is accessible\n',
            'HEALTH_ERROR'
          );
        }
      }
    } catch (error) {
      if (error instanceof PinchtabError) {
        throw error;
      }
      logger.warn(`Health check failed: ${error}`);
      if (this.onUnhealthy) {
        logger.info('Attempting restart due to health check failure...');
        await this.onUnhealthy();
        await new Promise(resolve => setTimeout(resolve, 3000));
         const newHealth = await this.rawHealth();
         if (newHealth.status !== 'ok') {
          throw new PinchtabError(
            `Pinchtab still unhealthy after restart: ${JSON.stringify(newHealth)}`,
            'HEALTH_ERROR'
          );
        }
        logger.info('Restart successful');
      } else {
        throw new PinchtabError(
          `Health check failed and no restart handler: ${error instanceof Error ? error.message : String(error)}.\n\n` +
          'Cannot connect to Pinchtab server. Possible reasons:\n' +
          '- Pinchtab process is not running\n' +
          '- Network connectivity issues\n' +
          '- Incorrect PINCHTAB_URL configuration\n' +
          '- Authentication token mismatch\n\n' +
          'Troubleshooting steps:\n' +
          '  1. Verify Pinchtab is running: curl http://localhost:9867/health\n' +
          '  2. Check environment variables: PINCHTAB_URL, PINCHTAB_TOKEN\n' +
          '  3. Restart the MCP server\n' +
          '  4. Review logs for detailed error messages\n',
          'HEALTH_ERROR'
        );
      }
    }
  }

  private async rawHealth(): Promise<{ status: string }> {
    const url = `${this.baseUrl}/health`;
    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.ok) {
        const health = await response.json() as { status: string };
        return health;
      } else {
        return { status: 'error' };
      }
    } catch {
      clearTimeout(timeoutId);
      return { status: 'error' };
    }
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
      logger.debug(`Adding Authorization header with token length: ${this.token.length}`);
    } else {
      logger.debug('No token available for request');
    }

    await this.ensureHealthy();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.defaultTimeout);

    try {
      logger.debug(`HTTP ${options.method || 'GET'} ${url}`);
      
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(`Pinchtab error: ${response.status} ${errorBody}`);
        
        if (response.status === 401) {
          throw new PinchtabError('Authentication failed', 'AUTH_ERROR', 401);
        }
        if (response.status === 404) {
          throw new PinchtabError('Resource not found', 'NOT_FOUND', 404);
        }
        if (response.status === 423) {
          throw new PinchtabError('Tab is locked', 'TAB_LOCKED', 423);
        }
        
        throw new PinchtabError(
          `HTTP error ${response.status}: ${errorBody}`,
          'HTTP_ERROR',
          response.status
        );
      }

      const contentType = response.headers.get('content-type') || '';
      
      if (contentType.includes('application/json')) {
        return await response.json() as T;
      }
      
      return await response.text() as unknown as T;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof PinchtabError) {
        throw error;
      }
      
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PinchtabError('Request timeout', 'TIMEOUT_ERROR');
      }
      
      logger.error(`Request failed: ${error}`);
      throw new PinchtabError(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        'REQUEST_ERROR'
      );
    }
  }

  async health(): Promise<{ status: string; version?: string }> {
    return this.request('/health', { method: 'GET' });
  }

  async listTabs(): Promise<Array<{ id: string; url: string; title?: string; type?: string }>> {
    const response = await this.request<{ tabs: Array<{ id: string; url: string; title?: string; type?: string }> }>('/tabs', { method: 'GET' });
    return response.tabs;
  }

  async openTab(url?: string): Promise<{ tabId: string; title: string; url: string }> {
    return this.request('/tab', {
      method: 'POST',
      body: JSON.stringify({ action: 'new', url }),
    });
  }

  async closeTab(tabId: string): Promise<{ closed: boolean }> {
    return this.request('/close', {
      method: 'POST',
      body: JSON.stringify({ tabId }),
    });
  }

  async navigate(tabId: string, url: string): Promise<{ tabId: string; title: string; url: string }> {
    const response = await this.request<{ title: string; url: string }>('/navigate', {
      method: 'POST',
      body: JSON.stringify({ tabId, url }),
    });
    return { tabId, title: response.title, url: response.url };
  }

  async snapshot(
    tabId?: string,
    options: {
      filter?: 'interactive';
      format?: string;
      diff?: boolean;
      selector?: string;
      depth?: number;
      maxTokens?: number;
      noAnimations?: boolean;
      output?: string;
      path?: string;
    } = {}
  ): Promise<unknown> {
    const query = new URLSearchParams();
    if (options.filter) query.set('filter', options.filter);
    if (options.format) query.set('format', options.format);
    if (options.diff) query.set('diff', 'true');
    if (options.selector) query.set('selector', options.selector);
    if (options.depth !== undefined) query.set('depth', String(options.depth));
    if (options.maxTokens !== undefined) query.set('maxTokens', String(options.maxTokens));
    if (options.noAnimations) query.set('noAnimations', 'true');
    if (options.output) query.set('output', options.output);
    if (options.path) query.set('path', options.path);

    const endpoint = tabId 
      ? `/snapshot?tabId=${tabId}&${query.toString()}`
      : `/snapshot?${query.toString()}`;
    
    return this.request(endpoint, { method: 'GET' });
  }

  async text(tabId?: string, mode?: string): Promise<{ url: string; content: string; title?: string }> {
    const query = new URLSearchParams();
    if (mode) query.set('mode', mode);

    const endpoint = tabId 
      ? `/text?tabId=${tabId}&${query.toString()}`
      : `/text?${query.toString()}`;
    
    return this.request(endpoint, { method: 'GET' });
  }

  async action(
    tabId: string,
    actionData: {
      kind: string;
      ref?: string;
      selector?: string;
      text?: string;
      value?: string;
      key?: string;
      x?: number;
      y?: number;
      scrollX?: number;
      scrollY?: number;
    }
  ): Promise<{ success: boolean }> {
    return this.request(`/action?tabId=${tabId}`, {
      method: 'POST',
      body: JSON.stringify(actionData),
    });
  }

  async evaluate(tabId: string, js: string): Promise<{ result: unknown }> {
    return this.request(`/evaluate?tabId=${tabId}`, {
      method: 'POST',
      body: JSON.stringify({ js }),
    });
  }

  async lockTab(tabId: string, owner: string, timeoutMs?: number): Promise<{ locked: boolean; owner?: string; expiresAt?: string }> {
    const body: { owner: string; timeoutMs?: number } = { owner };
    if (timeoutMs) body.timeoutMs = timeoutMs;
    
    return this.request(`/tab/lock?tabId=${tabId}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async unlockTab(tabId: string, owner: string): Promise<void> {
    await this.request(`/tab/unlock?tabId=${tabId}`, {
      method: 'POST',
      body: JSON.stringify({ owner }),
    });
  }

  async screenshot(
    tabId?: string,
    options: {
      quality?: number;
      noAnimations?: boolean;
    } = {}
  ): Promise<Buffer> {
    const query = new URLSearchParams();
    if (options.quality !== undefined) query.set('quality', String(options.quality));
    if (options.noAnimations) query.set('noAnimations', 'true');

    const endpoint = tabId
      ? `/screenshot?tabId=${tabId}&${query.toString()}`
      : `/screenshot?${query.toString()}`;

    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.defaultTimeout);

    try {
      logger.debug(`HTTP GET ${url} (screenshot binary)`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new PinchtabError(
          `Screenshot failed: ${response.status}`,
          'SCREENSHOT_ERROR',
          response.status
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  async download(
    url: string,
    options: {
      tabId?: string;
      output?: 'file' | 'base64' | 'raw';
      path?: string;
      raw?: boolean;
    } = {}
  ): Promise<Buffer | { data: string; contentType: string; size: number; url: string } | { status: string; path: string; size: number; contentType: string }> {
    const query = new URLSearchParams();
    query.set('url', url);
    if (options.tabId) query.set('tabId', options.tabId);
    if (options.output) query.set('output', options.output);
    if (options.path) query.set('path', options.path);
    if (options.raw) query.set('raw', 'true');

    const endpoint = `/download?${query.toString()}`;
    
    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.defaultTimeout);

    try {
      logger.debug(`HTTP GET ${this.baseUrl}${endpoint} (download)`);
      
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new PinchtabError(
          `Download failed: ${response.status}`,
          'DOWNLOAD_ERROR',
          response.status
        );
      }

      const contentType = response.headers.get('content-type') || '';
      
      if (options.output === 'file' || options.path) {
        return await response.json() as { status: string; path: string; size: number; contentType: string };
      } else if (options.raw || options.output === 'raw') {
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } else if (contentType.includes('application/json')) {
        return await response.json() as { data: string; contentType: string; size: number; url: string };
      } else {
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  async upload(
    tabId: string,
    files: Array<{
      path?: string;
      base64?: string;
      dataUrl?: string;
      name?: string;
    }>,
    options: {
      selector?: string;
      ref?: string;
    } = {}
  ): Promise<{ uploaded: boolean; files: string[] }> {
    const body: {
      files: Array<{
        path?: string;
        base64?: string;
        dataUrl?: string;
        name?: string;
      }>;
      selector?: string;
      ref?: string;
    } = { files };
    
    if (options.selector) body.selector = options.selector;
    if (options.ref) body.ref = options.ref;

    return this.request(`/upload?tabId=${tabId}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}
