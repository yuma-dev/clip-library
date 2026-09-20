// beyond a plain input: #tag/@user syntax highlighting via a mirror overlay behind transparent input text
// autocomplete: # completes tags, @ completes people from clips' Discord calls (participants.ts)
// bare @ opens the full roster; empty roster shows the ClipDip hint

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Shuffle } from "lucide-react";
import { SHUFFLE_OPTIONS } from "../library/shuffle";
import { SYSTEM_TAGS } from "../library/filter";
import { ensureParticipants, useParticipants, type Person } from "../library/participants";
import { discordAvatarUrl } from "../ui/UserPopover";
import type { UseLibraryFilter } from "../library/useLibraryFilter";
import type { LocalClip } from "../library/types";
import logoUrl from "../../../assets/logo.png";

interface RailSearchProps {
  filter: UseLibraryFilter;
  clips: LocalClip[];
}

/** The `#tag` / `@user` token straddling the caret, if any. */
interface ActiveToken {
  kind: "#" | "@" | "?";
  /** text after the sigil, lowercased: the autocomplete needle */
  text: string;
  start: number;
  end: number;
}

const MAX_SUGGESTIONS = 8;
const EMPTY_PEOPLE_HINT =
  "Start clipping with ClipDip to see who was in a call with you when you clipped.";

function activeTokenAt(value: string, caret: number): ActiveToken | null {
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  let end = caret;
  while (end < value.length && !/\s/.test(value[end])) end++;
  const token = value.slice(start, end);
  const kind = token[0];
  if (kind === "#" || kind === "@" || kind === "?") {
    return { kind, text: token.slice(1).toLowerCase(), start, end };
  }
  return null;
}

function highlightRuns(value: string): { text: string; cls: string }[] {
  return value.split(/(\s+)/).map((run) => {
    if (/^\s+$/.test(run) || run === "") return { text: run, cls: "" };
    if (run.startsWith("?")) return { text: run, cls: "tok-shuffle" };
    if (run.startsWith("#") && run.length > 1) return { text: run, cls: "tok-tag" };
    if (run.startsWith("@") && run.length > 1) return { text: run, cls: "tok-mention" };
    return { text: run, cls: "" };
  });
}

function RailSearch({ filter, clips }: RailSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const { people, loaded } = useParticipants();

  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const query = filter.query;
  const active = useMemo(
    () => (focused ? activeTokenAt(query, caret) : null),
    [focused, query, caret],
  );
  // Don't scan every clip's Discord metadata just to focus search or shuffle.
  const needsPeople = active?.kind === "@";
  useEffect(() => {
    if (needsPeople) ensureParticipants(clips.map((c) => c.originalName));
  }, [needsPeople, clips]);

  const allTags = useMemo(
    () => [...SYSTEM_TAGS, ...filter.globalTags],
    [filter.globalTags],
  );

  const tagSuggestions = useMemo(() => {
    if (active?.kind !== "#") return [];
    const needle = active.text;
    return allTags
      .filter((t) => t.toLowerCase().includes(needle))
      .slice(0, MAX_SUGGESTIONS);
  }, [active, allTags]);

  const peopleSuggestions = useMemo(() => {
    if (active?.kind !== "@") return [];
    const needle = active.text;
    const matches = needle
      ? people.filter(
          (p) =>
            p.displayName.toLowerCase().includes(needle) ||
            p.username.toLowerCase().includes(needle),
        )
      : people;
    return matches.slice(0, MAX_SUGGESTIONS);
  }, [active, people]);

  const shuffleSuggestions = useMemo(() => {
    if (active?.kind !== "?") return [];
    const needle = active.text;
    // Completed choices still expose every alternative when clicked again.
    if (SHUFFLE_OPTIONS.some((o) => o.token === needle)) return [...SHUFFLE_OPTIONS];
    return SHUFFLE_OPTIONS.filter((o) => `${o.label} ${o.token}`.toLowerCase().includes(needle));
  }, [active]);

  // @ also opens for the empty/loading state so the ClipDip hint can show
  const showTags = active?.kind === "#" && tagSuggestions.length > 0;
  const showPeople = active?.kind === "@";
  const showShuffle = active?.kind === "?";
  const open = focused && (showTags || showPeople || showShuffle);

  const rowCount = showShuffle ? shuffleSuggestions.length : active?.kind === "#" ? tagSuggestions.length : peopleSuggestions.length;
  useEffect(() => {
    setHighlight((h) => (rowCount === 0 ? 0 : Math.min(h, rowCount - 1)));
  }, [rowCount, active?.kind, active?.text]);

  // Anchor the portaled dropdown to the input rect (the rail clips overflow).
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ left: r.left, top: r.bottom + 6, width: Math.max(r.width, 260) });
  }, [open, query, caret]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchor({ left: r.left, top: r.bottom + 6, width: Math.max(r.width, 260) });
    };
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open]);

  // Restore caret after a token insertion re-renders the input value.
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const el = inputRef.current;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    }
  }, [query]);

  const syncCaret = useCallback(() => {
    const el = inputRef.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  }, []);

  const onScroll = useCallback(() => {
    const el = inputRef.current;
    const overlay = overlayRef.current;
    if (el && overlay) overlay.scrollLeft = el.scrollLeft;
  }, []);

  const applySuggestion = useCallback(
    (value: string) => {
      if (!active) return;
      if (active.kind === "?") {
        // One shuffle choice at a time, preserving tag, person and text filters.
        const before = query.slice(0, active.start).replace(/(^|\s)\?\S*/g, "$1");
        const after = query.slice(active.end).replace(/(^|\s)\?\S*/g, "$1");
        const insert = `?${value} `;
        pendingCaret.current = before.length + insert.length;
        filter.setQuery(`${before}${insert}${after.trimStart()}`);
        return;
      }
      const insert = `${active.kind}${value}`;
      const before = query.slice(0, active.start);
      const after = query.slice(active.end);
      // Guarantee a separating space so the next token starts clean.
      const sep = after.startsWith(" ") || after === "" ? "" : " ";
      const next = `${before}${insert}${sep}${after}`;
      pendingCaret.current = before.length + insert.length + sep.length;
      filter.setQuery(next);
    },
    [active, query, filter],
  );

  const acceptHighlighted = useCallback(() => {
    if (active?.kind === "?") {
      const option = shuffleSuggestions[highlight];
      if (option) applySuggestion(option.token);
    } else if (active?.kind === "#") {
      const t = tagSuggestions[highlight];
      if (t) applySuggestion(t);
    } else if (active?.kind === "@") {
      const p = peopleSuggestions[highlight];
      // Insert the handle (no spaces) so it parses as one `@user` token.
      if (p) applySuggestion(p.username || p.displayName.replace(/\s+/g, ""));
    }
  }, [active, highlight, tagSuggestions, peopleSuggestions, shuffleSuggestions, applySuggestion]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!open) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (rowCount === 0 ? 0 : (h + 1) % rowCount));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (rowCount === 0 ? 0 : (h - 1 + rowCount) % rowCount));
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (rowCount > 0) {
          e.preventDefault();
          acceptHighlighted();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setFocused(false);
        inputRef.current?.blur();
      }
    },
    [open, rowCount, acceptHighlighted],
  );

  const runs = useMemo(() => highlightRuns(query), [query]);

  return (
    <label className="r-search" data-rail-tip="Search clips · ? to shuffle">
      <img className="r-search-logo" src={logoUrl} alt="ClipLib" draggable={false} />
      <div className="r-search-field">
        <div className="r-search-hl" ref={overlayRef} aria-hidden="true">
          {runs.map((run, i) =>
            run.cls ? (
              <span key={i} className={run.cls}>
                {run.text}
              </span>
            ) : (
              <span key={i}>{run.text}</span>
            ),
          )}
        </div>
        <input
          ref={inputRef}
          className="r-label r-search-input"
          value={query}
          spellCheck={false}
          onChange={(e) => {
            filter.setQuery(e.target.value);
            requestAnimationFrame(syncCaret);
          }}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          onFocus={() => {
            setFocused(true);
            syncCaret();
          }}
          // Suggestion mousedown preserves input focus; no stale blur timer to
          // dismiss a freshly reopened menu after rapid refocus.
          onBlur={() => setFocused(false)}
          placeholder="Search  Â·  #tag  Â·  @user"
        />
      </div>

      {filter.shuffled && filter.reshuffle ? (
        <button type="button" className="r-search-shuffle" title="Shuffle again" aria-label="Shuffle again"
          onClick={(e) => { e.preventDefault(); filter.reshuffle?.(); }}>
          <Shuffle size={15} aria-hidden="true" />
        </button>
      ) : null}

      {open && anchor
        ? createPortal(
            <div
              className="search-suggest"
              style={{ left: anchor.left, top: anchor.top, width: anchor.width }}
              // Keep focus on the input while clicking a row.
              onMouseDown={(e) => e.preventDefault()}
            >
              {active?.kind === "?" ? (
                <>
                  <div className="search-suggest-head">Shuffle · hide recent clips</div>
                  {shuffleSuggestions.map((option, i) => (
                    <button key={option.token} type="button"
                      className={`search-suggest-row${i === highlight ? " active" : ""}`}
                      onMouseEnter={() => setHighlight(i)} onClick={() => applySuggestion(option.token)}>
                      <Shuffle size={16} aria-hidden="true" />
                      <span className="search-suggest-name">{option.label}</span>
                    </button>
                  ))}
                  {shuffleSuggestions.length === 0 ? <div className="search-suggest-empty">Type ? to see shuffle options.</div> : null}
                </>
              ) : active?.kind === "#" ? (
                <TagRows
                  tags={tagSuggestions}
                  highlight={highlight}
                  onHover={setHighlight}
                  onPick={applySuggestion}
                />
              ) : peopleSuggestions.length > 0 ? (
                <PeopleRows
                  people={peopleSuggestions}
                  highlight={highlight}
                  onHover={setHighlight}
                  onPick={(p) => applySuggestion(p.username || p.displayName.replace(/\s+/g, ""))}
                />
              ) : loaded ? (
                <div className="search-suggest-empty">{EMPTY_PEOPLE_HINT}</div>
              ) : (
                <div className="search-suggest-empty muted">Loading peopleâ€¦</div>
              )}
            </div>,
            document.body,
          )
        : null}
    </label>
  );
}

function TagRows({
  tags,
  highlight,
  onHover,
  onPick,
}: {
  tags: string[];
  highlight: number;
  onHover: (i: number) => void;
  onPick: (tag: string) => void;
}) {
  return (
    <>
      <div className="search-suggest-head">Tags</div>
      {tags.map((t, i) => (
        <button
          key={t}
          type="button"
          className={`search-suggest-row${i === highlight ? " active" : ""}`}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(t)}
        >
          <span className="search-suggest-hash">#</span>
          <span className="search-suggest-name">{t}</span>
        </button>
      ))}
    </>
  );
}

function PeopleRows({
  people,
  highlight,
  onHover,
  onPick,
}: {
  people: Person[];
  highlight: number;
  onHover: (i: number) => void;
  onPick: (p: Person) => void;
}) {
  return (
    <>
      <div className="search-suggest-head">People</div>
      {people.map((p, i) => (
        <button
          key={p.id}
          type="button"
          className={`search-suggest-row${i === highlight ? " active" : ""}`}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(p)}
        >
          <img
            className="search-suggest-avatar"
            src={discordAvatarUrl(p.participant)}
            alt=""
            draggable={false}
            loading="lazy"
          />
          <span className="search-suggest-name">{p.displayName}</span>
          {p.username && p.username.toLowerCase() !== p.displayName.toLowerCase() ? (
            <span className="search-suggest-handle">@{p.username}</span>
          ) : null}
          <span className="search-suggest-count">{p.count}</span>
        </button>
      ))}
    </>
  );
}

export default memo(RailSearch);
