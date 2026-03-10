import type { Server } from 'node:http';

export default async function globalTeardown(): Promise<void> {
  const server: Server | undefined = (<any> globalThis).__WEBSERVER__;
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()));
  });
}
