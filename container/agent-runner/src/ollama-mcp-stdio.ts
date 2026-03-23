/**
 * Ollama MCP Server
 *
 * Provides two tools:
 * - ollama_list_models
 * - ollama_generate
 *
 * Agent uses Docker host networking via host.docker.internal, with fallback to localhost.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const OLLAMA_DEFAULT_HOST = process.env.OLLAMA_HOST?.trim() || 'http://host.docker.internal:11434';
const OLLAMA_FALLBACK_HOST = 'http://localhost:11434';

const hosts = [OLLAMA_DEFAULT_HOST, OLLAMA_FALLBACK_HOST].filter(Boolean);

async function requestOllama(path: string, options?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (const host of hosts) {
    const url = `${host.replace(/\/$/, '')}${path}`;
    try {
      const resp = await fetch(url, options);
      if (!resp.ok) {
        throw new Error(`Ollama responded ${resp.status} ${resp.statusText} at ${url}`);
      }
      return resp;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Failed to reach Ollama host at ${hosts.join(', ')}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

const server = new McpServer({ name: 'ollama', version: '1.0.0' });

server.tool(
  'list_models',
  'List installed Ollama models and tags.',
  {},
  async () => {
    try {
      const resp = await requestOllama('/api/models');
      const models = await resp.json();
      if (!Array.isArray(models)) {
        throw new Error(`Unexpected response from /api/models: ${JSON.stringify(models)}`);
      }

      if (models.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No Ollama models installed. Run `ollama pull <model>`.' }] };
      }

      const lines = models.map((m: any) => {
        const name = String(m.name || m.id || m.model || 'unknown');
        const desc = m.description ? ` - ${String(m.description)}` : '';
        return `- ${name}${desc}`;
      });

      return { content: [{ type: 'text' as const, text: `Ollama models (${models.length}):\n${lines.join('\n')}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error listing Ollama models: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'generate',
  'Generate text using an Ollama model.',
  {
    model: z.string().describe('Model name (e.g. gemma3:1b)'),
    prompt: z.string().describe('Prompt text to send to the model'),
    max_tokens: z.number().optional().describe('Max tokens (defaults to 1024)'),
    temperature: z.number().optional().describe('Temperature (0.0-2.0)'),
  },
  async (args) => {
    try {
      const payload: any = {
        model: args.model,
        prompt: args.prompt,
      };
      if (args.max_tokens !== undefined) payload.max_tokens = args.max_tokens;
      if (args.temperature !== undefined) payload.temperature = args.temperature;

      const resp = await requestOllama('/v1/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await resp.json();
      if (!result || !result.output) {
        throw new Error(`Unexpected Ollama completion response: ${JSON.stringify(result)}`);
      }

      let text = '';
      if (typeof result.output === 'string') {
        text = result.output;
      } else if (Array.isArray(result.output)) {
        text = result.output.map((item: any) => (typeof item === 'string' ? item : item.text || '')).join('\n');
      } else if (result.output?.[0]?.data?.[0]?.text) {
        text = result.output[0].data[0].text;
      } else if (result.output?.[0]?.text) {
        text = result.output[0].text;
      }

      if (!text) {
        throw new Error(`Ollama did not return text, response: ${JSON.stringify(result)}`);
      }

      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to generate with Ollama: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
