/**
 * "When?": the local time in Budapest the answer is for. It filters places by their opening
 * hours and sets the departure for public transport. Presets are resolved to a concrete local
 * time when chosen, so a shared link means the same moment for everyone.
 *
 *   any    no time: opening hours ignored, public transport leaves now
 *   now    the current time in Budapest
 *   wd8    the next weekday at 08:00 (a commute)
 *   su20   the next Sunday at 20:00 (most shops closed)
 *   YYYY-MM-DDTHH:MM  a custom time
 */
export type WhenPreset = "any" | "now" | "wd8" | "su20";
export type When = WhenPreset | string;

export const PRESETS: WhenPreset[] = ["any", "now", "wd8", "su20"];
const CUSTOM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export const isWhen = (value: string): value is When => (PRESETS as string[]).includes(value) || CUSTOM.test(value);

/** Wall-clock parts of a moment in Budapest. */
function budapest(now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Budapest",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const isoDay = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday!) + 1;
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hh: Number(parts.hour), mm: Number(parts.minute), isoDay };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Calendar date arithmetic on a local date (no time zone involved). */
function addDays(y: number, m: number, d: number, days: number) {
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** The next local time at hh:00 on one of the ISO weekdays (today counts if it is still ahead). */
function next(now: Date, weekdays: number[], hour: number): string {
  const b = budapest(now);
  for (let ahead = 0; ahead < 8; ahead++) {
    const isoDay = ((b.isoDay - 1 + ahead) % 7) + 1;
    if (!weekdays.includes(isoDay)) continue;
    if (ahead === 0 && b.hh * 60 + b.mm >= hour * 60) continue;
    return `${addDays(b.y, b.m, b.d, ahead)}T${pad(hour)}:00`;
  }
  throw new Error("unreachable");
}

/** The `at` parameter for the API, or undefined for "any time". */
export function resolveWhen(when: When, now: Date = new Date()): string | undefined {
  switch (when) {
    case "any":
      return undefined;
    case "now": {
      const b = budapest(now);
      return `${b.y}-${pad(b.m)}-${pad(b.d)}T${pad(b.hh)}:${pad(b.mm)}`;
    }
    case "wd8":
      return next(now, [1, 2, 3, 4, 5], 8);
    case "su20":
      return next(now, [7], 20);
    default:
      return CUSTOM.test(when) ? when : undefined;
  }
}

/** "Tue 08:00" in the UI language. */
export function formatAt(at: string, lang: string): string {
  const [date, time] = at.split("T");
  const [y, m, d] = date!.split("-").map(Number);
  const weekday = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(lang, { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${time!.slice(0, 5)}`;
}
