import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_NAME } from '../version.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Static docs exposed as MCP resources (used by ResourceHandler and McpServer registration). */
export const STATIC_MCP_RESOURCE_ENTRIES = [
  {
    slug: 'examples',
    name: 'mcp-grocy usage examples',
    description: 'Examples of calling this MCP server’s tools against Grocy',
    mimeType: 'text/markdown' as const,
  },
  {
    slug: 'response-format',
    name: 'Tool response format',
    description: 'How tool results and system_dev_test_request responses are shaped',
    mimeType: 'text/markdown' as const,
  },
  {
    slug: 'config',
    name: 'Configuration',
    description: 'YAML and environment configuration for mcp-grocy',
    mimeType: 'text/markdown' as const,
  },
] as const;

export class ResourceHandler {
  private __dirname: string;
  private readonly allowedResources: Set<string> = new Set(
    STATIC_MCP_RESOURCE_ENTRIES.map((e) => e.slug),
  );

  constructor() {
    const __filename = fileURLToPath(import.meta.url);
    this.__dirname = path.dirname(__filename);
  }

  public async listResources() {
    return {
      resources: STATIC_MCP_RESOURCE_ENTRIES.map((e) => ({
        uri: `${SERVER_NAME}://${e.slug}`,
        name: e.name,
        description: e.description,
        mimeType: e.mimeType,
      })),
    };
  }

  public async readResource(uri: string) {
    const uriPattern = new RegExp(`^${SERVER_NAME}://(.+)$`);
    const match = uri.match(uriPattern);

    if (!match) {
      throw new McpError(ErrorCode.InvalidRequest, `Invalid resource URI format: ${uri}`);
    }

    const resource = match[1];
    if (!resource || !this.allowedResources.has(resource)) {
      throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${resource}`);
    }

    try {
      // In the built app, resources are in build/resources
      // In development, they're in src/resources
      const resourcePath = path.join(this.__dirname, '../resources', `${resource}.md`);
      const content = await fs.promises.readFile(resourcePath, 'utf8');

      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: content,
          },
        ],
      };
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${resource}`);
    }
  }
}
