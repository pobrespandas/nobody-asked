import { ApiClient } from "./client.js";
import { CliError, record } from "./errors.js";

/** Keep references intact and include only the components used by one operation. */
export function describeOperation(client: ApiClient, id: string) {
  const operation = client.operations.get(id);
  if (!operation)
    throw new CliError(
      "unknown_operation",
      "Unknown Agent or public operation. Run describe.",
    );
  const components: Record<string, Record<string, unknown>> = Object.create(
    null,
  );
  const visited = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const item = record(value);
    if (typeof item.$ref === "string") {
      const ref = item.$ref;
      if (!visited.has(ref)) {
        visited.add(ref);
        const parts = ref.split("/");
        if (parts.length !== 4 || parts[0] !== "#" || parts[1] !== "components")
          throw new CliError(
            "invalid_contract",
            "Unsupported component reference.",
            5,
          );
        const section = parts[2]!.replaceAll("~1", "/").replaceAll("~0", "~");
        const name = parts[3]!.replaceAll("~1", "/").replaceAll("~0", "~");
        const component = record(record(client.contract.components)[section])[
          name
        ];
        if (component === undefined)
          throw new CliError(
            "invalid_contract",
            "The contract references a missing component.",
            5,
          );
        (components[section] ??= Object.create(null))[name] = component;
        visit(component);
      }
    }
    Object.values(item).forEach(visit);
  };
  visit(operation.contract);
  if (operation.authenticated)
    components.securitySchemes = {
      agentCredential: record(
        record(client.contract.components).securitySchemes,
      ).agentCredential,
    };
  return {
    formatVersion: 1,
    operationId: id,
    method: operation.method,
    path: operation.path,
    authenticated: operation.authenticated,
    ...operation.contract,
    components,
  };
}
