#!/usr/bin/env node
// MCP server entry point: newline-delimited JSON-RPC 2.0 on stdio. The protocol lives in
// src/mcp.mjs so the tests can import it without this file starting anything.
import { serve } from '../src/mcp.mjs';

serve();
