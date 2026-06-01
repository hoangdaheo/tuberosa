// MCP arg-coercion + JSON response helpers. Pure functions — no server state.
import { ValidationError } from '../errors.js';

export interface JsonRpcRequest {
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export function readProtocolVersion(params: Record<string, unknown> | undefined): string {
  return typeof params?.protocolVersion === 'string' && params.protocolVersion.trim()
    ? params.protocolVersion
    : '2025-06-18';
}

export function readRequiredMcpString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${path} must be a non-empty string.`, [
      { path, message: `${path} must be a non-empty string.` },
    ]);
  }

  return value;
}

export function readOptionalMcpString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${path} must be a non-empty string when provided.`, [
      { path, message: `${path} must be a non-empty string when provided.` },
    ]);
  }
  return value;
}

export function readMcpStringArray(value: unknown, path: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError(`${path} must be an array of strings.`, [
      { path, message: `${path} must be an array of strings.` },
    ]);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new ValidationError(`${path}[${index}] must be a non-empty string.`, [
        { path: `${path}[${index}]`, message: 'must be a non-empty string.' },
      ]);
    }
    return entry;
  });
}

export function readToolName(request: JsonRpcRequest): string | undefined {
  if (request.method !== 'tools/call') {
    return undefined;
  }
  const params = request.params;
  return typeof params?.name === 'string' ? params.name : undefined;
}

export function readToolArguments(request: JsonRpcRequest): Record<string, unknown> {
  if (request.method !== 'tools/call') {
    return {};
  }
  const args = request.params?.arguments;
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export function toolJson(value: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

export function resourceJson(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
