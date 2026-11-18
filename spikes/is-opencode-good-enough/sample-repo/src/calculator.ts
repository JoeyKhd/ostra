import { evaluate, type Variables } from "./evaluator.ts";
import { formatNumber, type FormatOptions } from "./format.ts";
import { createHistory, type History } from "./history.ts";
import { parse } from "./parser.ts";

/** Evaluates the text of an expression. Throws a `CalcError` when it is wrong. */
export const calculate = (expression: string, variables: Variables = {}): number => evaluate(parse(expression), variables);

export type CalculatorOptions = {
  readonly historyLimit?: number;
  readonly format?: FormatOptions;
};

export type CalculationResult = {
  readonly value: number;
  /** The result as the command line prints it. */
  readonly text: string;
};

export type Calculator = {
  /** Evaluates an expression and records it in the history. A failed expression is not recorded. */
  readonly run: (expression: string) => CalculationResult;
  readonly history: History;
};

export const createCalculator = (options: CalculatorOptions = {}): Calculator => {
  const history = createHistory(options.historyLimit);
  return {
    history,
    run: (expression) => {
      const value = calculate(expression);
      history.add({ expression, result: value });
      return { value, text: formatNumber(value, options.format) };
    },
  };
};
