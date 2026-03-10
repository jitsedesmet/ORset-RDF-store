import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { RequestHandler } from 'express';

const etag = require('etag');
const express = require('express');

// In-memory state – never written back to disk, so test suites don't pollute each other.
let memContent = '';
let memEtag = '';

function contentEtag(content: string): string {
  return etag(Buffer.from(content));
}

async function resetFromFile(): Promise<void> {
  memContent = await readFile(join(__dirname, 'test.nq'), 'utf-8');
  memEtag = contentEtag(memContent);
}

const app = express();

app.use(express.text({ type: '*/*', limit: '5mb' }));

let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(callBack: () => Promise<T>): Promise<T> {
  const res = lock.then(callBack, callBack);
  lock = res.catch(() => {});
  return res;
}

// Serve the in-memory content for GET requests.
app.get('/test.nq', ((_req, res) => {
  res.set('ETag', memEtag).send(memContent);
}) satisfies RequestHandler);

app.put('/test.nq', (async(req, res) => {
  await withLock(async() => {
    const incoming: unknown = req.body;
    const ifMatch = req.headers['if-match'];

    if (typeof incoming !== 'string') {
      return res.status(400).send('Body must be a text string');
    }

    if (!ifMatch) {
      return res.status(428).send('If-Match required');
    }

    if (ifMatch !== memEtag) {
      return res
        .status(412)
        .set('ETag', memEtag)
        .send(`Precondition Failed. Etag is ${memEtag}`);
    }

    memContent = incoming;
    memEtag = contentEtag(memContent);

    return res
      .status(200)
      .set('ETag', memEtag)
      .end();
  });
}) satisfies RequestHandler);

// Reset the in-memory state to the original test.nq content.
// Call this in beforeAll() of any test suite that uses the web server.
app.post('/reset', (async(_req, res) => {
  try {
    await resetFromFile();
    res.status(200).end();
  } catch (error) {
    res.status(500).send(`Reset failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}) satisfies RequestHandler);

export async function startServer(port = 3000): Promise<Server> {
  await resetFromFile();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on('error', reject);
  });
}
