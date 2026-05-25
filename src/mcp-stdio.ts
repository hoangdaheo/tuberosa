import { createAppServices } from './app.js';
import { appErrorToJsonRpcError } from './errors.js';
import { handleMcpRequest } from './mcp/server.js';

if (!process.env.TUBEROSA_CACHE) {
  process.env.TUBEROSA_CACHE = 'memory';
}

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
    const framed = readNextMessage();
    if (!framed) {
      return;
    }

    let message: JsonRpcRequest;
    try {
      message = JSON.parse(framed.body) as JsonRpcRequest;
    } catch {
      writeMessage({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
          data: { code: 'validation_error', status: 400 },
        },
      }, framed.framing);
      continue;
    }

    if (!('id' in message)) {
      continue;
    }

    try {
      const result = await handleMcpRequest(services, message);
      writeMessage({ jsonrpc: '2.0', id: message.id, result }, framed.framing);
    } catch (error) {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: appErrorToJsonRpcError(error),
      }, framed.framing);
    }
  }
}

function readNextMessage(): FramedMessage | undefined {
  if (startsWithContentLength(buffer)) {
    return readContentLengthMessage();
  }

  return readLineMessage();
}

function startsWithContentLength(input: Buffer): boolean {
  return input.slice(0, 'content-length:'.length).toString('utf8').toLowerCase() === 'content-length:';
}

function readContentLengthMessage(): FramedMessage | undefined {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    return undefined;
  }

  const header = buffer.slice(0, headerEnd).toString('utf8');
  const lengthMatch = header.match(/content-length:\s*(\d+)/i);
  if (!lengthMatch) {
    buffer = buffer.slice(headerEnd + 4);
    return undefined;
  }

  const length = Number(lengthMatch[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) {
    return undefined;
  }

  const body = buffer.slice(bodyStart, bodyEnd).toString('utf8');
  buffer = buffer.slice(bodyEnd);
  return { body, framing: 'content-length' };
}

function readLineMessage(): FramedMessage | undefined {
  const newline = buffer.indexOf('\n');
  if (newline === -1) {
    return undefined;
  }

  const body = buffer.slice(0, newline).toString('utf8').trim();
  buffer = buffer.slice(newline + 1);
  if (!body) {
    return undefined;
  }

  return { body, framing: 'line' };
}

function writeMessage(message: unknown, framing: MessageFraming): void {
  const body = JSON.stringify(message);
  if (framing === 'line') {
    process.stdout.write(`${body}\n`);
    return;
  }

  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

type MessageFraming = 'content-length' | 'line';

interface FramedMessage {
  body: string;
  framing: MessageFraming;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
