import { killAllTracked } from './proc.ts';
import { StubConfigSchema, startUpstreamStub } from './upstream-stub.ts';

// Child-process entry for the local upstream. Its config, fake tokens
// included, arrives on stdin as one JSON line, never in argv or the
// environment. It answers with {"port":N} on stdout.

// Reads the first line without ending stdin: the parent closing stdin later
// is this process's signal to stop.
const readLine = (): Promise<string> =>
  new Promise((resolve) => {
    let data = '';
    const onData = (chunk: Buffer): void => {
      data += chunk.toString('utf8');
      const nl = data.indexOf('\n');
      if (nl >= 0) {
        process.stdin.off('data', onData);
        resolve(data.slice(0, nl));
      }
    };
    process.stdin.on('data', onData);
  });

const main = async (): Promise<void> => {
  const config = StubConfigSchema.parse(JSON.parse(await readLine()));
  const stub = await startUpstreamStub(config);
  process.stdout.write(`${JSON.stringify({ port: stub.port })}\n`);
  const stop = (): void => {
    void stub.close().then(killAllTracked).then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.on('end', stop);
  process.stdin.resume();
};

main().catch(() => {
  process.stderr.write('upstream stub failed to start\n');
  process.exit(1);
});
