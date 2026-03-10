import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RequestHandler } from 'express';

const etag = require('etag');
const express = require('express');
const serveStatic = require('serve-static');

function fileEtag(path: string): Promise<string> {
  return stat(path).then(s => etag(s));
}

const app = express();

app.use(express.text({ type: '*/*', limit: '5mb' }));

let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(callBack: () => Promise<T>): Promise<T> {
  const res = lock.then(callBack, callBack);
  lock = res.catch(() => {});
  return res;
}

app.put('/test.nq', (async(req, res) => {
  await withLock(async() => {
    const incoming = req.body;
    const ifMatch = req.headers['if-match'];

    if (!ifMatch) {
      return res.status(428).send('If-Match required');
    }

    const currentEtag = await fileEtag(join(__dirname, 'test.nq'));

    if (ifMatch !== currentEtag) {
      return res
        .status(412)
        .set('ETag', currentEtag)
        .send(`Precondition Failed. Etag is ${currentEtag}`);
    }

    await writeFile(join(__dirname, 'test.nq'), incoming);

    const newEtag = await fileEtag(join(__dirname, 'test.nq'));

    return res
      .status(200)
      .set('ETag', newEtag)
      .end();
  });
}) satisfies RequestHandler);
app.use(serveStatic(__dirname));
app.listen(3000);
