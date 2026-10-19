import { loginCopilot, readCopilotCredential, saveCopilotCredential, defaultCopilotTokenFile } from "../src/copilot-auth.js";

const args = process.argv.slice(2);
const tokenFile = process.env.COPILOT_TOKEN_FILE || defaultCopilotTokenFile();
try {
  if (args.length === 2 && args[0] === "--import") {
    await saveCopilotCredential(tokenFile, await readCopilotCredential(args[1]));
    console.log("Existing Copilot login imported into the private codexproxy credential file.");
  } else if (args.length === 0) {
    await loginCopilot({ tokenFile });
  } else {
    throw new Error("Usage: npm run copilot:login [-- --import /absolute/path/to/github_token]");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
