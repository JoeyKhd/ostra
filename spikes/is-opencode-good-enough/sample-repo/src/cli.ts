import { createCalculator } from "./calculator.ts";
import { CalcError } from "./errors.ts";

const USAGE = `Usage: calc [--thousands] <expression>...

Evaluates each expression and prints the result on its own line.

Examples:
  calc "1 + 2 * 3"
  calc --thousands "1000 * 1000"`;

const args = process.argv.slice(2);
const expressions = args.filter((arg) => arg !== "--thousands");
const unknownOption = expressions.find((arg) => arg.startsWith("--") && arg !== "--help");

if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
} else if (unknownOption !== undefined) {
  console.error(`error: unknown option ${unknownOption}`);
  process.exitCode = 2;
} else if (expressions.length === 0) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  const calculator = createCalculator({ format: { thousands: args.includes("--thousands") } });
  for (const expression of expressions) {
    try {
      console.log(calculator.run(expression).text);
    } catch (error) {
      if (!(error instanceof CalcError)) throw error;
      console.error(`error: ${error.message}`);
      process.exitCode = 1;
      break;
    }
  }
}
