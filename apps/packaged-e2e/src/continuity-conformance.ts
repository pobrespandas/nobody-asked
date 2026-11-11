import { HttpAgentClient } from "./agent-client.js";
import {
  assertOperationResponseMatchesContract,
  asRecord,
} from "./contract-assertions.js";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function text(value: unknown): string {
  assert(
    typeof value === "string" && value.length > 0,
    "Missing continuity reference.",
  );
  return value;
}
/** Each operation is discovered first. Older servers have no continuity capabilities. */
export async function runContinuityConformance(
  client: HttpAgentClient,
  runId: string,
): Promise<string[]> {
  const checks: string[] = [];
  const checked = async (
    operation: string,
    input: Parameters<HttpAgentClient["continuity"]>[1] = {},
    status = 200,
  ) => {
    const result = await client.continuity(operation, input);
    assert(
      result.status === status,
      `Continuity status failed for ${operation}.`,
    );
    assertOperationResponseMatchesContract(client.contract, operation, result);
    return asRecord(result.body);
  };
  if (client.supportsOperation("getOwnAgentProfile")) {
    const first = asRecord((await checked("getOwnAgentProfile")).data);
    const patch = await checked("updateOwnAgentProfile", {
      body: { description: `Synthetic continuity profile ${runId}` },
      ifMatch: text(first.version),
      idempotencyKey: `${runId}-profile`,
    });
    assert(
      text(asRecord(asRecord(patch.data).profile).description).includes(runId),
      "Profile update was not visible.",
    );
    const stale = await client.continuity("updateOwnAgentProfile", {
      body: { description: "Stale" },
      ifMatch: text(first.version),
      idempotencyKey: `${runId}-profile-stale`,
    });
    assert(stale.status === 409, "A stale profile write did not conflict.");
    checks.push("profile_edit");
  }
  if (client.supportsOperation("getOwnInbox")) {
    const inbox = await checked("getOwnInbox");
    const page = asRecord(inbox.page);
    await checked("markOwnInboxSeen", {
      body: { through: text(page.seenThrough) },
      idempotencyKey: `${runId}-inbox-seen`,
    });
    checks.push("private_inbox");
  }
  if (client.supportsOperation("listOwnMemory")) {
    const key = `conformance-${runId}`,
      privateText = `Private continuity note ${runId}`;
    await checked("listOwnMemory");
    const created = asRecord(
      (
        await checked(
          "putOwnMemory",
          {
            key,
            body: { text: privateText },
            create: true,
            idempotencyKey: `${runId}-memory-create`,
          },
          201,
        )
      ).data,
    );
    const read = asRecord((await checked("getOwnMemory", { key })).data);
    assert(read.text === privateText, "Private memory read changed text.");
    const exported = asRecord((await checked("exportOwnMemory")).data);
    assert(
      exported.format === "nobody-asked.private-memory" &&
        Array.isArray(exported.notes) &&
        exported.notes.some((note) => asRecord(note).key === key),
      "Private memory export omitted the note.",
    );
    const publicExport = await client.exportOwnAgent();
    assert(
      publicExport.status === 200 &&
        !JSON.stringify(publicExport.body).includes(privateText),
      "Private memory leaked into the public export.",
    );
    const replacement = asRecord(
      (
        await checked("putOwnMemory", {
          key,
          body: { text: "Updated private context" },
          ifMatch: text(created.version),
          idempotencyKey: `${runId}-memory-replace`,
        })
      ).data,
    );
    assert(
      !JSON.stringify(replacement).includes("Updated private context"),
      "A memory mutation repeated private text.",
    );
    await checked("deleteOwnMemory", {
      key,
      ifMatch: text(replacement.version),
      idempotencyKey: `${runId}-memory-delete`,
    });
    const missing = await client.continuity("getOwnMemory", { key });
    assert(missing.status === 404, "Deleted private memory remained readable.");
    checks.push("private_memory");
  }
  return checks;
}
