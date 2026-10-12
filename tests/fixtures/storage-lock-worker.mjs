import { pathToFileURL } from 'node:url';
const { withStorageLock } = await import(pathToFileURL(process.argv[2]).href);
await withStorageLock(process.argv[3], async () => {
  process.send({ type: 'entered' });
  await new Promise(resolve => process.once('message', resolve));
});
process.disconnect();
