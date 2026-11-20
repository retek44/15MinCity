import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { api, type SearchResult } from "../api/client";
import type { Strings } from "../i18n";
import { Icon } from "./Icon";

interface Props {
  t: Strings;
  near?: { lon: number; lat: number };
  onPick: (result: SearchResult) => void;
}

const RECENT_KEY = "reach15.recent";
const RECENT_MAX = 5;

/** Places picked before, newest first: a per-browser convenience, so storage may be missing. */
function readRecent(): SearchResult[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (r): r is SearchResult => typeof r?.label === "string" && Number.isFinite(r?.lon) && Number.isFinite(r?.lat),
        )
      : [];
  } catch {
    return [];
  }
}

function saveRecent(list: SearchResult[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** WAI-ARIA combobox: type, arrow through results, Enter to pick, Escape to close. */
export function SearchBox({ t, near, onPick }: Props) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState(readRecent);
  const query = useDebounced(text.trim(), 200);
  const listId = useId();

  const { data: results = [], isFetching } = useQuery({
    queryKey: ["search", query],
    queryFn: ({ signal }) => api.search(query, near, signal),
    enabled: query.length >= 2,
    staleTime: 60_000,
  });

  const pick = (result: SearchResult) => {
    setText(result.label);
    setOpen(false);
    const next = [result, ...recent.filter((r) => r.label !== result.label || r.sublabel !== result.sublabel)].slice(
      0,
      RECENT_MAX,
    );
    setRecent(next);
    saveRecent(next);
    onPick(result);
  };

  // With fewer than two letters typed, the list offers the places picked before.
  const showRecent = open && text.trim().length < 2 && recent.length > 0;
  const options = showRecent ? recent : results;
  const showList = (open && query.length >= 2) || showRecent;

  return (
    <div className="search">
      <Icon name="search" />
      <label className="visually-hidden" htmlFor={`${listId}-input`}>
        {t.searchLabel}
      </label>
      <input
        id={`${listId}-input`}
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && options[active] ? `${listId}-${active}` : undefined}
        placeholder={t.searchPlaceholder}
        value={text}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && showList && options[active]) {
            e.preventDefault();
            pick(options[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="search-results"
          aria-busy={!showRecent && isFetching}
          aria-label={showRecent ? t.recentPlaces : undefined}
        >
          {showRecent && (
            <li className="search-heading" role="presentation">
              {t.recentPlaces}
            </li>
          )}
          {!showRecent && results.length === 0 && !isFetching && <li className="search-empty">{t.noResults}</li>}
          {options.map((r, i) => (
            <li
              key={`${r.kind}-${r.label}-${r.lon}-${r.lat}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(r);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="search-label">{r.label}</span>
              {r.sublabel && <span className="search-sublabel">{r.category ? (t.categories as Record<string, string>)[r.category] ?? r.sublabel : r.sublabel}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
