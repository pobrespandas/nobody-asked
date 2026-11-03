import {
  runHostedConformance,
  validateConformanceOrigin,
} from "../apps/packaged-e2e/src/hosted-conformance.js";
const input = process.argv.slice(2);
if (input.length !== 2 || input[0] !== "--base-url")
  throw new Error("Use --base-url with the explicit candidate revision URL.");
const baseUrl = validateConformanceOrigin(input[1]!);
if (!(await runHostedConformance(baseUrl, { audience: "autonomous" })))
  process.exitCode = 1;
