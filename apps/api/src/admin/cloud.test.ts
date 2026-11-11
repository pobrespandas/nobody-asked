import { OAuth2Client } from "google-auth-library";
import { expect, it, vi } from "vitest";
import { cloudJobs } from "./cloud.js";
import type { AdminConfig } from "./config.js";

const config: AdminConfig = {
  projectId: "demo-admin-tasks",
  databaseId: "isolated-admin-tests",
  origin: "https://admin.example.test",
  googleClientId: "test",
  googleClientSecret: "test",
  queue: "projects/demo-admin-tasks/locations/us-central1/queues/test",
  taskUrl: "https://admin.example.test/internal/admin/jobs",
  taskServiceAccount: "tasks@demo-admin-tasks.iam.gserviceaccount.com",
  ledgerBucket: "unused-test-bucket",
};
const request = (authorization?: string) =>
  new Request(config.taskUrl!, {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
it("rejects missing or non-bearer task authentication before verification", async () => {
  const verify = vi.spyOn(OAuth2Client.prototype, "verifyIdToken");
  for (const value of [undefined, "Basic synthetic"])
    await expect(
      cloudJobs(config).verifyTask(request(value)),
    ).rejects.toMatchObject({
      status: 401,
      code: "task_authentication_required",
    });
  expect(verify).not.toHaveBeenCalled();
});
it("maps an invalid task assertion to an authentication error", async () => {
  vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockRejectedValue(
    new Error("Invalid signature"),
  );
  await expect(
    cloudJobs(config).verifyTask(request("Bearer synthetic")),
  ).rejects.toMatchObject({
    status: 401,
    code: "task_authentication_required",
  });
});
it.each([
  {
    email: "other@demo-admin-tasks.iam.gserviceaccount.com",
    email_verified: true,
  },
  { email: config.taskServiceAccount, email_verified: false },
])(
  "rejects an assertion without the configured verified task identity: %j",
  async (payload) => {
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
      getPayload: () => payload,
    } as never);
    await expect(
      cloudJobs(config).verifyTask(request("Bearer synthetic")),
    ).rejects.toMatchObject({ status: 403, code: "task_identity_rejected" });
  },
);
it("verifies the assertion against the complete task URL audience", async () => {
  const verify = vi
    .spyOn(OAuth2Client.prototype, "verifyIdToken")
    .mockResolvedValue({
      getPayload: () => ({
        email: config.taskServiceAccount,
        email_verified: true,
      }),
    } as never);
  await cloudJobs(config).verifyTask(request("Bearer synthetic"));
  expect(verify).toHaveBeenCalledWith({
    idToken: "synthetic",
    audience: config.taskUrl,
  });
});
