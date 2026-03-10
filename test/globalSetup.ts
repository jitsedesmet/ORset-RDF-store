import { startServer } from './public/webserver';

export default async function globalSetup(): Promise<void> {
  const server = await startServer(3000);
  (<any> globalThis).__WEBSERVER__ = server;
}
