import type { RunSignedIn } from "./cli/cli.ts";
import { exitCodes } from "./cli/cli.ts";

// `ostra runner` once it's signed in. The connection to the server and the task host come in
// tickets 16 and 21; until then the runner reports who it is and stops.
export const runSignedInRunner: RunSignedIn = ({ signedIn, terminal }) => {
  terminal.say(`Runner ${signedIn.identity.record.runnerId} has an access token from ${signedIn.identity.record.serverUrl}.`);
  return Promise.resolve(exitCodes.ok);
};
