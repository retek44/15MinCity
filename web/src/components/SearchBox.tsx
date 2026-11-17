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
    onPick(result);
  };

  const showList = open && query.length >= 2;

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
        aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
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
            setActive((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && results[active]) {
            e.preventDefault();
            pick(results[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {showList && (
        <ul id={listId} role="listbox" className="search-results" aria-busy={isFetching}>
          {results.length === 0 && !isFetching && <li className="search-empty">{t.noResults}</li>}
          {results.map((r, i) => (
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
