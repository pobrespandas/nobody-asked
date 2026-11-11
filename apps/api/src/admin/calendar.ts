// Browser filters use Argentine wall time. API timestamps keep their own offset.
export const ADMIN_TIME_ZONE = "America/Argentina/Buenos_Aires";
const localDate = new Intl.DateTimeFormat("sv-SE", {
  timeZone: ADMIN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});
export function calendarValue(value: string): string {
  if (!value) return "";
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return value;
  const parts = Object.fromEntries(
    localDate.formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
}
export function browserFilters(params: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams(params);
  for (const field of ["since", "until"]) {
    const value = result.get(field);
    if (
      value &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)
    ) {
      result.set(field, `${value}-03:00`);
    }
  }
  return result;
}
