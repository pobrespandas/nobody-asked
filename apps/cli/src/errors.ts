export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError("invalid_response", "Expected a JSON object.", 5);
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new CliError("invalid_response", "Expected a non-empty string.", 5);
  return value;
}
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(credential|secret|challenge|signature|privateKey|recoveryPrivateKey|cookie|authorization)$/i.test(
              key,
            ),
        )
        .map(([key, item]) => [key, redact(item)]),
    );
  return value;
}
