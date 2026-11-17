// Mitecho forge — entrypoint and lifecycle.
//
// The suite starts this process, the process binds an ephemeral port,
// registers it with the suite, serves until the suite says it is done,
// then exits. The forge itself is in ./src (store, git, REST, GraphQL,
// MCP); this file only wires the lifecycle.

import { createApp } from './src/server.ts';
import { deriveViewerLogin } from './src/scenario.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const viewerLogin = deriveViewerLogin();

const { server } = createApp({ token, viewerLogin });

server.on('error', (err) => {
  console.error(`server error: ${err.message}`);
  process.exit(1);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, payload: unknown, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function register(port: number): Promise<void> {
  let delay = 250;
  for (;;) {
    let res: Response;
    try {
      res = await postJson(`${envUrl}/register`, { port }, 5000);
    } catch (e) {
      console.error(`register failed: ${(e as Error).message}; retrying in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
      continue;
    }
    if (res.status === 200 || res.status === 409) {
      console.log(`registered on port ${port} (status ${res.status})`);
      return;
    }
    if (res.status === 400 || res.status === 405) {
      console.error(`register rejected with status ${res.status}`);
      process.exit(1);
    }
    console.error(`register returned ${res.status}; retrying in ${delay}ms`);
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function waitDone(): Promise<void> {
  let delay = 100;
  for (;;) {
    let res: Response;
    try {
      res = await getJson(`${envUrl}/done`, 30000);
      const data = (await res.json()) as { done?: boolean };
      if (data.done === true) {
        console.log('suite done; exiting');
        return;
      }
    } catch (e) {
      console.error(`done poll failed: ${(e as Error).message}`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`forge listening on port ${port} as ${viewerLogin}`);
  void (async () => {
    await register(port);
    await waitDone();
    server.close(() => process.exit(0));
    // If close hangs, exit anyway after a short grace period.
    setTimeout(() => process.exit(0), 1000).unref();
  })();
});
