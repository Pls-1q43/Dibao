import { createServer as httpServer, type Server as HttpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { connect, createServer as tcpServer, type Server, type Socket } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDesktopProxySettings, type DesktopProxySettings } from "@dibao/shared";
import { DesktopRuntime } from "./runtime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function listen(server: Server | HttpServer): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", socket => {
    sockets.add(socket);
    // Rejected proxy/TLS connections can reset the fixture socket on Windows.
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => accept()); });
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(accept => server.close(() => accept())); });
  return (server.address() as { port: number }).port;
}

async function networkFixture(kind: "http" | "https" | "socks5" = "http", certificate?: { key: Buffer; cert: Buffer }) {
  const requests: Array<{ host: string | undefined; path: string | undefined; authorization: string | undefined; desktopToken: boolean; servername?: string | false | null }> = [];
  const origin = (certificate ? httpsServer.bind(null, certificate) : httpServer)((request, response) => {
    requests.push({ host: request.headers.host, path: request.url, authorization: request.headers.authorization, desktopToken: Boolean(request.headers["x-dibao-desktop-token"]), servername: (request.socket as TLSSocket).servername });
    if (request.url?.startsWith("/dns-query?")) {
      const name = new URL(request.url, "https://cloudflare-dns.com").searchParams.get("name");
      response.end(JSON.stringify({ Status: 0, Question: [{ name: `${name}.`, type: 1 }], Answer: [{ type: 1, TTL: 0, data: name?.startsWith("private.") ? "127.0.0.1" : "93.184.216.34" }] }));
    }
    else if (request.url?.endsWith("/embeddings")) response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    else if (request.url === "/redirect") { response.writeHead(302, { location: "/feed.xml" }); response.end(); }
    else if (request.url === "/slow") { response.writeHead(200); response.write("waiting"); }
    else if (request.url === "/large") { response.writeHead(200, { "content-length": "1000" }); response.end("x".repeat(1000)); }
    else response.end("<rss>proxied feed</rss>");
  });
  const originPort = await listen(origin);
  const tunnels: string[] = [];
  let rejectConnections = false;
  const tunnel = (client: Duplex, host: string, port: number, head: Buffer) => {
    tunnels.push(`${host}:${port}`);
    if (rejectConnections || (port !== originPort && !(host === "1.1.1.1" && port === 443))) { client.destroy(); return; }
    const upstream = connect(originPort, "127.0.0.1");
    client.once("close", () => upstream.destroy()); upstream.on("error", () => client.destroy());
    upstream.once("connect", () => {
      client.write(kind !== "socks5" ? "HTTP/1.1 200 Connection Established\r\n\r\n" : Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
  };
  const proxy = kind === "socks5" ? tcpServer() : kind === "https" ? httpsServer(certificate!) : httpServer();
  if (kind !== "socks5") (proxy as HttpServer).on("connect", (request, client, head) => {
    const target = new URL(`http://${request.url}`);
    tunnel(client, target.hostname, Number(target.port), head);
  });
  else proxy.on("connection", client => {
    let greeting = true, buffer = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (greeting) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        const length = 2 + buffer[1];
        if (buffer[0] !== 5 || !buffer.subarray(2, length).includes(0)) { client.destroy(); return; }
        buffer = buffer.subarray(length); greeting = false; client.write(Buffer.from([5, 0]));
      }
      if (buffer.length < 5) return;
      const type = buffer[3];
      const length = type === 3 ? 7 + buffer[4] : type === 1 ? 10 : 22;
      if (buffer.length < length) return;
      if (buffer[0] !== 5 || buffer[1] !== 1 || ![1, 3].includes(type)) { client.destroy(); return; }
      const host = type === 3 ? buffer.subarray(5, 5 + buffer[4]).toString() : [...buffer.subarray(4, 8)].join(".");
      client.off("data", receive);
      tunnel(client, host, buffer.readUInt16BE(length - 2), buffer.subarray(length));
    };
    client.on("data", receive); client.on("error", () => undefined);
  });
  const port = await listen(proxy);
  return { originPort, scheme: certificate ? "https" : "http", proxy: `${kind}://127.0.0.1:${port}`, tunnels, requests, reject: () => { rejectConnections = true; } };
}

async function runtimeFixture(settings: DesktopProxySettings, originPort: number, resolveProxy = vi.fn(async (_url: string) => "DIRECT"), scheme = "http") {
  const directory = await mkdtemp(join(tmpdir(), "dibao-proxy-runtime-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const dist = join(directory, "apps", "server", "dist"); await mkdir(dist, { recursive: true });
  const serverDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../server/dist");
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(serverDist, name)).href);
  const common = `
    import { initializeDesktopProxy } from ${moduleUrl("desktop-proxy.js")};
    import { controlledFetchText, resolveDesktopFakeIpAddresses } from ${moduleUrl("controlled-fetch.js")};
    import { OpenAiCompatibleEmbeddingAdapter } from ${moduleUrl("embedding/openai-compatible-adapter.js")};
    initializeDesktopProxy();
    const provider={id:'fixture',type:'openai-compatible',name:'fixture',baseUrl:'${scheme}://provider.example.invalid:${originPort}/v1',model:'fixture',dimension:2,textMaxChars:100,requestsPerMinute:null,requestsPerDay:null,apiKey:'provider-test-key'};
    const probe=()=>new OpenAiCompatibleEmbeddingAdapter({timeoutMs:1200}).test(provider);
  `;
  await writeFile(join(dist, "index.js"), common + `
    import {createServer} from 'node:http';
    const server=createServer(async(request,response)=>{
      if(request.headers['x-dibao-desktop-token']!==process.env.DIBAO_DESKTOP_RUNTIME_TOKEN){response.writeHead(403);response.end();return;}
      try{
        const url=new URL(request.url,'http://localhost');
        let result;
        if(url.pathname==='/provider') result=await probe();
        else if(url.pathname==='/wrong-certificate') result=await new OpenAiCompatibleEmbeddingAdapter({timeoutMs:1200}).test({...provider,baseUrl:'${scheme}://wrong.example.invalid:${originPort}/v1'});
        else if(url.pathname==='/loopback') result=await new OpenAiCompatibleEmbeddingAdapter().test({...provider,baseUrl:'${scheme}://127.0.0.1:${originPort}/v1'});
        else if(url.pathname==='/fake-ip' || url.pathname==='/fake-private') {
          const host=url.pathname==='/fake-private'?'private.example.invalid':'feed.example.invalid';
          const fetched=await controlledFetchText('${scheme}://'+host+':${originPort}/feed.xml',{resolveHostname:hostname=>resolveDesktopFakeIpAddresses(hostname,['198.18.0.18']),timeoutMs:3000,maxBytes:100});
          result={body:fetched.body};
        }
        else if(url.pathname==='/sse') {response.writeHead(200,{'content-type':'text/event-stream'}); response.end('data: local\\n\\n');return;}
        else {
          const path=url.searchParams.get('path')??'/feed.xml';
          result=await controlledFetchText('${scheme}://feed.example.invalid:${originPort}'+path,{resolveHostname:async()=>['127.0.0.1'],allowCidrs:url.pathname==='/blocked'?[]:['127.0.0.1/32'],allowPrivateNetwork:false,timeoutMs:1000,maxBytes:100});
          result={body:result.body};
        }
        response.end(JSON.stringify({ok:true,result}));
      }catch(error){response.end(JSON.stringify({ok:false,code:error.code,name:error.name}));}
    });
    server.listen(0,'127.0.0.1',()=>process.send({type:'dibao-ready',port:server.address().port}));
    process.on('message',message=>{if(message?.type==='dibao-stop')server.close(()=>process.exit(0));});
  `);
  await writeFile(join(dist, "worker.js"), common + `
    import {writeFile} from 'node:fs/promises';
    import {dirname,join} from 'node:path';
    process.on('message',message=>{
      if(message?.type==='dibao-stop')process.exit(0);
      if(message?.type==='dibao-proxy-config') void probe().then(result=>({ok:true,result}),()=>({ok:false})).then(result=>writeFile(join(dirname(process.env.DIBAO_DATABASE_PATH),'worker-probe.json'),JSON.stringify(result)));
    });
  `);
  const failed = vi.fn();
  const runtime = new DesktopRuntime(directory, directory, join(directory, "runtime.log"), failed, process.env.DIBAO_PROXY_TEST_NODE ?? process.execPath, settings, resolveProxy);
  cleanups.push(async () => { await runtime.stop(); expect(failed).not.toHaveBeenCalled(); });
  await runtime.start();
  const api = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, { headers: { "x-dibao-desktop-token": runtime.token }, signal: AbortSignal.timeout(5000) });
    return response.json() as Promise<{ ok: boolean; code?: string; result?: { dimension?: number; body?: string } }>;
  };
  const worker = () => readFile(join(directory, "worker-probe.json"), "utf8").then(value => JSON.parse(value) as { ok: boolean; result: { dimension: number } });
  return { runtime, api, worker, resolveProxy };
}

describe("real desktop background proxy requests", () => {
  it("does not inherit environment proxies that override the explicit Desktop route", async () => {
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:9");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9");
    vi.stubEnv("NO_PROXY", "");
    const network = await networkFixture();
    const f = await runtimeFixture({ ...defaultDesktopProxySettings, mode: "manual", server: network.proxy }, network.originPort);
    expect((await f.api("/provider")).result?.dimension).toBe(2);
    expect((await f.api("/loopback")).result?.dimension).toBe(2);
    expect(network.tunnels).toEqual([`provider.example.invalid:${network.originPort}`]);
  }, 20_000);
  it("proxies Provider and worker requests without TUN, while pinned feed and local SSE remain safe", async () => {
    const network = await networkFixture();
    const settings = { ...defaultDesktopProxySettings, mode: "manual" as const, server: network.proxy };
    const f = await runtimeFixture(settings, network.originPort);
    expect((await f.api("/provider")).result?.dimension).toBe(2);
    await f.runtime.setProxySettings(settings);
    await vi.waitFor(async () => expect((await f.worker()).result?.dimension).toBe(2));
    expect((await f.api("/feed")).result?.body).toBe("<rss>proxied feed</rss>");
    expect(network.tunnels).toContain(`provider.example.invalid:${network.originPort}`);
    expect(network.tunnels).toContain(`127.0.0.1:${network.originPort}`);
    expect(network.requests.some(request => request.host === `feed.example.invalid:${network.originPort}`)).toBe(true);
    expect(network.requests.every(request => !request.desktopToken)).toBe(true);
    const count = network.tunnels.length;
    expect((await f.api("/loopback")).result?.dimension).toBe(2);
    const stream = await fetch(`http://127.0.0.1:${f.runtime.port}/sse`, { headers: { "x-dibao-desktop-token": f.runtime.token } });
    expect(await stream.text()).toContain("data: local");
    expect(network.tunnels).toHaveLength(count);
    expect((await fetch(`http://127.0.0.1:${f.runtime.port}/provider`)).status).toBe(403);
    expect((await f.api("/blocked")).code).toBe("FETCH_PRIVATE_TARGET");
    expect((await f.api("/feed?path=/large")).code).toBe("FETCH_TOO_LARGE");
    expect((await f.api("/feed?path=/slow")).code).toBe("FETCH_TIMEOUT");
    expect((await f.api("/feed?path=/redirect")).result?.body).toBe("<rss>proxied feed</rss>");
  }, 20_000);

  it("uses SOCKS5 for provider domains and DNS-pinned feed IPs", async () => {
    const network = await networkFixture("socks5");
    const f = await runtimeFixture({ ...defaultDesktopProxySettings, mode: "manual", server: network.proxy }, network.originPort);
    expect((await f.api("/provider")).result?.dimension).toBe(2);
    expect((await f.api("/feed")).result?.body).toBe("<rss>proxied feed</rss>");
    expect(network.tunnels).toEqual([`provider.example.invalid:${network.originPort}`, `127.0.0.1:${network.originPort}`]);
  }, 20_000);

  it("resolves the system proxy over private IPC, hot-applies both processes and fails closed", async () => {
    const network = await networkFixture();
    const resolveProxy = vi.fn(async (_url: string) => `PROXY ${new URL(network.proxy).host}; DIRECT`);
    const f = await runtimeFixture(defaultDesktopProxySettings, network.originPort, resolveProxy);
    expect((await f.api("/provider")).result?.dimension).toBe(2);
    expect(resolveProxy).toHaveBeenCalledWith(`http://provider.example.invalid:${network.originPort}/v1/embeddings`);
    await f.runtime.setProxySettings({ ...defaultDesktopProxySettings, mode: "direct" });
    expect((await f.api("/provider")).ok).toBe(false);
    await vi.waitFor(async () => expect((await f.worker()).ok).toBe(false));
    await f.runtime.setProxySettings({ ...defaultDesktopProxySettings, mode: "manual", server: network.proxy });
    await vi.waitFor(async () => expect((await f.worker()).result?.dimension).toBe(2));
    expect((await f.api("/provider")).result?.dimension).toBe(2);
    // Failure of the configured proxy must not disclose an API request through a direct fallback.
    network.reject();
    await f.runtime.setProxySettings({ ...defaultDesktopProxySettings, mode: "system" });
    expect((await f.api("/provider")).ok).toBe(false);
  }, 20_000);

  it("preserves HTTPS certificate validation and feed SNI over HTTP, HTTPS and SOCKS5 proxies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dibao-proxy-test-ca-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const key = join(directory, "key.pem"), cert = join(directory, "cert.pem"), config = join(directory, "openssl.cnf");
    await writeFile(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=provider.example.invalid\n[ext]\nsubjectAltName=DNS:provider.example.invalid,DNS:feed.example.invalid,DNS:cloudflare-dns.com,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", config, "-keyout", key, "-out", cert], { stdio: "ignore" });
    vi.stubEnv("NODE_EXTRA_CA_CERTS", cert);
    const certificate = { key: await readFile(key), cert: await readFile(cert) };
    for (const kind of ["http", "https", "socks5"] as const) {
      const network = await networkFixture(kind, certificate);
      const f = await runtimeFixture({ ...defaultDesktopProxySettings, mode: "manual", server: network.proxy }, network.originPort, undefined, network.scheme);
      expect((await f.api("/provider")).result?.dimension).toBe(2);
      expect((await f.api("/feed")).result?.body).toBe("<rss>proxied feed</rss>");
      expect(network.requests.find(request => request.path === "/feed.xml")?.servername).toBe("feed.example.invalid");
      expect((await f.api("/fake-ip")).result?.body).toBe("<rss>proxied feed</rss>");
      expect(network.tunnels).toContain("1.1.1.1:443");
      expect(network.tunnels).toContain(`93.184.216.34:${network.originPort}`);
      const requests = network.requests.length;
      expect((await f.api("/fake-private")).ok).toBe(false);
      expect(network.requests.length).toBe(requests + 1);
      expect((await f.api("/wrong-certificate")).ok).toBe(false);
      expect(network.requests.some(request => request.host === `wrong.example.invalid:${network.originPort}`)).toBe(false);
    }
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "");
    const network = await networkFixture("http", certificate);
    const untrusted = await runtimeFixture({ ...defaultDesktopProxySettings, mode: "manual", server: network.proxy }, network.originPort, undefined, network.scheme);
    expect((await untrusted.api("/provider")).ok).toBe(false);
    expect((await untrusted.api("/feed")).ok).toBe(false);
    expect(network.requests).toHaveLength(0);
  }, 30_000);
});
