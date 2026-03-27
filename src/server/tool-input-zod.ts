/**
 * Builds Zod input schemas from tool definitions (JSON Schema subset used by this repo)
 * so McpServer.registerTool can validate and advertise tools.
 */

import { z } from 'zod';
import type { ToolDefinition } from '../tools/types.js';

type JsonProp = {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonProp;
  properties?: Record<string, JsonProp>;
  required?: string[];
  additionalProperties?: boolean | JsonProp;
};

function isStringTupleEnum(values: unknown[]): values is [string, ...string[]] {
  return values.length > 0 && values.every((v) => typeof v === 'string');
}

function propertyToZod(prop: JsonProp, required: boolean): z.ZodTypeAny {
  const t = prop.type;
  let inner: z.ZodTypeAny;

  switch (t) {
    case 'string': {
      if (Array.isArray(prop.enum) && isStringTupleEnum(prop.enum)) {
        inner = z.enum(prop.enum);
      } else {
        inner = z.string();
      }
      break;
    }
    case 'number':
    case 'integer':
      inner = z.number();
      break;
    case 'boolean':
      inner = z.boolean();
      break;
    case 'array': {
      const items = prop.items;
      if (items?.type === 'string' && Array.isArray(items.enum) && isStringTupleEnum(items.enum)) {
        inner = z.array(z.enum(items.enum));
      } else if (items?.type === 'string') {
        inner = z.array(z.string());
      } else if (items?.type === 'number' || items?.type === 'integer') {
        inner = z.array(z.number());
      } else if (items?.type === 'boolean') {
        inner = z.array(z.boolean());
      } else {
        inner = z.array(z.unknown());
      }
      break;
    }
    case 'object': {
      if (prop.properties && typeof prop.properties === 'object') {
        inner = objectPropsToZod(prop.properties, prop.required);
      } else if (
        prop.additionalProperties &&
        typeof prop.additionalProperties === 'object' &&
        prop.additionalProperties.type === 'string'
      ) {
        inner = z.record(z.string(), z.string());
      } else {
        inner = z.record(z.string(), z.unknown());
      }
      break;
    }
    default:
      inner = z.unknown();
  }

  return required ? inner : inner.optional();
}

function objectPropsToZod(
  properties: Record<string, JsonProp>,
  requiredList: string[] | undefined,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const required = new Set(requiredList ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(properties)) {
    shape[key] = propertyToZod(raw, required.has(key));
  }
  return z.object(shape);
}

/** Converts a tool definition's JSON Schema object input into a Zod schema for MCP. */
export function toolDefinitionInputZod(def: ToolDefinition): z.ZodTypeAny {
  const schema = def.inputSchema as JsonProp;
  if (schema?.type !== 'object') {
    return z.record(z.string(), z.unknown());
  }
  const props = schema.properties;
  if (!props || typeof props !== 'object' || Object.keys(props).length === 0) {
    return z.object({});
  }
  return objectPropsToZod(props, schema.required);
}
