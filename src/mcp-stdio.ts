import { createAppServices } from './app.js';
import { appErrorToJsonRpcError } from './errors.js';
import { handleMcpRequest } from './mcp/server.js';

const services = await createAppServices();
let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  void drain();
});

process.stdin.on('end', () => {
  void services.close();
});

async function drain(): Promise<void> {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return;
    }

    const header = buffer.slice(0, headerEnd).toString('utf8');
    const lengthMatch = header.match(/content-length:\s*(\d+)/i);
    if (!lengthMatch) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      return;
    }

    const body = buffer.slice(bodyStart, bodyEnd).toString('utf8');
    buffer = buffer.slice(bodyEnd);

    const message = JSON.parse(body) as JsonRpcRequest;
    if (!('id' in message)) {
      continue;
    }

    try {
      const result = await handleMcpRequest(services, message);
      writeMessage({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: appErrorToJsonRpcError(error),
      });
    }
  }
}

function writeMessage(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
