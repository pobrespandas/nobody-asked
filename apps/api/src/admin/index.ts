import type { Firestore } from "firebase-admin/firestore";
import { AdminAuth, googleVerifier } from "./auth.js";
import { cloudJobs } from "./cloud.js";
import { readAdminConfig } from "./config.js";
import { createAdminHttp } from "./http.js";
import { AdminJobs } from "./jobs.js";
export function createHostedAdministration(
  firestore: Firestore,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const config = readAdminConfig(environment);
  if (!config)
    return async (request: Request): Promise<Response | undefined> =>
      /^\/(?:admin|v1\/admin|internal\/admin)(?:\/|$)/.test(
        new URL(request.url).pathname,
      )
        ? new Response("Administration is not enabled.", {
            status: 503,
            headers: {
              "cache-control": "private, no-store",
              "x-robots-tag": "noindex, nofollow",
            },
          })
        : undefined;
  const cloud = cloudJobs(config);
  return createAdminHttp({
    firestore,
    config,
    auth: new AdminAuth(firestore, config, googleVerifier(config)),
    jobs: new AdminJobs(firestore, cloud.objects, cloud.queue),
    verifyTask: cloud.verifyTask,
  });
}
