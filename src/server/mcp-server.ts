/**
 * Simplified MCP Server implementation
 * Reduced complexity and improved performance
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { VERSION, PACKAGE_NAME as SERVER_NAME } from '../version.js';
import { createToolRegistry } from '../tools/index.js';
import type { ToolRegistry } from '../tools/types.js';
import { config } from '../config/index.js';
import { startHttpServer } from './http-server.js';
import { ResourceHandler } from './resources.js';
import { logger } from '../utils/logger.js';
import { ErrorHandler } from '../utils/errors.js';

/** MCP 2025-03-26 legacy async tools (Janix validator + older clients); not in typed ServerCapabilities. */
const GROCY_SERVER_CAPABILITIES = {
  tools: {
    listChanged: false,
    asyncSupported: true,
  },
  resources: {},
  prompts: {},
} as unknown as ServerCapabilities;

const ToolsCallAsyncRequestSchema = z.object({
  method: z.literal('tools/call-async'),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
  id: z.union([z.string(), z.number()]),
});

const ToolsResultRequestSchema = z.object({
  method: z.literal('tools/result'),
  params: z.object({
    id: z.union([z.string(), z.number()]),
  }),
});

const ToolsCancelRequestSchema = z.object({
  method: z.literal('tools/cancel'),
  params: z.object({
    id: z.union([z.string(), z.number()]),
  }),
});

type AsyncToolJob =
  | { status: 'pending' }
  | { status: 'completed'; result: CallToolResult }
  | { status: 'error'; error: { code: number; message: string } }
  | { status: 'cancelled' };

export class GrocyMcpServer {
  private server: Server;
  private enabledTools = new Set<string>();
  private toolSubConfigs = new Map<string, Map<string, any>>();
  private toolAckTokens = new Map<string, string>();
  private resourceHandler: ResourceHandler;
  private toolRegistry: ToolRegistry;
  private readonly asyncToolJobs = new Map<string, AsyncToolJob>();

  private constructor(
    server: Server,
    toolRegistry: ToolRegistry,
    resourceHandler: ResourceHandler
  ) {
    this.server = server;
    this.toolRegistry = toolRegistry;
    this.resourceHandler = resourceHandler;
    this.parseToolConfiguration();
    this.setupHandlers(this.server);
    this.setupErrorHandling(this.server);
  }

  static async create(): Promise<GrocyMcpServer> {
    // Initialize components
    const [toolRegistry, resourceHandler] = await Promise.all([
      createToolRegistry(),
      Promise.resolve(new ResourceHandler())
    ]);

    // Create server (SDK handles initialize / protocol negotiation)
    const server = new Server(
      {
        name: SERVER_NAME,
        version: VERSION,
        websiteUrl: 'https://github.com/miguelangel-nubla/mcp-grocy',
        description:
          'MCP server for Grocy. Documentation: https://github.com/miguelangel-nubla/mcp-grocy/blob/main/README.md',
      },
      {
        capabilities: GROCY_SERVER_CAPABILITIES,
      }
    );

    return new GrocyMcpServer(server, toolRegistry, resourceHandler);
  }

  private parseToolConfiguration(): void {
    const { enabledTools, toolSubConfigs, toolAckTokens } = config.parseToolConfiguration();
    this.toolSubConfigs = toolSubConfigs;
    this.toolAckTokens = toolAckTokens;
    
    const validToolNames = new Set(this.toolRegistry.getToolNames());
    
    if (enabledTools.size > 0) {
      const invalidTools = Array.from(enabledTools).filter(tool => !validToolNames.has(tool));
      if (invalidTools.length > 0) {
        const validNames = Array.from(validToolNames).sort().join(', ');
        logger.error(`Invalid tools: ${invalidTools.join(', ')}. Valid: ${validNames}`, 'CONFIG');
        process.exit(1);
      }
      this.enabledTools = enabledTools;
      logger.config(`Enabled tools: ${Array.from(enabledTools).join(', ')}`);
    } else {
      logger.warn('No tools enabled', 'CONFIG');
    }
  }

  /**
   * Shared implementation for tools/call and tools/call-async (2025-03-26).
   */
  private async executeToolCall(
    toolName: string,
    args: Record<string, unknown> | undefined
  ): Promise<CallToolResult> {
    if (!this.enabledTools.has(toolName)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Tool '${toolName}' is not enabled. Enable it in your configuration.`
      );
    }

    const handler = this.toolRegistry.getHandler(toolName);
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }

    try {
      const subConfigs = this.toolSubConfigs.get(toolName);
      const result = await handler(args, subConfigs);

      if (!result.isError) {
        const ackToken = this.toolAckTokens.get(toolName);
        if (ackToken) {
          result.content.unshift({
            type: 'text' as const,
            text: `Acknowledgment token: ${ackToken}`
          });
        }
      }

      return result as CallToolResult;
    } catch (error: any) {
      ErrorHandler.logError(error, `tool: ${toolName}`);
      throw ErrorHandler.toMcpError(error, `${toolName} failed`);
    }
  }

  /** Isolate async tool jobs per transport session (HTTP) vs stdio default. */
  private jobStorageKey(sessionId: string | undefined, id: string | number): string {
    const s = sessionId ?? 'stdio';
    return `${s}:${String(id)}`;
  }

  private async runAsyncToolJob(
    storageKey: string,
    toolName: string,
    args: Record<string, unknown> | undefined
  ): Promise<void> {
    const pending = this.asyncToolJobs.get(storageKey);
    if (!pending || pending.status !== 'pending') {
      return;
    }
    try {
      const result = await this.executeToolCall(toolName, args);
      const current = this.asyncToolJobs.get(storageKey);
      if (!current || current.status === 'cancelled') {
        return;
      }
      this.asyncToolJobs.set(storageKey, { status: 'completed', result });
    } catch (error: unknown) {
      const current = this.asyncToolJobs.get(storageKey);
      if (!current || current.status === 'cancelled') {
        return;
      }
      const err = ErrorHandler.toMcpError(error as Error, `${toolName} failed`);
      this.asyncToolJobs.set(storageKey, {
        status: 'error',
        error: { code: err.code, message: err.message }
      });
    }
  }

  private setupHandlers(server: Server): void {
    // List tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allTools = this.toolRegistry.getDefinitions();
      const filteredTools = allTools.filter(tool => this.enabledTools.has(tool.name));
      
      logger.config(`Available tools: ${filteredTools.map(t => t.name).join(', ')}`);
      return { tools: filteredTools };
    });

    // Call tool
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name: toolName, arguments: args } = request.params;
      return this.executeToolCall(toolName, args as Record<string, unknown> | undefined);
    });

    // Legacy async tools (MCP 2025-03-26) — run synchronously but expose poll/cancel API
    server.setRequestHandler(ToolsCallAsyncRequestSchema, async (request, extra) => {
      const { name: toolName, arguments: args } = request.params;
      const storageKey = this.jobStorageKey(extra.sessionId, request.id);
      const jobId = String(request.id);
      this.asyncToolJobs.set(storageKey, { status: 'pending' });
      void this.runAsyncToolJob(storageKey, toolName, args);
      return { id: jobId, status: 'pending' as const };
    });

    server.setRequestHandler(ToolsResultRequestSchema, async (request, extra) => {
      const storageKey = this.jobStorageKey(extra.sessionId, request.params.id);
      const job = this.asyncToolJobs.get(storageKey);
      if (!job) {
        return {
          status: 'error' as const,
          error: { message: `Unknown tool call id: ${String(request.params.id)}` }
        };
      }
      if (job.status === 'pending') {
        return { status: 'pending' as const };
      }
      if (job.status === 'cancelled') {
        return { status: 'cancelled' as const };
      }
      if (job.status === 'error') {
        return { status: 'error' as const, error: job.error };
      }
      const { content, isError } = job.result;
      return {
        status: 'completed' as const,
        content,
        ...(isError !== undefined && { isError })
      };
    });

    server.setRequestHandler(ToolsCancelRequestSchema, async (request, extra) => {
      const storageKey = this.jobStorageKey(extra.sessionId, request.params.id);
      const job = this.asyncToolJobs.get(storageKey);
      if (!job) {
        return { success: false };
      }
      if (job.status === 'pending') {
        this.asyncToolJobs.set(storageKey, { status: 'cancelled' });
        return { success: true };
      }
      return { success: false };
    });

    // Resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return this.resourceHandler.listResources();
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return this.resourceHandler.readResource(request.params.uri);
    });
  }

  private setupErrorHandling(server: Server): void {
    server.onerror = (error) => {
      logger.error('MCP protocol error', 'MCP', { error });
    };
    
    process.on('SIGINT', async () => {
      logger.info('Shutting down server...', 'SERVER');
      await this.server.close();
      process.exit(0);
    });
  }

  public createMcpServer(): Server {
    const server = new Server(
      {
        name: SERVER_NAME,
        version: VERSION,
        websiteUrl: 'https://github.com/miguelangel-nubla/mcp-grocy',
        description:
          'MCP server for Grocy. Documentation: https://github.com/miguelangel-nubla/mcp-grocy/blob/main/README.md',
      },
      {
        capabilities: GROCY_SERVER_CAPABILITIES,
      }
    );
    
    this.setupHandlers(server);
    this.setupErrorHandling(server);
    
    return server;
  }

  public async start(): Promise<void> {
    const httpTransportOnly =
      process.env.MCP_HTTP_TRANSPORT_ONLY === 'true' ||
      process.env.MCP_HTTP_TRANSPORT_ONLY === '1';

    if (httpTransportOnly && !config.server.enable_http_server) {
      logger.error(
        'MCP_HTTP_TRANSPORT_ONLY is set but HTTP server is disabled; enable server.enable_http_server or ENABLE_HTTP_SERVER',
        'SERVER'
      );
      process.exit(1);
    }

    if (!httpTransportOnly) {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      logger.info('MCP server running on stdio', 'SERVER');
    } else {
      logger.info('MCP_HTTP_TRANSPORT_ONLY: stdio transport skipped', 'SERVER');
    }

    // Start HTTP/SSE if enabled
    if (config.server.enable_http_server) {
      try {
        logger.config(`Starting HTTP server on port ${config.server.http_server_port}`);
        const serverFactory = () => this.createMcpServer();
        await startHttpServer(serverFactory, config.server.http_server_port, {
          corsOrigin: config.server.http_cors_origin,
          ...(config.server.http_access_token !== undefined && {
            accessToken: config.server.http_access_token
          })
        });
      } catch (error) {
        logger.error('Failed to start HTTP server', 'SERVER', { error });
        logger.error('HTTP server is explicitly enabled but cannot start - exiting', 'SERVER');
        process.exit(1);
      }
    }
  }

  // Expose server for HTTP transport
  public get serverInstance(): Server {
    return this.server;
  }
}

export default GrocyMcpServer;
