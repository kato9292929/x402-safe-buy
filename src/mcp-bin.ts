#!/usr/bin/env node
// stdio entry point of the x402-safe-buy MCP server. stdout carries the protocol only.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSafeBuyMcpServer } from "./mcp.js";

const server = createSafeBuyMcpServer();
await server.connect(new StdioServerTransport());
