import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GrocyMcpServer } from '../src/server/mcp-server.js';
import { createToolRegistry, ToolRegistry } from '../src/tools/index.js';

// Mock config module
vi.mock('../src/config/environment.js', () => ({
  default: {
    get: () => ({
      GROCY_BASE_URL: 'http://test-grocy:9283',
      GROCY_API_KEY: 'test-api-key',
      GROCY_ENABLE_SSL_VERIFY: true,
      ENABLE_HTTP_SERVER: false,
      HTTP_SERVER_PORT: 8080,
      REST_RESPONSE_SIZE_LIMIT: 10000
    }),
    getGrocyBaseUrl: () => 'http://test-grocy:9283',
    getApiUrl: () => 'http://test-grocy:9283/api',
    hasApiKeyAuth: () => true,
    getCustomHeaders: () => ({}),
    parseToolConfiguration: () => ({ enabledTools: new Set() })
  }
}));

// Mock the API client
vi.mock('../src/api/client.js', () => ({
  default: {
    request: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  },
  ApiError: class ApiError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ApiError';
    }
  }
}));

describe('Integration Tests', () => {
  let server: GrocyMcpServer;
  let toolRegistry: ToolRegistry;

  beforeEach(async () => {
    vi.clearAllMocks();
    toolRegistry = await createToolRegistry();
  });

  afterEach(async () => {
    if (server) {
      try {
        await server.serverInstance.close();
      } catch (error) {
        // Ignore close errors in tests
      }
    }
    vi.clearAllMocks();
  });

  describe('Server Initialization', () => {
    it('should create server instance successfully', async () => {
      // Create the server instance
      server = await GrocyMcpServer.create();

      expect(server).toBeDefined();
      expect(server.serverInstance).toBeDefined();
    });

    it('should expose a real McpServer with tools/resources registered', async () => {
      server = await GrocyMcpServer.create();
      expect(server.serverInstance).toBeInstanceOf(McpServer);
    });
  });

  describe('Tool Registry Integration', () => {
    it('should have consistent tool definitions and handlers', () => {
      const definitions = toolRegistry.getDefinitions();
      const toolNames = toolRegistry.getToolNames();

      expect(definitions.length).toBeGreaterThan(30);
      expect(toolNames.length).toBe(definitions.length);

      // Each definition should have a corresponding handler
      definitions.forEach(def => {
        const handler = toolRegistry.getHandler(def.name);
        expect(handler).toBeDefined();
        expect(typeof handler).toBe('function');
      });
    });

    it('should have valid tool definitions structure', () => {
      const definitions = toolRegistry.getDefinitions();

      definitions.forEach(def => {
        // Check required fields
        expect(def.name).toBeTypeOf('string');
        expect(def.description).toBeTypeOf('string');
        expect(def.inputSchema).toBeDefined();
        expect(def.inputSchema.type).toBe('object');
        expect(Array.isArray(def.inputSchema.required)).toBe(true);
        expect(def.inputSchema.properties).toBeDefined();
      });
    });
  });

  describe('Tool Execution Integration', () => {
    beforeEach(async () => {
      server = await GrocyMcpServer.create();
    });

    it('wires tools/* and resources/* handlers on the underlying Server', () => {
      const handlers = (server.serverInstance.server as unknown as { _requestHandlers: Map<string, unknown> })
        ._requestHandlers;
      expect(handlers.has('tools/list')).toBe(true);
      expect(handlers.has('tools/call')).toBe(true);
      expect(handlers.has('resources/list')).toBe(true);
      expect(handlers.has('resources/templates/list')).toBe(true);
      expect(handlers.has('resources/read')).toBe(true);
    });

    it('should validate tool registry has handlers for all definitions', () => {
      const definitions = toolRegistry.getDefinitions();
      
      expect(definitions.length).toBeGreaterThan(30);
      
      // Each definition should have a handler
      definitions.forEach(def => {
        const handler = toolRegistry.getHandler(def.name);
        expect(handler).toBeDefined();
        expect(typeof handler).toBe('function');
      });
    });
  });

  describe('Error Handling Integration', () => {
    beforeEach(async () => {
      server = await GrocyMcpServer.create();
    });

    it('should set up error handling', () => {
      expect(typeof server.serverInstance.server.onerror).toBe('function');
    });

    it('should validate server initialization', () => {
      // Server should be properly initialized
      expect(server).toBeDefined();
      expect(server.serverInstance).toBeDefined();
    });
  });

  describe('Configuration Integration', () => {
    it('should apply tool filtering when configured', async () => {
      // Mock tool filtering configuration
      vi.doMock('../src/config/environment.js', () => ({
        default: {
          get: () => ({ /* config */ }),
          parseToolConfiguration: () => ({ 
            allowedTools: new Set(['get_products', 'get_stock']), 
            blockedTools: new Set(['delete_recipe_from_meal_plan']) 
          }),
          getGrocyBaseUrl: () => 'http://test-grocy:9283',
          hasApiKeyAuth: () => true,
          getCustomHeaders: () => ({})
        }
      }));

      await expect(GrocyMcpServer.create()).resolves.toBeDefined();
    });
  });

  describe('Module System Integration', () => {
    it('should load all tool modules correctly', async () => {
      // Test that the dynamic module loading system works
      const registry = await createToolRegistry();
      
      expect(registry).toBeDefined();
      expect(registry.getDefinitions().length).toBeGreaterThan(25); // Should have many tools
      expect(registry.getToolNames().length).toBeGreaterThan(25);
      
      // Verify all tools have handlers
      const definitions = registry.getDefinitions();
      definitions.forEach(def => {
        const handler = registry.getHandler(def.name);
        expect(handler).toBeDefined();
        expect(typeof handler).toBe('function');
      });
    });
  });
});