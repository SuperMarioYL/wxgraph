#!/usr/bin/env node
import { fileURLToPath } from "node:url";

const USAGE = `wxgraph — semantic code graph for WeChat mini-programs

Usage:
  wxgraph <command> [options]

Commands:
  build     index a mini-program into .wxgraph/graph.json
  impact    show what re-renders when a component changes
  explain   print every hop behind an edge
  search    find nodes by name
  stats     print graph counts

Run "wxgraph <command> --help" for command options.
`;

export function main(argv: string[]): number {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`wxgraph: "${command}" is not implemented yet\n`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
