import { format } from "node:util";

export function installTimestampedConsole({ now = () => new Date() } = {}) {
  const writeTimestamped = (stream, args) => {
    const timestamp = now().toISOString();
    const text = format(...args);
    const lines = String(text).split("\n");
    for (const line of lines) {
      stream.write(`[${timestamp}] ${line}\n`);
    }
  };

  console.error = (...args) => writeTimestamped(process.stderr, args);
  console.log = (...args) => writeTimestamped(process.stdout, args);
}
