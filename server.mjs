import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const root = process.cwd();
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

http.createServer(async (request, response) => {
  try {
    const path = join(root, request.url === "/" ? "index.html" : decodeURIComponent(request.url.slice(1)));
    const content = await readFile(path);
    response.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(5173, "127.0.0.1", () => console.log("PulsePlay en http://127.0.0.1:5173"));
