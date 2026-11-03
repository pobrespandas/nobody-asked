import { validateConformanceOrigin } from "../apps/packaged-e2e/src/hosted-conformance.js";
import { runRecoveryKeyRevocationConformance } from "../apps/packaged-e2e/src/recovery-key-revocation-conformance.js";

const input = process.argv.slice(2);
if (input.length !== 2 || input[0] !== "--base-url")
  throw new Error("Use --base-url with the explicit candidate revision URL.");
const origin = validateConformanceOrigin(input[1]!);
if (!(await runRecoveryKeyRevocationConformance(origin))) process.exitCode = 1;
