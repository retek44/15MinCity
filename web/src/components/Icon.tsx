/** Authored line icons: 24 px grid, 2 px stroke, square caps to match the flat poster inks. */
const PATHS = {
  close: "M6 6l12 12M18 6L6 18",
  chevron: "M9 6l6 6-6 6",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L20 20",
  sun: "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  walk: "M13 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM10 21l2-6 3 3v3M8 12l2-4 4 1 2 4 2 1M12 15l-1-5",
  transit: "M7 3h10M12 3v3M5 6h14v10H5zM5 11h14M8.5 13.5h.01M15.5 13.5h.01M8 16l-2.5 5M16 16l2.5 5M7 19h10",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7",
  share: "M12 15V4M7.5 8.5L12 4l4.5 4.5M5 12v8h14v-8",
  bike: "M6 18a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM18 18a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM6 14.5l4-7h5l3 7M10 7.5L8.5 5H6.5M12.5 14.5L15 7.5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
